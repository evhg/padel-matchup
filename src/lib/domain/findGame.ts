import { and, asc, eq, gt, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, slots, type Event } from "@/db/schema";
import { wallClock, zonedTimeToUtc } from "@/lib/dates";
import { CITIES, cityBySlug, venueInCity, type City } from "./cities";
import { levelFit } from "./levels";
import { fillOf, isValidVenueSlug, type Fill } from "./venueBoard";

/**
 * /play: the open games a visitor can join, one city at a time. The owner's decision of 9 October
 * 2026 (option C): a "Find a game" chip on the landing page now, opening this list; a strip of games
 * above the form comes later, once a city holds three or more open games.
 *
 * A game is what the city page and the venue board already show: a match or a social tournament its
 * organiser listed (`public_listing`), with a venue, not cancelled, not started. The filters are
 * chips kept in the URL, so a filtered list is a link a person can send. Everything that decides is
 * pure and unit-tested here; the one read is `findGames`, bounded and on the start-time index.
 */

export const PLAY_DAYS = ["today", "tomorrow", "week"] as const;
export type PlayDay = (typeof PLAY_DAYS)[number];

export type PlayFilters = {
  /** A city slug from `CITIES`. */
  city: string;
  day: PlayDay;
  /** Only games whose level range takes the viewer's level. Ignored for a viewer with no level. */
  fits: boolean;
  /** A venue slug, or null for every club in the city. */
  club: string | null;
  /** Hide the full ones. A full match can still have a waiting list, so they show by default. */
  spots: boolean;
};

/** The most rows one list reads. A city's week is a few dozen games today; this is the ceiling, not the plan (rule 12). */
export const PLAY_LIMIT = 120;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * The city a visitor meets first, from what the edge says about them. The edge's city name wins
 * when it names one of ours; a zone that is a whole city (Singapore) is enough on its own; anything
 * else is Phuket, where nearly every game is. Bangkok's zone alone never says Phuket, so it falls
 * to the default rather than to a guess. There is no city cookie yet: the chips keep the choice in
 * the URL. Pure.
 */
export function homeCity(edge: { city?: string | null; tz?: string | null }): City {
  const name = (edge.city ?? "").trim().toLowerCase();
  return CITIES.find((c) => name !== "" && c.name.toLowerCase() === name) ?? CITIES.find((c) => c.tz === edge.tz && c.needles.length === 0) ?? cityBySlug("phuket")!;
}

/** The filters a /play URL asks for. Anything unknown falls back to the default rather than to an error. Pure. */
export function parsePlayFilters(sp: Record<string, string | string[] | undefined>, fallbackCity: string): PlayFilters {
  const city = one(sp.city);
  const day = one(sp.day);
  const club = one(sp.club);
  return {
    city: cityBySlug(city) ? city : fallbackCity,
    day: (PLAY_DAYS as readonly string[]).includes(day) ? (day as PlayDay) : "week",
    fits: one(sp.fits) === "1",
    club: club && isValidVenueSlug(club) ? club : null,
    spots: one(sp.spots) === "1",
  };
}

/**
 * The address of the list with some filters changed. A club belongs to its city, so another city
 * drops the club. Defaults stay out of the URL, except the city, which a shared link must carry.
 * Pure.
 */
export function playHref(f: PlayFilters, patch: Partial<PlayFilters> = {}): string {
  const n = { ...f, ...patch };
  if (patch.city && patch.city !== f.city && patch.club === undefined) n.club = null;
  const q = new URLSearchParams({ city: n.city });
  if (n.day !== "week") q.set("day", n.day);
  if (n.club) q.set("club", n.club);
  if (n.fits) q.set("fits", "1");
  if (n.spots) q.set("spots", "1");
  return `/play?${q}`;
}

/** Midnight at the start of the local day `plusDays` after `now`'s, in `tz`, as an instant. */
function dayStart(now: Date, tz: string, plusDays: number): Date {
  const w = wallClock(now, tz);
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + plusDays));
  return zonedTimeToUtc(d.toISOString().slice(0, 10), "00:00", tz);
}

/**
 * The stretch of time a day chip means, in the city's own zone: today is now until midnight,
 * tomorrow is the whole of tomorrow, and this week is now until the end of the sixth day after
 * today (seven days, not the calendar week, so Sunday evening still shows a week). Pure.
 */
export function playWindow(day: PlayDay, now: Date, tz: string): { from: Date; to: Date } {
  if (day === "today") return { from: now, to: dayStart(now, tz, 1) };
  if (day === "tomorrow") return { from: dayStart(now, tz, 1), to: dayStart(now, tz, 2) };
  return { from: now, to: dayStart(now, tz, 7) };
}

/** What a game row needs for the filters to decide on it. */
export type GameFacts = { startsAt: Date; venueSlug: string | null; levelMin: number | null; levelMax: number | null; spotsLeft: number };

