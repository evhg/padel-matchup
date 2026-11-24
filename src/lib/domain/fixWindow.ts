import type { Event } from "@/db/schema";
import { eventEnd } from "./matchLength";

/**
 * The line-up of a played match can be put right (the owner, 24 November 2026): "the organiser can put
 * a name in an open place, change a held name, and put held players in the pairs, for up to 7 days after
 * the match. [...] if there is an open place, any player can add themselves if still open even after the
 * match. [...] any player needs to be able to change any player, and the new player can replace an
 * existing player with him or herself. [...] Of course this is only for matches, not for tournaments."
 *
 * Pure, and a leaf: the match page, the score save (`saveMatchScore`) and the writes (`lineupFix.ts`)
 * ask the same two questions here: is the window open, and what may this person do in it.
 */
export const FIX_DAYS = 7;

type Fixable = Pick<Event, "type" | "status" | "startsAt" | "durationMinutes">;

/** The last moment the line-up can be changed: seven days after the match's own end. */
export const fixUntil = (ev: Pick<Event, "startsAt" | "durationMinutes">): Date => new Date(eventEnd(ev).getTime() + FIX_DAYS * 24 * 3600_000);

export type FixRefusal = "not_a_match" | "cancelled" | "not_started" | "past";

/**
 * Why this line-up cannot be changed by the window's rules now, or null while it can: a match (never a
 * tournament, an americano or a competition, whose line-up only the organiser runs), not called off,
 * from its start to `fixUntil`. Before the start the line-up has its usual rules (join, leave, the
 * organiser's held places), so the window opens at the start.
 */
export function fixRefusal(ev: Fixable, now: Date): FixRefusal | null {
  if (ev.type !== "match") return "not_a_match";
  if (ev.status === "cancelled") return "cancelled";
  if (now.getTime() < ev.startsAt.getTime()) return "not_started";
  if (now.getTime() > fixUntil(ev).getTime()) return "past";
  return null;
}

export const fixOpen = (ev: Fixable, now: Date): boolean => fixRefusal(ev, now) === null;

/**
 * What one person may do to the line-up in the window:
 *
 *   - `edit`: put a name or a past player in an open place, change who holds a place (a held name or a
 *     player), remove a player or a hold. The organiser and every player with a seat.
 *   - `take`: take an open place for oneself. Anybody signed in without a seat, the organiser too.
 *   - `replace`: "I played instead of Bo": take a player's place, or a held place, for oneself. Anybody
 *     signed in without a seat.
 *
 * `seated`: the person holds a taken place (joined or confirmed) inside the match's capacity.
 */
export type FixRights = { edit: boolean; take: boolean; replace: boolean };
export const NO_FIX: FixRights = { edit: false, take: false, replace: false };

export function fixRights(ev: Fixable, now: Date, who: { signedIn: boolean; organiser: boolean; seated: boolean }): FixRights {
  if (!fixOpen(ev, now)) return NO_FIX;
  const outsider = who.signedIn && !who.seated;
  return { edit: who.organiser || (who.signedIn && who.seated), take: outsider, replace: outsider };
}
