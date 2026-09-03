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

export function validateSets(raw: SetScore[]): SetScore[] {
  const sets = raw
    .map((s, i) => ({ setNumber: i + 1, sideA: Math.round(Number(s.sideA)), sideB: Math.round(Number(s.sideB)) }))
    .filter((s) => Number.isFinite(s.sideA) && Number.isFinite(s.sideB));
  if (sets.length < 1 || sets.length > 3) throw new DomainError("invalid", "sets");
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

/** Tournament v1: creator-only ordered standings (player ids). Rounds are roadmap. */
export async function saveTournamentStandings(
  db: Db,
  input: { eventId: string; playerId: string | null; isCreator: boolean; standings: string[]; now?: Date },
): Promise<Event> {
  const now = input.now ?? new Date();
  if (!input.isCreator) throw new DomainError("forbidden");
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    if (ev.type !== "tournament") throw new DomainError("invalid", "not_a_tournament");
    if (ev.status === "cancelled") throw new DomainError("cancelled");
    if (now.getTime() < ev.startsAt.getTime()) throw new DomainError("not_started");
    const roster = await tx
      .select({ playerId: slots.playerId })
      .from(slots)
      .where(and(eq(slots.eventId, ev.id), sql`${slots.position} <= ${ev.capacity}`, inArray(slots.status, ["joined", "confirmed"])));
    const valid = new Set(roster.map((r) => r.playerId).filter(Boolean) as string[]);
    const standings = input.standings.filter((id, i, arr) => valid.has(id) && arr.indexOf(id) === i);
    if (standings.length === 0) throw new DomainError("invalid", "standings");
    const [updated] = await tx
      .update(events)
      .set({ standings, scoreLockedByCreator: true, scoreReminderSent: true })
      .where(eq(events.id, ev.id))
      .returning();
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.playerId, verb: "score_entered", meta: { byCreator: 1 } });
    return updated;
  });
}