/**
 * The games the chips let through: inside the day's window, at the chosen club, with a spot left
 * when asked, and inside the viewer's level when asked and the viewer has one. An open game (no
 * range) fits every level. Pure.
 */
export function filterGames<R extends GameFacts>(rows: readonly R[], f: Pick<PlayFilters, "club" | "fits" | "spots">, window: { from: Date; to: Date }, level: number | null | undefined): R[] {
  return rows.filter(
    (r) =>
      r.startsAt >= window.from &&
      r.startsAt < window.to &&
      (!f.club || r.venueSlug === f.club) &&
      (!f.spots || r.spotsLeft > 0) &&
      (!f.fits || level == null || levelFit({ min: r.levelMin, max: r.levelMax }, level) === "ok"),
  );
}

/** The clubs behind a list, once each, by name: the club chips. Read before the club filter, so the chips stay while one is picked. Pure. */
export function clubsOf(rows: readonly { venueSlug: string | null; venueName: string | null }[]): { slug: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const r of rows) if (r.venueSlug && r.venueName && !seen.has(r.venueSlug)) seen.set(r.venueSlug, r.venueName);
  return [...seen.entries()].map(([slug, name]) => ({ slug, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every city /play serves, as one list in the reader's language ("Phuket and Singapore", "Phuket и
 * Singapore"), for the page's description. Read from `CITIES`, so a third city needs no copy change. Pure.
 */
export function playCities(locale: string): string {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(CITIES.map((c) => c.name));
}

/** "Anna Maria" → "Anna". The organiser on a public row is a first name only (rule 6). */
export const firstNameOf = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0]?.slice(0, 24) || "";

export type GameRow = Pick<Event, "id" | "code" | "type" | "title" | "startsAt" | "tz" | "venueName" | "venueSlug" | "capacity" | "levelMin" | "levelMax" | "cost" | "format"> & {
  organiser: string;
  occupied: number;
  spotsLeft: number;
  fill: Fill;
};

/**
 * The same place test as `venueInCity`, in the query, so another city's games in the same zone
 * (Bangkok shares Phuket's) never take the rows the limit leaves. The needles are our own
 * lowercase slug fragments, so the pattern is plain alternation.
 */
function inCity(city: City): SQL | undefined {
  if (city.needles.length === 0) return undefined;
  const byNeedle = sql`${events.venueSlug} ~ ${city.needles.join("|")}`;
  return city.venueSlugs.length > 0 ? or(byNeedle, inArray(events.venueSlug, [...city.venueSlugs])) : byNeedle;
}

/**
 * The listed games in a city inside a window, soonest first, with their seats and the organiser's
 * first name. One query: the seat counts are two subqueries over `slots` on its (event, position)
 * index, the organiser a join on the primary key, and the range rides `events_starts_at_idx`.
 * At most `PLAY_LIMIT` rows, whatever the city holds (rule 12).
 */
export async function findGames(db: Db, city: City, window: { from: Date; to: Date }, now = new Date()): Promise<GameRow[]> {
  const from = window.from > now ? window.from : now;
  const rows = await db
    .select({
      id: events.id,
      code: events.code,
      type: events.type,
      title: events.title,
      startsAt: events.startsAt,
      tz: events.tz,
      venueName: events.venueName,
      venueSlug: events.venueSlug,
      capacity: events.capacity,
      levelMin: events.levelMin,
      levelMax: events.levelMax,
      cost: events.cost,
      format: events.format,
      organiserName: players.displayName,
      // A seat inside the capacity is occupied when joined or confirmed and open when empty or
      // declined; a reserved seat is neither. The same counting as `withCounts`, inside this read.
      occupied: sql<number>`(select count(*) from ${slots} s where s.event_id = ${events.id} and s.position <= ${events.capacity} and s.status in ('joined', 'confirmed'))`,
      open: sql<number>`(select count(*) from ${slots} s where s.event_id = ${events.id} and s.position <= ${events.capacity} and s.status in ('empty', 'declined'))`,
    })
    .from(events)
    .innerJoin(players, eq(players.id, events.creatorPlayerId))
    .where(and(eq(events.tz, city.tz), eq(events.publicListing, true), inArray(events.status, ["open", "full"]), isNotNull(events.venueSlug), gt(events.startsAt, from), lt(events.startsAt, window.to), inCity(city)))
    .orderBy(asc(events.startsAt))
    .limit(PLAY_LIMIT);
  return rows
    .filter((r) => venueInCity(city, r.venueSlug, r.tz))
    .map(({ organiserName, occupied, open, ...r }) => {
      const counts = { occupied: Number(occupied), spotsLeft: Number(open) };
      return { ...r, organiser: firstNameOf(organiserName), ...counts, fill: fillOf({ event: r, ...counts }) };
    });
}
