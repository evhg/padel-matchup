import { and, asc, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, series, slots, type Event, type Series, type SeriesRhythm } from "@/db/schema";
import { nextOccurrence, timePatternOf, wallClock, zonedTimeToUtc } from "@/lib/dates";
import { bumpMetric } from "./metrics";
import { venueInCity, type City } from "./cities";
import { createEvent, cleanText, isRosterSlot, isOccupied, resolveCapacity } from "./events";
import { DomainError } from "./errors";
import { venueSlug } from "./venueBoard";

/**
 * A series is an Open that repeats. The organizer of a finished tournament
 * sets the rhythm once (same weekday and time, every week, fortnight or
 * month); the next edition exists at once, the rest make themselves from the
 * hourly job a few days ahead, list themselves on the series page and the
 * city page, and close themselves like any tournament. The organizer never
 * types a date or a roster again. Rule 22.
 */

export const SERIES = {
  perOrganizer: 5,
  /** The next edition appears this many days ahead, by rhythm. */
  leadDays: { week: 6, fortnight: 10, month: 21 } as Record<SeriesRhythm, number>,
  pastShown: 12,
  nameMax: 60,
} as const;

const DAY = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDate = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;
const dayNumber = (dateStr: string) => Math.round(Date.UTC(Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1, Number(dateStr.slice(8, 10))) / DAY);
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export type Rhythm = Pick<Series, "dow" | "time" | "every" | "nth" | "tz" | "anchorAt">;

/** Which weekday of its month an instant is, in `tz`: 1–4, or 5 for "the last one". */
export function nthWeekdayOf(at: Date, tz: string): number {
  const w = wallClock(at, tz);
  const n = Math.ceil(w.day / 7);
  const last = w.day + 7 > daysInMonth(w.year, w.month);
  return n >= 4 && last ? 5 : Math.min(n, 4);
}

/** The date (in `tz`) of the nth weekday `dow` of month `m` of year `y`; nth 5 = the last one. */
function nthWeekdayDate(y: number, m: number, dow: number, nth: number): string {
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const first = 1 + ((dow - firstDow + 7) % 7);
  const dim = daysInMonth(y, m);
  if (nth >= 5) {
    let d = first;
    while (d + 7 <= dim) d += 7;
    return isoDate(y, m, d);
  }
  const d = first + (nth - 1) * 7;
  return isoDate(y, m, Math.min(d, dim));
}

/** The first edition start strictly after `after` (at least half an hour ahead), on the series' rhythm. Pure. */
export function nextEditionAt(s: Rhythm, after: Date): Date {
  if (s.every === "month") {
    const w = wallClock(after, s.tz);
    for (let i = 0; i < 4; i++) {
      const m0 = w.month - 1 + i;
      const y = w.year + Math.floor(m0 / 12);
      const m = (m0 % 12) + 1;
      const at = zonedTimeToUtc(nthWeekdayDate(y, m, s.dow, s.nth ?? nthWeekdayOf(s.anchorAt, s.tz)), s.time, s.tz);
      if (at.getTime() >= after.getTime() + 30 * 60_000) return at;
    }
  }
  const next = nextOccurrence(s.dow, s.time, s.tz, after);
  if (s.every === "fortnight") {
    const anchorDate = wallClock(s.anchorAt, s.tz);
    const gap = dayNumber(next.date) - dayNumber(isoDate(anchorDate.year, anchorDate.month, anchorDate.day));
    if (((gap % 14) + 14) % 14 !== 0) {
      const d = new Date(Date.UTC(Number(next.date.slice(0, 4)), Number(next.date.slice(5, 7)) - 1, Number(next.date.slice(8, 10)) + 7));
      return zonedTimeToUtc(isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), s.time, s.tz);
    }
  }
  return zonedTimeToUtc(next.date, next.time, s.tz);
}

/** Would the hourly job create the next edition now? Pure. */
export function seriesDue(s: Rhythm & Pick<Series, "active" | "leadDays" | "lastCreatedFor">, now = new Date()): Date | null {
  if (!s.active) return null;
  const next = nextEditionAt(s, now);
  if (next.getTime() - s.leadDays * DAY > now.getTime()) return null;
  if (s.lastCreatedFor && s.lastCreatedFor.getTime() >= next.getTime()) return null;
  return next;
}

export const isRhythm = (v: unknown): v is SeriesRhythm => v === "week" || v === "fortnight" || v === "month";

const slugBase = (name: string) => venueSlug(name)?.slice(0, 48) ?? "open";

