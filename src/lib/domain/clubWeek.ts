import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { clubSlots, clubs, events, players, slots, type Club, type ClubSlot, type Event, type TournamentFormat } from "@/db/schema";
import { MATCH_CAPACITY } from "@/lib/config";
import { utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";
import { DomainError } from "./errors";
import { createEvent } from "./events";
import { formatOf } from "./formats";
import { weeklyDue } from "./groups";
import { hasRange, normalizeRange } from "./levels";
import { withCounts, type BoardEvent } from "./venueBoard";

/**
 * The club programme: a week the club fills once. Every slot becomes a public
 * match on the club's page a few days ahead; players sign up and pull out
 * themselves; the club never approves anyone and never types a roster. Staff
 * open the day view in the morning and see how the day will run.
 */
/** A weekly slot looks one occurrence ahead, so a lead longer than a week would change nothing: seven is the ceiling. */
export const CLUB_WEEK = { slotsPerClub: 40, leadDaysDefault: 6, leadDaysMax: 7 } as const;
const DAY = 86_400_000;

export type SlotInput = {
  dow: number;
  time: string;
  type?: "match" | "tournament";
  format?: TournamentFormat | null;
  capacity?: number;
  courts?: number | null;
  levelMin?: unknown;
  levelMax?: unknown;
  /** The matches take confirmed levels only (needs a range). */
  verifiedOnly?: boolean;
  title?: string | null;
  leadDays?: number;
  whenFull?: "waitlist" | "closed";
  cost?: string | null;
};

export function cleanSlotInput(i: SlotInput) {
  const dow = Math.floor(Number(i.dow));
  if (!(dow >= 0 && dow <= 6)) throw new DomainError("invalid", "dow");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(i.time ?? "")) throw new DomainError("invalid", "time");
  const type = i.type === "tournament" ? "tournament" : "match";
  const format = type === "tournament" ? formatOf(i.format ?? null) : null;
  // A match is four people, whatever was typed: the event it becomes has exactly four seats.
  const capacity = type === "match" ? MATCH_CAPACITY : Math.round(Number(i.capacity ?? 8));
  if (!(capacity >= 4 && capacity <= 64 && capacity % 4 === 0)) throw new DomainError("invalid", "capacity");
  const range = normalizeRange(i.levelMin, i.levelMax);
  const leadDays = Math.min(CLUB_WEEK.leadDaysMax, Math.max(1, Math.round(Number(i.leadDays ?? CLUB_WEEK.leadDaysDefault)) || CLUB_WEEK.leadDaysDefault));
  const courts = type === "tournament" && i.courts != null && Number.isFinite(Number(i.courts)) ? Math.max(1, Math.min(16, Math.round(Number(i.courts)))) : null;
  return {
    dow,
    time: i.time,
    type,
    format,
    capacity,
    courts,
    levelMin: range.min,
    levelMax: range.max,
    verifiedOnly: Boolean(i.verifiedOnly) && hasRange(range),
    title: (i.title ?? "").trim().slice(0, 80) || null,
    leadDays,
    whenFull: i.whenFull === "closed" ? ("closed" as const) : ("waitlist" as const),
    cost: (i.cost ?? "").trim().slice(0, 40) || null,
  };
}

export async function listClubSlots(db: Db, clubSlug: string): Promise<ClubSlot[]> {
  return db.select().from(clubSlots).where(eq(clubSlots.clubSlug, clubSlug)).orderBy(asc(clubSlots.dow), asc(clubSlots.time));
}

export async function addClubSlot(db: Db, clubSlug: string, input: SlotInput): Promise<ClubSlot> {
  const clean = cleanSlotInput(input);
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(clubSlots).where(eq(clubSlots.clubSlug, clubSlug));
  if (Number(n) >= CLUB_WEEK.slotsPerClub) throw new DomainError("invalid", "slots");
  const [row] = await db.insert(clubSlots).values({ clubSlug, ...clean }).returning();
  return row;
}

