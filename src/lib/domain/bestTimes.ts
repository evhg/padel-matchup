import type { ClubAvailability, ClubFreeSlot } from "@/db/schema";
import { platformById } from "@/lib/booking/platforms";
import { isValidTimeZone, utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";

/**
 * The best times to play: free courts ranked for a person or a crew.
 *
 * The owner's choice of 10 October 2026, "Best times + one-tap booking by a player": the free times a
 * club shares (read hourly, `src/lib/booking/availability.ts`) or a platform shows publicly (read
 * every 15 minutes, `src/lib/booking/scrape.ts`, DECIDING rule 35), cached on the club's row
 * (`clubs.availability`), offered where people decide when to play
 * (the create form, /play, the crew's Telegram group), best first. A free court at a usual club at a
 * usual time comes first, then the soonest. One time per club and day, so three chips are three
 * choices and not three hours in a row at one club.
 *
 * Pure, and safe in a browser: the create form runs it on the feed it was handed. No database, no
 * clock of its own, no fetch (rule 12: the hourly job reads the feeds; a request reads the cache).
 * `freeFeedOf` is the one reader of that cache. A player books and pays in the club's own app;
 * Kicksmash never signs in as a player and never pays (DECIDING rule 36).
 */
const HOUR_MS = 3600_000;
const MINUTE_MS = 60_000;
const STEP_MS = 30 * MINUTE_MS;

export const BEST_TIMES = {
  /** At most seven days from now, and never past the end of the sixth day after today: one weekday never shows twice. */
  horizonMs: 7 * 24 * HOUR_MS,
  /** Closer than this, four people cannot get there (the free court offer's own lead). */
  minLeadMs: 2 * HOUR_MS,
  /** A club's own feed read longer ago than this may have lost its courts to bookings since; the job reads it hourly. */
  freshMs: 3 * HOUR_MS,
  /** A platform's read is shown this long and no longer, here as on the club page (`SCRAPE_SHOWN_MS`, which a test keeps equal). */
  platformShownMs: 2 * HOUR_MS,
  /** A read stamped further ahead than this is a clock gone wrong, not a fresh read. */
  skewMs: 5 * MINUTE_MS,
  /** A usual time is a usual weekday within this many minutes of the hour the person plays. */
  nearMinutes: 60,
  /** What a screen shows by default: three chips, three rows, three buttons. */
  limit: 3,
  /** The most free stretches one club's feed hands on, whatever it held. */
  maxSlots: 200,
} as const;

/**
 * One club's free courts as a request or a browser may read them: stretches in time order that never
 * overlap, each with the courts free through all of it.
 */
export type FreeFeed = {
  tz: string;
  fetchedAt: string;
  /** The feed speaks up to this instant and no further: a time past it is unknown, never "free". */
  until: string;
  slots: ClubFreeSlot[];
  /** The platform whose public page these times were read from ("Playtomic"); null for the club's own feed. */
  platform: string | null;
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
  /** Courts free for the whole length (the fewest across the stretches it spans). */
  free: number;
  /** A usual club at a usual time. */
  usual: boolean;
  /** Whose times these are: the platform's name, or null for the club's own feed (DECIDING rule 35 names the platform). */
  platform: string | null;
};

const addDays = (date: string, days: number) => new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + days)).toISOString().slice(0, 10);
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Parsed once: epochs, so the ranking never parses a date inside its loops. */
type Piece = { a: number; b: number; free: number };

/**
 * The slots as stretches that never overlap, in time order: where two slots overlap, the later one
 * counts only from where the earlier ends (a per-court feed of ten courts at 18:00 reads as one
 * stretch, never as ten), and touching stretches with the same count become one.
 */
function piecesOf(slots: readonly { a: number; b: number; free: number }[]): Piece[] {
  const sorted = [...slots].sort((x, y) => x.a - y.a || x.b - y.b);
  const out: Piece[] = [];
  let cursor = -Infinity;
  for (const s of sorted) {
    if (s.b <= cursor) continue;
    const a = Math.max(s.a, cursor);
    const last = out[out.length - 1];
    if (last && last.b === a && last.free === s.free) last.b = s.b;
    else out.push({ a, b: s.b, free: s.free });
    cursor = s.b;
  }
  return out;
}