async function freeSlug(db: Db, name: string): Promise<string> {
  const base = slugBase(name);
  const taken = new Set((await db.select({ slug: series.slug }).from(series).where(sql`${series.slug} = ${base} or ${series.slug} like ${base + "-%"}`)).map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  throw new DomainError("invalid", "slug");
}

/** One edition from the template: a public tournament by the organizer, on the series. */
export async function createEdition(db: Db, s: Series, startsAt: Date): Promise<Event> {
  const event = await createEvent(db, {
    creatorPlayerId: s.organizerPlayerId,
    type: "tournament",
    title: s.name,
    startsAt,
    tz: s.tz,
    venueName: s.venueName,
    venueMapUrl: s.venueMapUrl,
    capacity: s.capacity,
    whenFull: s.whenFull as "waitlist" | "closed",
    courts: s.courts,
    format: s.format,
    levelMin: s.levelMin,
    levelMax: s.levelMax,
    levelVerifiedOnly: s.levelVerifiedOnly,
    publicListing: true,
    bookingUrl: s.bookingUrl,
    cost: s.cost,
  });
  await db.update(events).set({ seriesId: s.id, pointsPerMatch: s.pointsPerMatch, courtNames: s.courtNames }).where(eq(events.id, event.id));
  await db.update(series).set({ lastCreatedFor: startsAt, updatedAt: new Date() }).where(eq(series.id, s.id));
  await bumpMetric(db, "series_editions");
  return { ...event, seriesId: s.id, pointsPerMatch: s.pointsPerMatch, courtNames: s.courtNames };
}

/** Hourly: every active series whose next edition is within its lead days gets it, once. */
export async function autoCreateSeriesEditions(db: Db, now = new Date()): Promise<{ series: Series; event: Event }[]> {
  const rows = await db.select().from(series).where(eq(series.active, true)).orderBy(asc(series.createdAt));
  const out: { series: Series; event: Event }[] = [];
  for (const s of rows) {
    const startsAt = seriesDue(s, now);
    if (!startsAt) continue;
    out.push({ series: s, event: await createEdition(db, s, startsAt) });
  }
  return out;
}

export type CreateSeriesInput = { eventId: string; organizerPlayerId: string; name: string; every: SeriesRhythm; capacity?: number; now?: Date };

/** The door on a finished tournament: the organizer names the series and picks the rhythm; the next edition exists before the page reloads. */
export async function createSeriesFromEvent(db: Db, input: CreateSeriesInput): Promise<{ series: Series; next: Event }> {
  const now = input.now ?? new Date();
  const name = cleanText(input.name, SERIES.nameMax);
  if (!name || name.length < 2) throw new DomainError("invalid", "name");
  if (!isRhythm(input.every)) throw new DomainError("invalid", "every");
  const [ev] = await db.select().from(events).where(eq(events.id, input.eventId)).limit(1);
  if (!ev) throw new DomainError("not_found", "event");
  if (ev.creatorPlayerId !== input.organizerPlayerId) throw new DomainError("forbidden", "organizer");
  if (ev.type !== "tournament") throw new DomainError("invalid", "not_a_tournament");
  if (ev.seriesId) throw new DomainError("invalid", "already_a_series");
  const [{ n }] = await db.select({ n: count() }).from(series).where(and(eq(series.organizerPlayerId, input.organizerPlayerId), eq(series.active, true)));
  if (Number(n) >= SERIES.perOrganizer) throw new DomainError("invalid", "too_many");
  const { dow, time } = timePatternOf(ev.startsAt, ev.tz);
  const [s] = await db
    .insert(series)
    .values({
      slug: await freeSlug(db, name),
      name,
      organizerPlayerId: input.organizerPlayerId,
      tz: ev.tz,
      venueName: ev.venueName,
      venueMapUrl: ev.venueMapUrl,
      venueSlug: ev.venueSlug,
      format: ev.format ?? "americano",
      // The field the organizer wants, not the size the last edition shrank to.
      capacity: resolveCapacity("tournament", input.capacity ?? ev.capacity),
      courts: input.capacity && input.capacity !== ev.capacity ? null : ev.courts,
      pointsPerMatch: ev.pointsPerMatch,
      courtNames: ev.courtNames,
      levelMin: ev.levelMin,
      levelMax: ev.levelMax,
      levelVerifiedOnly: ev.levelVerifiedOnly,
      whenFull: ev.whenFull,
      cost: ev.cost,
      bookingUrl: ev.bookingUrl,
      dow,
      time,
      every: input.every,
      nth: input.every === "month" ? nthWeekdayOf(ev.startsAt, ev.tz) : null,
      anchorAt: ev.startsAt,
      leadDays: SERIES.leadDays[input.every],
    })
    .returning();
  await db.update(events).set({ seriesId: s.id }).where(eq(events.id, ev.id));
  const next = await createEdition(db, s, nextEditionAt(s, new Date(Math.max(now.getTime(), ev.startsAt.getTime()))));
  await bumpMetric(db, "series_created");
  return { series: { ...s, lastCreatedFor: next.startsAt }, next };
}

export async function getSeries(db: Db, slug: string): Promise<Series | null> {
  const [s] = await db.select().from(series).where(eq(series.slug, slug)).limit(1);
  return s ?? null;
}

/** The next edition of a series after `now`, if one exists. */
export async function nextEdition(db: Db, seriesId: string, now = new Date()): Promise<Event | null> {
  const [e] = await db
    .select()
    .from(events)
    .where(and(eq(events.seriesId, seriesId), gt(events.startsAt, now), sql`${events.status} <> 'cancelled'`))
    .orderBy(asc(events.startsAt))
    .limit(1);
  return e ?? null;
}

export async function seriesOfEvent(db: Db, ev: Pick<Event, "seriesId">): Promise<Series | null> {
  if (!ev.seriesId) return null;
  const [s] = await db.select().from(series).where(eq(series.id, ev.seriesId)).limit(1);
  return s ?? null;
}

/** The organizer pauses or resumes: paused, no edition is made; the page stays, with the past. */
export async function setSeriesActive(db: Db, input: { slug: string; organizerPlayerId: string; active: boolean }): Promise<Series> {
  const s = await getSeries(db, input.slug);
  if (!s) throw new DomainError("not_found", "series");
  if (s.organizerPlayerId !== input.organizerPlayerId) throw new DomainError("forbidden", "organizer");
  const [updated] = await db.update(series).set({ active: input.active, updatedAt: new Date() }).where(eq(series.id, s.id)).returning();
  return updated;
}

export type Podium = { playerId: string; name: string; rank: number }[];
export type Edition = { event: Event; spotsLeft: number; podium: Podium };
export type SeriesPage = { series: Series; organizerName: string; next: Edition | null; past: Edition[]; editions: number };

async function editionsWithDetail(db: Db, rows: Event[]): Promise<Edition[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((e) => e.id);
  const seats = await db.select({ eventId: slots.eventId, position: slots.position, status: slots.status }).from(slots).where(inArray(slots.eventId, ids));
  const podiumIds = [...new Set(rows.flatMap((e) => (e.standings ?? []).slice(0, 3)))];
  const named = podiumIds.length ? await db.select({ id: players.id, name: players.displayName }).from(players).where(inArray(players.id, podiumIds)) : [];
  const nameOf = new Map(named.map((p) => [p.id, p.name]));
  return rows.map((event) => {
    const taken = seats.filter((s) => s.eventId === event.id && isOccupied(s) && isRosterSlot(s, event.capacity)).length;
    const podium = (event.standings ?? []).slice(0, 3).map((playerId, i) => ({ playerId, name: nameOf.get(playerId) ?? "?", rank: i + 1 }));
    return { event, spotsLeft: Math.max(0, event.capacity - taken), podium };
  });
}

/** Everything the series page shows: the next edition, the past ones with their podiums. */
export async function seriesPage(db: Db, s: Series, now = new Date()): Promise<SeriesPage> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.seriesId, s.id), sql`${events.status} <> 'cancelled'`))
    .orderBy(desc(events.startsAt))
    .limit(SERIES.pastShown + 3);
  const [organizer] = await db.select({ name: players.displayName }).from(players).where(eq(players.id, s.organizerPlayerId)).limit(1);
  const upcoming = rows.filter((e) => e.startsAt > now && e.status !== "past").sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const past = rows.filter((e) => !(e.startsAt > now && e.status !== "past")).slice(0, SERIES.pastShown);
  const [next] = await editionsWithDetail(db, upcoming.slice(0, 1));
  const [{ n }] = await db.select({ n: count() }).from(events).where(and(eq(events.seriesId, s.id), sql`${events.status} <> 'cancelled'`));
  return { series: s, organizerName: organizer?.name ?? "", next: next ?? null, past: await editionsWithDetail(db, past), editions: Number(n) };
}

