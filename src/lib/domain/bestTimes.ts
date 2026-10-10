import type { ClubAvailability, ClubFreeSlot } from "@/db/schema";
import { isValidTimeZone, utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";

/**
 * The best times to play: free courts ranked for a person or a crew.
 *
 * The owner's choice of 10 October 2026, "Best times + one-tap booking by a player": the free times a
 * club shares or a platform shows publicly, cached on the club's row by the hourly job
 * (`clubs.availability`, `src/lib/booking/availability.ts`), offered where people decide when to play
 * (the create form, /play, the crew's Telegram group), best first. A free court at a usual club at a
 * usual time comes first, then the soonest. One time per club and day, so three chips are three
 * choices and not three hours in a row at one club.
 *
 * Pure, and safe in a browser: the create form runs it on the feed it was handed. No database, no
 * clock of its own, no fetch (rule 12: the hourly job reads the feeds; a request reads the cache).
 * `freeFeedOf` is the one reader of that cache. A player books and pays in the club's own app;
 * Kicksmash never signs in as a player and never pays (DECIDING rule 34).
 */
const HOUR_MS = 3600_000;
const MINUTE_MS = 60_000;

export const BEST_TIMES = {
  /** "This week": seven days from now, as far as the cached feed speaks. */
  horizonMs: 7 * 24 * HOUR_MS,
  /** Closer than this, four people cannot get there (the free court offer's own lead). */
  minLeadMs: 2 * HOUR_MS,
  /** A feed read longer ago than this may have lost its courts to bookings since; the job reads hourly. */
  freshMs: 3 * HOUR_MS,
  /** A usual time is a usual weekday within this many minutes of the hour the person plays. */
  nearMinutes: 60,
  /** What a screen shows by default: three chips, three rows, three buttons. */
  limit: 3,
  /** The most slots one club's feed hands on, whatever it held. */
  maxSlots: 200,
} as const;

/** One club's free courts for the week ahead, as a request or a browser may read them. */
export type FreeFeed = {
  tz: string;
  fetchedAt: string;
  /** The feed speaks up to this instant and no further: a time past it is unknown, never "free". */
  until: string;
  /** Free courts in time order, each ending after "now" and starting before `until`. */
  slots: ClubFreeSlot[];
};

/** A usual weekday and time: 0 = Sunday, "19:00" in the zone the person plays in. */
export type TimePattern = { dow: number; time: string };

export type BestTimesClub = { slug: string; name: string; feed: FreeFeed | null; /** The person or crew plays here. */ usual?: boolean };

export type BestTime = {
  slug: string;
  name: string;
  tz: string;
  start: Date;
  /** The club's own day and hour, as a form or a button needs them. */
  date: string;
  time: string;
  /** Courts free for the whole length (the fewest across the hours it spans). */
  free: number;
  /** A usual club at a usual time. */
  usual: boolean;
};

const addDays = (date: string, days: number) => new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + days)).toISOString().slice(0, 10);
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/**
 * The one reader of a club's cached free times: what every screen of the best times reads, so the
 * cache can change shape in one place. A feed a screen may use, or null: read in the last three hours,
 * without an error, in a zone we know, from any source (a club's own feed, or a platform's public
 * times, `source: "scrape:<platform>"`). `slots` may hold today only (a club's feed as the hourly job
 * reads it) or several days: the feed speaks from now to the end of the last local day it holds (at
 * least its own `day`), and never past seven days. Bounded, sorted, and clipped to what it speaks for.
 */
export function freeFeedOf(a: ClubAvailability | null | undefined, now: Date): FreeFeed | null {
  if (!a || a.error || !isValidTimeZone(a.tz)) return null;
  const fetched = new Date(a.fetchedAt).getTime();
  if (!Number.isFinite(fetched) || now.getTime() - fetched > BEST_TIMES.freshMs) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.day) || !Array.isArray(a.slots)) return null;
  const read = a.slots.filter((s) => {
    const start = new Date(s?.start).getTime();
    const end = new Date(s?.end).getTime();
    return Number.isFinite(start) && Number.isFinite(end) && end > start;
  });
  // A day the feed lists, even fully booked, is a day it speaks for; the day after its last is not.
  const lastDay = read.reduce((d, s) => {
    const day = utcToZonedParts(new Date(s.start), a.tz).date;
    return day > d ? day : d;
  }, a.day);
  const covered = zonedTimeToUtc(addDays(lastDay, 1), "00:00", a.tz).getTime();
  const until = Math.min(covered, now.getTime() + BEST_TIMES.horizonMs);
  const slots = read
    .filter((s) => s.free >= 1 && new Date(s.end).getTime() > now.getTime() && new Date(s.start).getTime() < until)
    .sort((x, y) => new Date(x.start).getTime() - new Date(y.start).getTime())
    .slice(0, BEST_TIMES.maxSlots)
    .map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), free: Math.min(64, Math.trunc(s.free)) }));
  return { tz: a.tz, fetchedAt: a.fetchedAt, until: new Date(until).toISOString(), slots };
}

