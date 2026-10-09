import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, events, scores, slots, type Event, type Score } from "@/db/schema";
import { DomainError } from "./errors";
import { lockEvent } from "./slots";

export type SetScore = { setNumber: number; sideA: number; sideB: number };

export type ScorePermission =
  | { allowed: true; locked: boolean }
  | { allowed: false; reason: "not_started" | "cancelled" | "not_participant" | "locked" };

/**
 * Decision 13: after start, any participant may enter/edit and players may
 * correct each other freely; once the CREATOR enters or edits, it locks for
 * everyone else.
 */
export function scorePermission(input: {
  event: Pick<Event, "startsAt" | "status" | "scoreLockedByCreator">;
  now: Date;
  viewerPlayerId: string | null;
  isCreator: boolean;
  participantIds: string[];
}): ScorePermission {
  const { event, now, viewerPlayerId, isCreator, participantIds } = input;
  if (event.status === "cancelled") return { allowed: false, reason: "cancelled" };
  if (now.getTime() < event.startsAt.getTime()) return { allowed: false, reason: "not_started" };
  if (isCreator) return { allowed: true, locked: event.scoreLockedByCreator };
  if (!viewerPlayerId || !participantIds.includes(viewerPlayerId)) return { allowed: false, reason: "not_participant" };
  if (event.scoreLockedByCreator) return { allowed: false, reason: "locked" };
  return { allowed: true, locked: false };
}

/**
 * The most sets a match score holds (owner's decision H, 9 October 2026). Four or five sets are rare
 * but real: a crew that keeps playing while the court is theirs, or a best of five. The server takes
 * any games score from 0 to 30 in each; whether a set looks right is `unusualSets`, which only asks.
 */
export const MAX_SETS = 5;

/**
 * Does a set look like padel? A question, never a refusal: the web asks "Is 6-5 right?" once before it
 * saves, and the bot saves and says the set looks unusual. What counts as usual:
 *
 * - a set to six: 6-0 to 6-4, 7-5, 7-6;
 * - a short set to four: 4-0 to 4-2, then 5-3 and 5-4 (played on at 3-3, or a tie-break at 4-4);
 * - a pro set, only when it is the whole match: to eight two clear (8-0 to 8-6), and 9-0 to 9-8, which
 *   covers a set to nine two clear (9-7 at most), an eight-game pro set played on from 7-7 (9-7), and its
 *   tie-break at 8-8 (9-8). Inside a longer match 8-3 or 9-2 is far likelier a typo than a pro set;
 * - a match tie-break, only as the last set: the winner on ten or more and two clear, so 10-0 to 10-8,
 *   then exactly two apart (11-9, 12-10 …).
 *
 * Everything else asks: 6-5, 3-1, 2-2, 9-2 as one set of several, 10-8 before the last set.
 * The order of the sides does not matter.
 */
export function isUsualSet(set: { sideA: number; sideB: number }, place: { last: boolean; only: boolean }): boolean {
  const w = Math.max(set.sideA, set.sideB);
  const l = Math.min(set.sideA, set.sideB);
  if (w === 6 && l <= 4) return true;
  if (w === 7 && (l === 5 || l === 6)) return true;
  if (w === 4 && l <= 2) return true;
  if (w === 5 && (l === 3 || l === 4)) return true;
  if (place.only && ((w === 8 && l <= 6) || (w === 9 && l <= 8))) return true;
  if (place.last && w >= 10 && w - l >= 2 && (w === 10 || w - l === 2)) return true;
  return false;
}

/** The indexes (from 0) of the sets `isUsualSet` would ask about, in order; empty when the whole score looks right. */
export function unusualSets(sets: { sideA: number; sideB: number }[]): number[] {
  const out: number[] = [];
  sets.forEach((s, i) => {
    if (!isUsualSet(s, { last: i === sets.length - 1, only: sets.length === 1 })) out.push(i);
  });
  return out;
}