export type SeriesListing = { series: Series; next: Event | null };

/** Active series, optionally those in one city, each with its next edition. */
export async function listSeries(db: Db, city: City | null = null, now = new Date()): Promise<SeriesListing[]> {
  const rows = await db.select().from(series).where(eq(series.active, true)).orderBy(asc(series.createdAt)).limit(200);
  const inCity = city ? rows.filter((s) => venueInCity(city, s.venueSlug, s.tz)) : rows;
  if (inCity.length === 0) return [];
  const upcoming = await db
    .select()
    .from(events)
    .where(and(inArray(events.seriesId, inCity.map((s) => s.id)), gt(events.startsAt, now), sql`${events.status} <> 'cancelled'`))
    .orderBy(asc(events.startsAt));
  const nextOf = new Map<string, Event>();
  for (const e of upcoming) if (e.seriesId && !nextOf.has(e.seriesId)) nextOf.set(e.seriesId, e);
  return inCity.map((s) => ({ series: s, next: nextOf.get(s.id) ?? null })).sort((a, b) => (a.next?.startsAt.getTime() ?? Infinity) - (b.next?.startsAt.getTime() ?? Infinity));
}

/** The organizer's own series, for My matches. */
export async function seriesByOrganizer(db: Db, playerId: string): Promise<Series[]> {
  return db.select().from(series).where(eq(series.organizerPlayerId, playerId)).orderBy(asc(series.createdAt));
}
