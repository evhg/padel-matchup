import { and, eq, exists, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import { events, facts, players, scores, slots, type Event, type Player } from "@/db/schema";
import { utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";
import { DomainError } from "./errors";
import { nextWeekAfter } from "./events";
import { admission, waivedByPlay, type Admission } from "./levels";
import { endedBy } from "./reminders";
import { DELETED_PLAYER_NAME } from "./result";

/**
 * "Play again": the owner's decision of 11 October 2026, option A, "Make the one working group repeat
 * itself", and the answer "Yes, one message each" (DECIDING rule 37).
 *
 * The organiser picks the day and the time; the last game's day and time a week on is the default.
 * Everything else carries over (`duplicateEvent`), and a crew's match stays the crew's. Each player who
 * sat in the last match hears once, "I'm in?", through the notice gate (`notifyPlayAgain` in
 * `src/lib/notify.ts`), and a second tap on the same old match sends nothing (`claimPlayAgainRound`).
 * And a player who already played a finished, scored match with the organiser is not held to that
 * organiser's level range (`admissionAt`).
 */

/** How far ahead the next game may be. A crew plays weekly; a quarter of a year is a typo, not a plan. */
export const PLAY_AGAIN_AHEAD_DAYS = 90;

/** What the control sends: a day and a time as the match's own wall clock. Empty is no pick. */
export type PlayAgainPick = { date?: string | null; time?: string | null } | null | undefined;

/** The control's default: the last game's day and time a week on, as the wall clock where it is played. */
export function playAgainDefault(src: Pick<Event, "startsAt" | "tz">, now: Date): { date: string; time: string } {
  return utcToZonedParts(nextWeekAfter(src.startsAt, now), src.tz);
}

/** The start of the next game: the pick, read in the match's own zone, else a week on. Refuses a time already gone. */
export function playAgainStart(src: Pick<Event, "startsAt" | "tz">, pick: PlayAgainPick, now: Date): Date {
  if (!pick?.date && !pick?.time) return nextWeekAfter(src.startsAt, now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pick?.date ?? "") || !/^\d{2}:\d{2}$/.test(pick?.time ?? "")) throw new DomainError("invalid", "startsAt");
  let at: Date;
  try {
    at = zonedTimeToUtc(pick!.date!, pick!.time!, src.tz);
  } catch {
    throw new DomainError("invalid", "startsAt");
  }
  const ahead = at.getTime() - now.getTime();
  if (Number.isNaN(ahead) || ahead <= 0 || ahead > PLAY_AGAIN_AHEAD_DAYS * 24 * 3600_000) throw new DomainError("invalid", "startsAt");
  return at;
}

const SEATED = ["joined", "confirmed"] as const;

/**
 * Who hears that the next game exists: each player who held a taken seat in the last match. Not the
 * person who tapped, not the waiting list, not a seat held for a name (nobody's inbox), and not a
 * player who deleted their account. One read down `slots_event_position_idx`.
 */
export async function playAgainRecipients(db: Db, old: Pick<Event, "id" | "capacity">, tapperId: string): Promise<Player[]> {
  const rows = await db
    .select({ player: players })
    .from(slots)
    .innerJoin(players, eq(players.id, slots.playerId))
    .where(and(eq(slots.eventId, old.id), inArray(slots.status, [...SEATED]), lte(slots.position, old.capacity), isNotNull(slots.playerId), ne(slots.playerId, tapperId), ne(players.displayName, DELETED_PLAYER_NAME)))
    .orderBy(slots.position);
  return rows.map((r) => r.player);
}

/** The fact that says an old match's players heard about its next game: one per old match, ever. */
export const PLAY_AGAIN_FACT = "match.play_again";

/**
 * Claims the one round of "I'm in?" messages an old match may send. The old match's row is locked for
 * the read and the write, so two taps at once make one round; the record is the fact log, read on
 * `facts_subject_idx`. True for the tap that may send.
 */
export async function claimPlayAgainRound(db: Db, old: Pick<Event, "id" | "code">, next: Pick<Event, "code">, actorPlayerId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ id: events.id }).from(events).where(eq(events.id, old.id)).for("update");
    if (!row) return false;
    const [done] = await tx
      .select({ id: facts.id })
      .from(facts)
      .where(and(eq(facts.subjectType, "match"), eq(facts.subjectId, old.id), eq(facts.kind, PLAY_AGAIN_FACT)))
      .limit(1);
    if (done) return false;
    await tx.insert(facts).values({ kind: PLAY_AGAIN_FACT, channel: "web", actorPlayerId, subjectType: "match", subjectId: old.id, code: old.code, data: { next: next.code } });
    return true;
  });
}

/**
 * Did this player sit in a finished, scored match with this organiser? Both in its line-up (a taken
 * seat inside the capacity), the match over by its own length, not cancelled, with a score. One
 * bounded read: the player's seats (`slots_player_idx`), each match by its key, the organiser's seat
 * in it (`slots_event_player_idx`), its first set (`scores_event_set_idx`).
 */
export async function playedWithOrganiser(db: Db, organiserId: string, playerId: string, now: Date): Promise<boolean> {
  if (organiserId === playerId) return false;
  const mine = alias(slots, "mine");
  const theirs = alias(slots, "theirs");
  const [row] = await db
    .select({ id: events.id })
    .from(mine)
    .innerJoin(events, and(eq(events.id, mine.eventId), ne(events.status, "cancelled"), lte(mine.position, events.capacity), ...endedBy(now)))
    .innerJoin(theirs, and(eq(theirs.eventId, events.id), eq(theirs.playerId, organiserId), inArray(theirs.status, [...SEATED]), lte(theirs.position, events.capacity)))
    .where(and(eq(mine.playerId, playerId), inArray(mine.status, [...SEATED]), exists(db.select({ one: scores.id }).from(scores).where(eq(scores.eventId, events.id)))))
    .limit(1);
  return Boolean(row);
}

/**
 * Who walks in, with the owner's decision of 11 October 2026: somebody the organiser already played a
 * finished, scored match with skips that organiser's level range (and its confirmed-levels-only
 * check). A missing level is still asked for. The read runs only for a player the range would hold.
 */
export async function admissionAt(
  db: Db,
  ev: Pick<Event, "levelMin" | "levelMax" | "levelVerifiedOnly" | "creatorPlayerId">,
  p: { id: string; level: number | null | undefined; levelVerifiedLevel?: number | null },
  now = new Date(),
): Promise<Admission> {
  const fit = admission(ev, p);
  if (waivedByPlay(fit, true) === fit || p.id === ev.creatorPlayerId) return fit;
  return waivedByPlay(fit, await playedWithOrganiser(db, ev.creatorPlayerId, p.id, now));
}