/** Read within `maxAgeMs` of now, and not stamped further ahead than clock skew allows. */
const readWithin = (at: string | null | undefined, now: Date, maxAgeMs: number) => {
  const t = new Date(at ?? "").getTime();
  return Number.isFinite(t) && now.getTime() - t <= maxAgeMs && t - now.getTime() <= BEST_TIMES.skewMs;
};
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The one reader of a club's cached free times: what every screen of the best times reads, so the
 * cache can change shape in one place. A feed a screen may use, or null: clean, in a zone we know, and
 * fresh (not stamped in the future either). Which cache wins for a club, its own feed or a platform's
 * read, is decided before this (`freeCourtsState`); this reads the one it is handed.
 *
 * - A club's own feed (`ics_bookings`, `json_free`) holds today, read hourly: fresh for three hours,
 *   and it speaks from now to the end of the last local day it holds (at least its own `day`).
 * - A platform's read (`source: "scrape:<platform>"`) is shown for two hours, as on the club page. It
 *   covers `days` (today first); today is as fresh as the last read (`fetchedAt`), and the later days
 *   only as fresh as the last read of them all (`fullAt`). It speaks to the end of the last day it
 *   covered, so a day booked solid reads "busy", not "unknown".
 *
 * Either way never past the end of the sixth day after today (one weekday never shows twice), and
 * never past a stretch it had to leave out for room.
 */
export function freeFeedOf(a: ClubAvailability | null | undefined, now: Date): FreeFeed | null {
  if (!a || a.error || !isValidTimeZone(a.tz)) return null;
  const scraped = typeof a.source === "string" && a.source.startsWith("scrape:");
  if (!readWithin(a.fetchedAt, now, scraped ? BEST_TIMES.platformShownMs : BEST_TIMES.freshMs)) return null;
  if (!DAY_RE.test(a.day) || !Array.isArray(a.slots)) return null;
  const read = a.slots.flatMap((s) => {
    const start = new Date(s?.start).getTime();
    const end = new Date(s?.end).getTime();
    const free = Number(s?.free);
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? [{ a: start, b: end, free: Number.isFinite(free) ? Math.min(64, Math.trunc(free)) : 0 }] : [];
  });
  const today = utcToZonedParts(now, a.tz).date;
  const days = scraped && Array.isArray(a.days) ? a.days.filter((d) => typeof d === "string" && DAY_RE.test(d)) : null;
  // A platform's read speaks for the days it read: all of them while the full read is fresh, else the
  // day of its last read alone. A club's feed for every day it lists, even fully booked.
  const lastDay = days
    ? readWithin(a.fullAt, now, BEST_TIMES.platformShownMs)
      ? days.reduce((d, x) => (x > d ? x : d), a.day)
      : a.day
    : read.reduce((d, s) => {
        const day = utcToZonedParts(new Date(s.a), a.tz).date;
        return day > d ? day : d;
      }, a.day);
  if (lastDay < today) return null;
  let until = Math.min(zonedTimeToUtc(addDays(lastDay, 1), "00:00", a.tz).getTime(), now.getTime() + BEST_TIMES.horizonMs, zonedTimeToUtc(addDays(today, 7), "00:00", a.tz).getTime());
  const pieces = piecesOf(read.filter((s) => s.free >= 1)).filter((p) => p.b > now.getTime() && p.a < until);
  // Room for so many stretches and no more: the feed then speaks only up to the first one left out,
  // so a court it could not keep never reads as "no free court".
  if (pieces.length > BEST_TIMES.maxSlots) until = Math.min(until, pieces[BEST_TIMES.maxSlots].a);
  const slots = pieces.slice(0, BEST_TIMES.maxSlots).map((p) => ({ start: new Date(p.a).toISOString(), end: new Date(p.b).toISOString(), free: p.free }));
  const platformId = scraped ? (a.platform ?? a.source.slice("scrape:".length)) : null;
  return { tz: a.tz, fetchedAt: a.fetchedAt, until: new Date(until).toISOString(), slots, platform: platformId ? (platformById(platformId)?.name ?? platformId) : null };
}

