/**
 * How long a match lasts, and so when it is over.
 *
 * Erik asked on 25 September 2026, from his match page: "is the game 60min or 90min? I can't tell.
 * The calendar invite sent out is 2h I think, but I think the booking app shows 90min". He was right:
 * every event ended two hours after its start, whatever the court booking said, and nothing on the
 * page said how long it was. The owner decided on 30 September 2026: the organiser picks 60, 90 or
 * 120 minutes, and 90 is the default. The match page, the cards and the calendar invitation all say
 * the same length, and everything that asks "is it over?" asks it here.
 *
 * A tournament has the same three lengths and starts at 120, which is the two hours every event had
 * until now: an americano of eight is rarely shorter, and nothing about a tournament changed that day.
 * The serious tournament (`competitions`) is not an event and keeps its own court schedule.
 *
 * Pure, and a leaf: the create form imports it, so it must not reach the database.
 */

/** The only lengths there are, in minutes. Three taps on the form, never a typed number. */
export const MATCH_LENGTHS = [60, 90, 120] as const;
export type MatchLength = (typeof MATCH_LENGTHS)[number];

/** A match nobody chose a length for. */
export const DEFAULT_MATCH_LENGTH: MatchLength = 90;
/** A tournament nobody chose a length for: the two hours every event had before lengths existed. */
export const DEFAULT_TOURNAMENT_LENGTH: MatchLength = 120;
/** The shortest and the longest: bounds for a query that must find every event over by now, whatever its length. */
export const SHORTEST_LENGTH: MatchLength = 60;
export const LONGEST_LENGTH: MatchLength = 120;

const MINUTE_MS = 60_000;

/**
 * A length from a form, a request or a button: 60, 90 or 120, as a number or its digits; anything
 * else is null. Null means "not one of ours", and the caller refuses it — a typed 75 is not rounded
 * to 90, because an organiser who asked for 75 should hear no, not find 90 on the page.
 */
export function parseMatchLength(v: unknown): MatchLength | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d{2,3}\s*$/.test(v) ? Number(v) : NaN;
  return (MATCH_LENGTHS as readonly number[]).includes(n) ? (n as MatchLength) : null;
}

/** The length an event gets when nobody said. */
export const defaultLength = (type: "match" | "tournament"): MatchLength => (type === "tournament" ? DEFAULT_TOURNAMENT_LENGTH : DEFAULT_MATCH_LENGTH);

type Timed = { startsAt: Date; durationMinutes: number };

/** The event's length in milliseconds, as stored. */
export const durationMs = (ev: Pick<Timed, "durationMinutes">): number => ev.durationMinutes * MINUTE_MS;

/** The moment the event ends: its start plus its length. Every reader of "when is it over" asks this. */
export const eventEnd = (ev: Timed): Date => new Date(ev.startsAt.getTime() + durationMs(ev));

/** Over at `now`: the end has come. The end itself counts as over, as it always did. */
export const isOver = (ev: Timed, now: Date): boolean => eventEnd(ev).getTime() <= now.getTime();