/** Pausing keeps the slot; moving it forgets what was already created so the new time is honoured. */
export async function updateClubSlot(db: Db, clubSlug: string, id: string, patch: Partial<SlotInput> & { active?: boolean }): Promise<ClubSlot | null> {
  const [cur] = await db.select().from(clubSlots).where(and(eq(clubSlots.id, id), eq(clubSlots.clubSlug, clubSlug))).limit(1);
  if (!cur) return null;
  const merged = cleanSlotInput({ dow: cur.dow, time: cur.time, type: cur.type as "match" | "tournament", format: cur.format as TournamentFormat | null, capacity: cur.capacity, courts: cur.courts, levelMin: cur.levelMin, levelMax: cur.levelMax, verifiedOnly: cur.verifiedOnly, title: cur.title, leadDays: cur.leadDays, whenFull: cur.whenFull as "waitlist" | "closed", cost: cur.cost, ...patch });
  const moved = merged.dow !== cur.dow || merged.time !== cur.time;
  const [row] = await db
    .update(clubSlots)
    .set({ ...merged, active: patch.active ?? cur.active, ...(moved ? { lastCreatedFor: null } : {}) })
    .where(eq(clubSlots.id, id))
    .returning();
  return row ?? null;
}

export async function removeClubSlot(db: Db, clubSlug: string, id: string): Promise<boolean> {
  const rows = await db.delete(clubSlots).where(and(eq(clubSlots.id, id), eq(clubSlots.clubSlug, clubSlug))).returning({ id: clubSlots.id });
  return rows.length > 0;
}

/** Would the hourly job create this slot's next match now? Pure. */
export function slotDue(slot: Pick<ClubSlot, "dow" | "time" | "leadDays" | "lastCreatedFor" | "active">, tz: string, now = new Date()): Date | null {
  if (!slot.active) return null;
  return weeklyDue({ dow: slot.dow, time: slot.time, tz, leadDays: slot.leadDays, lastCreatedFor: slot.lastCreatedFor }, now);
}

export type ClubCreated = { club: Club; slot: ClubSlot; event: Event };

/**
 * Hourly: every live club's due slots become public matches on its board,
 * organised by the person who claimed the club. Each slot is its own unit:
 * the slot is claimed for that start first, inside one transaction with the
 * match, so a stalled run or an overlapping one never doubles a night, and one
 * slot's failure is reported without stopping the rest.
 */
export async function autoCreateClubEvents(db: Db, now = new Date()): Promise<{ created: ClubCreated[]; errors: string[] }> {
  const rows = await db
    .select({ slot: clubSlots, club: clubs })
    .from(clubSlots)
    .innerJoin(clubs, eq(clubs.slug, clubSlots.clubSlug))
    .where(and(eq(clubSlots.active, true), isNotNull(clubs.approvedAt), isNull(clubs.rejectedAt), isNotNull(clubs.claimedBy), isNotNull(clubs.tz)))
    .orderBy(asc(clubSlots.createdAt));
  const created: ClubCreated[] = [];
  const errors: string[] = [];
  for (const { slot, club } of rows) {
    const startsAt = slotDue(slot, club.tz!, now);
    if (!startsAt) continue;
    try {
      const event = await db.transaction(async (tx) => {
        const claimed = await tx
          .update(clubSlots)
          .set({ lastCreatedFor: startsAt })
          .where(and(eq(clubSlots.id, slot.id), or(isNull(clubSlots.lastCreatedFor), lt(clubSlots.lastCreatedFor, startsAt))))
          .returning({ id: clubSlots.id });
        if (claimed.length === 0) return null;
        const ev = await createEvent(tx, {
          creatorPlayerId: club.claimedBy!,
          type: slot.type as "match" | "tournament",
          title: slot.title,
          startsAt,
          tz: club.tz!,
          venueName: club.name,
          venueMapUrl: club.mapUrl,
          capacity: slot.capacity,
          whenFull: slot.whenFull as "waitlist" | "closed",
          courts: slot.courts,
          format: slot.format as TournamentFormat | null,
          levelMin: slot.levelMin,
          levelMax: slot.levelMax,
          levelVerifiedOnly: slot.verifiedOnly,
          publicListing: true,
          bookingUrl: club.bookingUrl,
          cost: slot.cost,
        });
        await tx.update(events).set({ clubSlotId: slot.id }).where(eq(events.id, ev.id));
        return { ...ev, clubSlotId: slot.id };
      });
      if (event) created.push({ club, slot, event });
    } catch (e) {
      errors.push(`${club.slug} ${slot.dow}/${slot.time}: ${String(e)}`);
    }
  }
  return { created, errors };
}