export function validateSets(raw: SetScore[]): SetScore[] {
  const sets = raw
    .map((s, i) => ({ setNumber: i + 1, sideA: Math.round(Number(s.sideA)), sideB: Math.round(Number(s.sideB)) }))
    .filter((s) => Number.isFinite(s.sideA) && Number.isFinite(s.sideB));
  if (sets.length < 1 || sets.length > MAX_SETS) throw new DomainError("invalid", "sets");
  for (const s of sets) {
    if (s.sideA < 0 || s.sideB < 0 || s.sideA > 30 || s.sideB > 30) throw new DomainError("invalid", "score_range");
    if (s.sideA === 0 && s.sideB === 0) throw new DomainError("invalid", "empty_set");
  }
  return sets;
}

/** Sets won by each side. */
export function tally(sets: Pick<Score, "sideA" | "sideB">[]): { a: number; b: number } {
  let a = 0;
  let b = 0;
  for (const s of sets) {
    if (s.sideA > s.sideB) a++;
    else if (s.sideB > s.sideA) b++;
  }
  return { a, b };
}

export type Outcome = "won" | "lost" | "draw";

export function outcomeForTeam(sets: Pick<Score, "sideA" | "sideB">[], team: "a" | "b" | null): Outcome | null {
  if (!team || sets.length === 0) return null;
  const t = tally(sets);
  if (t.a === t.b) return "draw";
  const aWon = t.a > t.b;
  return (team === "a") === aWon ? "won" : "lost";
}

export async function saveMatchScore(
  db: Db,
  input: {
    eventId: string;
    playerId: string | null;
    isCreator: boolean;
    sets: SetScore[];
    /** Optional: player ids on team A (others on the roster become team B). */
    teamA?: string[];
    now?: Date;
  },
): Promise<{ event: Event; scores: Score[] }> {
  const now = input.now ?? new Date();
  const sets = validateSets(input.sets);
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    if (ev.type !== "match") throw new DomainError("invalid", "not_a_match");
    const roster = await tx
      .select({ id: slots.id, playerId: slots.playerId })
      .from(slots)
      .where(and(eq(slots.eventId, ev.id), sql`${slots.position} <= ${ev.capacity}`, inArray(slots.status, ["joined", "confirmed"])));
    const participantIds = roster.map((r) => r.playerId).filter((x): x is string => Boolean(x));
    const perm = scorePermission({ event: ev, now, viewerPlayerId: input.playerId, isCreator: input.isCreator, participantIds });
    if (!perm.allowed) {
      throw new DomainError(perm.reason === "locked" ? "locked" : perm.reason === "not_started" ? "not_started" : perm.reason === "cancelled" ? "cancelled" : "not_participant");
    }

    await tx.delete(scores).where(eq(scores.eventId, ev.id));
    const inserted = await tx
      .insert(scores)
      .values(sets.map((s) => ({ eventId: ev.id, setNumber: s.setNumber, sideA: s.sideA, sideB: s.sideB, enteredByPlayerId: input.playerId, updatedAt: now })))
      .returning();

    if (input.teamA) {
      const teamA = new Set(input.teamA);
      for (const r of roster) {
        if (!r.playerId) continue;
        await tx
          .update(slots)
          .set({ team: teamA.has(r.playerId) ? "a" : "b" })
          .where(eq(slots.id, r.id));
      }
    }

    const set: Partial<typeof events.$inferInsert> = { scoreReminderSent: true };
    if (input.isCreator) set.scoreLockedByCreator = true;
    const [updated] = await tx.update(events).set(set).where(eq(events.id, ev.id)).returning();
    await tx.insert(activity).values({
      eventId: ev.id,
      actorPlayerId: input.playerId,
      verb: "score_entered",
      meta: { summary: sets.map((s) => `${s.sideA}-${s.sideB}`).join(" "), byCreator: input.isCreator ? 1 : 0 },
    });
    return { event: updated, scores: inserted };
  });
}