/** The feed's stretches as epochs, once. */
const parsed = (feed: FreeFeed): Piece[] => feed.slots.map((s) => ({ a: new Date(s.start).getTime(), b: new Date(s.end).getTime(), free: s.free }));

/** The first stretch ending after `t` (stretches never overlap, so their ends are in order). */
function firstEndingAfter(pieces: readonly Piece[], t: number): number {
  let lo = 0;
  let hi = pieces.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pieces[mid].b <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The fewest courts free from `t` for `ms`, over stretches that follow one another without a gap; 0 when any minute has none. */
function freeThrough(pieces: readonly Piece[], t: number, ms: number): number {
  const end = t + ms;
  let at = t;
  let fewest = Infinity;
  for (let i = firstEndingAfter(pieces, t); i < pieces.length; i++) {
    const p = pieces[i];
    if (p.a > at) return 0;
    fewest = Math.min(fewest, p.free);
    at = p.b;
    if (at >= end) return fewest;
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
  return freeThrough(parsed(feed), t, minutes * MINUTE_MS) >= 1 ? "free" : "busy";
}

/**
 * The line under the time on the create form: what the club shows for the day, hour and zone the form
 * holds, and the club's own hour when the form's zone is not the club's ("18:00" in Madrid is 23:00 in
 * Bangkok, and the club's feed speaks in Bangkok's hours). Pure.
 */
export type FreeLine = { state: "free" | "busy" | "unknown"; clubTime: string | null; platform: string | null };
export function freeLineOf(feed: FreeFeed | null | undefined, when: { date: string; time: string; tz: string }, minutes: number, now: Date): FreeLine {
  if (!feed || !when.date || !when.time || !isValidTimeZone(when.tz)) return { state: "unknown", clubTime: null, platform: null };
  const at = zonedTimeToUtc(when.date, when.time, when.tz);
  const state = freeAt(feed, at, minutes, now);
  return { state, clubTime: state === "unknown" || when.tz === feed.tz ? null : utcToZonedParts(at, feed.tz).time, platform: feed.platform ?? null };
}

/**
 * The words of that line, as a message key and its values: the platform named when the times are a
 * platform's (DECIDING rule 35: we read them; the club did not publish them), "the club" when they are
 * its own feed; the club's hour when the form's zone is not the club's. Null when there is nothing to say.
 */
export function freeLineMessage(line: FreeLine):
  | { key: "create.freeThen" | "create.busyThen"; values: Record<string, never> }
  | { key: "create.freeThenClub" | "create.busyThenClub"; values: { time: string } }
  | { key: "create.freeThenOn" | "create.busyThenOn"; values: { platform: string } }
  | { key: "create.freeThenOnClub" | "create.busyThenOnClub"; values: { platform: string; time: string } }
  | null {
  if (line.state === "unknown") return null;
  const free = line.state === "free";
  if (line.platform && line.clubTime) return { key: free ? "create.freeThenOnClub" : "create.busyThenOnClub", values: { platform: line.platform, time: line.clubTime } };
  if (line.platform) return { key: free ? "create.freeThenOn" : "create.busyThenOn", values: { platform: line.platform } };
  if (line.clubTime) return { key: free ? "create.freeThenClub" : "create.busyThenClub", values: { time: line.clubTime } };
  return { key: free ? "create.freeThen" : "create.busyThen", values: {} };
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
 * The times worth trying at one club: inside every free stretch, its start or the first half hour two
 * hours out, then every half hour after it; and each usual time that falls inside a stretch, so a long
 * free afternoon still offers "Thu 19:00" when that is when the crew plays. In time order. Pure.
 */
function candidatesOf(pieces: readonly Piece[], from: number, last: number, feedTz: string, patterns: readonly TimePattern[], now: Date): number[] {
  const out = new Set<number>();
  for (const p of pieces) {
    let t = p.a >= from ? p.a : p.a + Math.ceil((from - p.a) / STEP_MS) * STEP_MS;
    for (; t < p.b && t <= last; t += STEP_MS) out.add(t);
  }
  if (patterns.length) {
    const today = utcToZonedParts(now, feedTz).date;
    for (let d = 0; d < 7; d++) {
      const date = addDays(today, d);
      const dow = weekdayOf(date);
      for (const pat of patterns) {
        if (pat.dow !== dow || !/^\d{2}:\d{2}$/.test(pat.time)) continue;
        const t = zonedTimeToUtc(date, pat.time, feedTz).getTime();
        if (t >= from && t <= last) out.add(t);
      }
    }
  }
  return [...out].sort((x, y) => x - y);
}

/**
 * The best few times in the next seven days, at the clubs given, for a match of `lengthMinutes`:
 * a free court for the whole length, at least two hours away, inside what each feed speaks for.
 * Ranked: a usual club at a usual time first (a usual weekday, within the hour), then the soonest.
 * One time per club and local day; on a day with several, the one nearest the usual time, else the
 * earliest. At most `limit`. Each club costs one pass over its stretches and its candidates. Pure.
 */
export function bestTimes(input: { clubs: readonly BestTimesClub[]; patterns: readonly TimePattern[]; lengthMinutes: number; now: Date; limit?: number }): BestTime[] {
  const limit = input.limit ?? BEST_TIMES.limit;
  const length = input.lengthMinutes * MINUTE_MS;
  const from = input.now.getTime() + BEST_TIMES.minLeadMs;
  const to = input.now.getTime() + BEST_TIMES.horizonMs;
  type Candidate = BestTime & { tier: number; distance: number };
  const bestOfDay = new Map<string, Candidate>();
  for (const club of input.clubs) {
    const feed = club.feed;
    if (!feed) continue;
    const pieces = parsed(feed);
    const last = Math.min(to, new Date(feed.until).getTime()) - length;
    for (const start of candidatesOf(pieces, from, last, feed.tz, input.patterns, input.now)) {
      const free = freeThrough(pieces, start, length);
      if (free < 1) continue;
      const { date, time } = utcToZonedParts(new Date(start), feed.tz);
      const distance = distanceToUsual(date, time, input.patterns);
      const usual = Boolean(club.usual) && distance <= BEST_TIMES.nearMinutes;
      const c: Candidate = { slug: club.slug, name: club.name, tz: feed.tz, start: new Date(start), date, time, free, usual, platform: feed.platform ?? null, tier: usual ? 0 : 1, distance: usual ? distance : Infinity };
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

/**
 * One row of time chips (rule 1): the club's free times first, then the person's usual times that
 * are not already there, up to `max`. A usual time stays offered even when the club shows it taken,
 * because the person may have booked it themselves; the line under the time says what the club shows.
 */
export function timeChipsOf<T extends { date: string; time: string }>(free: readonly T[], usual: readonly T[], max = 4): (T & { free: boolean })[] {
  const out: (T & { free: boolean })[] = free.slice(0, max).map((c) => ({ ...c, free: true }));
  for (const c of usual) {
    if (out.length >= max) break;
    if (!out.some((o) => o.date === c.date && o.time === c.time)) out.push({ ...c, free: false });
  }
  return out;
}

/**
 * The dates in a row of chips whose weekday another date in the row has too: "Sat 08:00" beside
 * "Sat 15:00" reads as one day when one is next week's, so those chips name the day and month. Pure.
 */
export function datesSharingAWeekday(row: readonly { date: string }[]): Set<string> {
  const byDow = new Map<number, Set<string>>();
  for (const { date } of row) byDow.set(weekdayOf(date), (byDow.get(weekdayOf(date)) ?? new Set()).add(date));
  return new Set([...byDow.values()].filter((d) => d.size > 1).flatMap((d) => [...d]));
}