export type WeekDay = { date: string; events: BoardEvent[] };

/** The local date `n` days after a local date, through noon so a DST day cannot shift it. */
const localDateAfter = (date: string, n: number, tz: string) => utcToZonedParts(new Date(zonedTimeToUtc(date, "12:00", tz).getTime() + n * DAY), tz).date;

/**
 * The club's next days as players see them: every listed match at the club,
 * grouped by local date, counts included. Players see what is still to come
 * (`from: "now"`); staff see the whole day (`from: "midnight"`). The window
 * ends at a local midnight, so a 23- or 25-hour day is whole.
 */
export async function clubWeek(db: Db, club: Pick<Club, "slug" | "tz">, now = new Date(), days = 7, o: { from?: "now" | "midnight" } = {}): Promise<WeekDay[]> {
  const tz = club.tz ?? "UTC";
  const today = utcToZonedParts(now, tz).date;
  const dayStart = zonedTimeToUtc(today, "00:00", tz);
  const from = o.from === "midnight" ? dayStart : now;
  const to = zonedTimeToUtc(localDateAfter(today, days, tz), "00:00", tz);
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.venueSlug, club.slug), eq(events.publicListing, true), gte(events.startsAt, from), lt(events.startsAt, to), sql`${events.status} <> 'cancelled'`))
    .orderBy(asc(events.startsAt));
  const counted = await withCounts(db, rows);
  const byDate = new Map<string, BoardEvent[]>();
  for (const b of counted) {
    const d = utcToZonedParts(b.event.startsAt, tz).date;
    byDate.set(d, [...(byDate.get(d) ?? []), b]);
  }
  return Array.from({ length: days }, (_, i) => {
    const date = localDateAfter(today, i, tz);
    return { date, events: byDate.get(date) ?? [] };
  });
}

export type DayEvent = BoardEvent & { names: string[]; waiting: number };

/** Staff view: the whole day's matches with who is in and who is waiting. Two reads for the day, however many matches (rule 8). */
export async function clubDay(db: Db, club: Pick<Club, "slug" | "tz">, now = new Date()): Promise<{ date: string; events: DayEvent[] }> {
  const [day] = await clubWeek(db, club, now, 1, { from: "midnight" });
  if (day.events.length === 0) return { date: day.date, events: [] };
  const seats = await db
    .select({ eventId: slots.eventId, position: slots.position, invitedName: slots.invitedName, displayName: players.displayName })
    .from(slots)
    .leftJoin(players, eq(players.id, slots.playerId))
    .where(and(inArray(slots.eventId, day.events.map((b) => b.event.id)), inArray(slots.status, ["joined", "confirmed"])))
    .orderBy(asc(slots.eventId), asc(slots.position));
  const out: DayEvent[] = day.events.map((b) => {
    const mine = seats.filter((s) => s.eventId === b.event.id);
    return { ...b, names: mine.filter((s) => s.position <= b.event.capacity).map((s) => s.displayName ?? s.invitedName ?? "?"), waiting: mine.filter((s) => s.position > b.event.capacity).length };
  });
  return { date: day.date, events: out };
}

/** The next match created from each slot (the editor shows it next to the slot). */
export async function upcomingBySlot(db: Db, clubSlug: string, now = new Date()): Promise<Map<string, Event>> {
  const rows = await db
    .select({ e: events })
    .from(events)
    .innerJoin(clubSlots, eq(clubSlots.id, events.clubSlotId))
    .where(and(eq(clubSlots.clubSlug, clubSlug), gte(events.startsAt, now), sql`${events.status} <> 'cancelled'`))
    .orderBy(asc(events.startsAt));
  const map = new Map<string, Event>();
  for (const { e } of rows) if (e.clubSlotId && !map.has(e.clubSlotId)) map.set(e.clubSlotId, e);
  return map;
}