/**
 * The fewest courts free from `start` for `minutes`, walking slots that follow one another without a
 * gap; 0 when any minute of it has no free court. `slots` is in time order. Pure.
 */
function freeThrough(slots: readonly ClubFreeSlot[], start: number, minutes: number): number {
  const end = start + minutes * MINUTE_MS;
  let at = start;
  let fewest = Infinity;
  for (const s of slots) {
    const a = new Date(s.start).getTime();
    const b = new Date(s.end).getTime();
    if (b <= at) continue;
    if (a > at) return 0;
    fewest = Math.min(fewest, s.free);
    at = b;
    if (at >= end) return fewest === Infinity ? 0 : fewest;
  }
  return 0;
}

/**
 * Does the club show a free court from `start` for `minutes`? "unknown" when the feed does not speak
 * for that time (none, gone, past what it covers): a screen then says nothing rather than guess. Pure.
 */
export function freeAt(feed: FreeFeed | null | undefined, start: Date, minutes: number, now: Date): "free" | "busy" | "unknown" {
  if (!feed) return "unknown";
  const t = start.getTime();
  if (!Number.isFinite(t) || t < now.getTime() || t + minutes * MINUTE_MS > new Date(feed.until).getTime()) return "unknown";
  return freeThrough(feed.slots, t, minutes) >= 1 ? "free" : "busy";
}

/** How far, in minutes, a club's hour sits from the nearest usual time on its weekday; Infinity when none. */
function distanceToUsual(date: string, time: string, patterns: readonly TimePattern[]): number {
  const dow = weekdayOf(date);
  const m = minutesOf(time);
  let best = Infinity;
  for (const p of patterns) if (p.dow === dow && /^\d{2}:\d{2}$/.test(p.time)) best = Math.min(best, Math.abs(minutesOf(p.time) - m));
  return best;
}

/**
 * The best few times in the next seven days, at the clubs given, for a match of `lengthMinutes`:
 * a free court for the whole length, at least two hours away, inside what each feed speaks for.
 * Ranked: a usual club at a usual time first (a usual weekday, within the hour), then the soonest.
 * One time per club and local day; on a day with several, the one nearest the usual time, else the
 * earliest. At most `limit`. Pure.
 */
export function bestTimes(input: { clubs: readonly BestTimesClub[]; patterns: readonly TimePattern[]; lengthMinutes: number; now: Date; limit?: number }): BestTime[] {
  const limit = input.limit ?? BEST_TIMES.limit;
  const from = input.now.getTime() + BEST_TIMES.minLeadMs;
  const to = input.now.getTime() + BEST_TIMES.horizonMs;
  type Candidate = BestTime & { tier: number; distance: number };
  const bestOfDay = new Map<string, Candidate>();
  for (const club of input.clubs) {
    const feed = club.feed;
    if (!feed) continue;
    const until = Math.min(to, new Date(feed.until).getTime());
    for (const s of feed.slots) {
      const start = new Date(s.start).getTime();
      if (start < from || start + input.lengthMinutes * MINUTE_MS > until) continue;
      const free = freeThrough(feed.slots, start, input.lengthMinutes);
      if (free < 1) continue;
      const { date, time } = utcToZonedParts(new Date(start), feed.tz);
      const distance = distanceToUsual(date, time, input.patterns);
      const usual = Boolean(club.usual) && distance <= BEST_TIMES.nearMinutes;
      const c: Candidate = { slug: club.slug, name: club.name, tz: feed.tz, start: new Date(start), date, time, free, usual, tier: usual ? 0 : 1, distance: usual ? distance : Infinity };
      const key = `${club.slug}|${date}`;
      const held = bestOfDay.get(key);
      if (!held || c.tier < held.tier || (c.tier === held.tier && (c.distance < held.distance || (c.distance === held.distance && start < held.start.getTime())))) bestOfDay.set(key, c);
    }
  }
  return [...bestOfDay.values()]
    .sort((a, b) => a.tier - b.tier || a.start.getTime() - b.start.getTime() || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit))
    .map(({ tier: _tier, distance: _distance, ...b }) => b);
}
