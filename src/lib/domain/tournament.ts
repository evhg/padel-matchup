import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, events, players, slots, tournamentMatches, tournamentRounds, type Event, type Slot, type TournamentMatch, type TournamentRound } from "@/db/schema";
import { buildHistory, computeStandings, maxCourtsFor, mulberry32, planRound, seedFrom, type StandingRow } from "./americano";
import { DomainError } from "./errors";
import { recomputeStatus } from "./events";
import { lockEvent } from "./slots";

export type RoundWithMatches = TournamentRound & { matches: TournamentMatch[] };
export type TournamentState = {
  rounds: RoundWithMatches[];
  standings: StandingRow[];
  participantIds: string[];
  maxCourts: number;
  scoredMatches: number;
};

/** A roster spot with a name on it: joined, confirmed, or reserved and not yet accepted. */
export const isNamedSlot = (s: Pick<Slot, "status">) => s.status === "joined" || s.status === "confirmed" || s.status === "invited";

async function namedRoster(tx: Db, ev: Event): Promise<Slot[]> {
  return tx
    .select()
    .from(slots)
    .where(and(eq(slots.eventId, ev.id), sql`${slots.position} <= ${ev.capacity}`, inArray(slots.status, ["joined", "confirmed", "invited"])))
    .orderBy(asc(slots.position));
}

async function rosterIds(tx: Db, ev: Event): Promise<string[]> {
  return (await namedRoster(tx, ev)).map((r) => r.playerId).filter((x): x is string => Boolean(x));
}

/**
 * Round 1 with fewer names than capacity: the tournament becomes exactly those
 * players. Named spots move to positions 1..n, open spots go, capacity = n.
 */
async function shrinkToNamed(tx: Db, ev: Event, named: Slot[], actorPlayerId: string | null): Promise<Event> {
  const all = await tx.select().from(slots).where(eq(slots.eventId, ev.id)).orderBy(asc(slots.position));
  const keep = new Set(named.map((s) => s.id));
  const drop = all.filter((s) => s.position <= ev.capacity && !keep.has(s.id)).map((s) => s.id);
  if (drop.length) await tx.delete(slots).where(inArray(slots.id, drop));
  const order = [...named, ...all.filter((s) => s.position > ev.capacity)];
  // Two passes keep the (event, position) unique index happy.
  for (let i = 0; i < order.length; i++) await tx.update(slots).set({ position: -(i + 1) }).where(eq(slots.id, order[i].id));
  for (let i = 0; i < order.length; i++) await tx.update(slots).set({ position: i + 1 }).where(eq(slots.id, order[i].id));
  const [updated] = await tx.update(events).set({ capacity: named.length }).where(eq(events.id, ev.id)).returning();
  const status = await recomputeStatus(tx, updated);
  await tx.insert(activity).values({ eventId: ev.id, actorPlayerId, verb: "updated", meta: { capacity: named.length } });
  return { ...updated, status };
}

export async function loadRounds(db: Db, eventId: string): Promise<RoundWithMatches[]> {
  const rounds = await db.select().from(tournamentRounds).where(eq(tournamentRounds.eventId, eventId)).orderBy(asc(tournamentRounds.roundNumber));
  if (rounds.length === 0) return [];
  const matches = await db
    .select()
    .from(tournamentMatches)
    .where(
      inArray(
        tournamentMatches.roundId,
        rounds.map((r) => r.id),
      ),
    )
    .orderBy(asc(tournamentMatches.court));
  return rounds.map((r) => ({ ...r, matches: matches.filter((m) => m.roundId === r.id) }));
}

export async function getTournamentState(db: Db, ev: Event, participantIds: string[]): Promise<TournamentState> {
  const rounds = await loadRounds(db, ev.id);
  const all = rounds.flatMap((r) => r.matches);
  const ids = new Set(participantIds);
  for (const m of all) for (const p of [m.a1, m.a2, m.b1, m.b2]) ids.add(p);
  return {
    rounds,
    standings: computeStandings([...ids], all),
    participantIds,
    maxCourts: maxCourtsFor(participantIds.length),
    scoredMatches: all.filter((m) => m.sideA != null && m.sideB != null).length,
  };
}

export async function setTournamentSettings(
  db: Db,
  input: { eventId: string; actorPlayerId: string | null; courts?: number | null; pointsPerMatch?: number | null },
): Promise<Event> {
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    if (ev.type !== "tournament") throw new DomainError("invalid", "not_a_tournament");
    const set: Partial<typeof events.$inferInsert> = {};
    if (input.courts !== undefined) {
      if (input.courts !== null && (!Number.isInteger(input.courts) || input.courts < 1 || input.courts > 16)) throw new DomainError("invalid", "courts");
      set.courts = input.courts;
    }
    if (input.pointsPerMatch !== undefined) {
      if (input.pointsPerMatch !== null && (!Number.isInteger(input.pointsPerMatch) || input.pointsPerMatch < 4 || input.pointsPerMatch > 99)) throw new DomainError("invalid", "points");
      set.pointsPerMatch = input.pointsPerMatch;
    }
    if (Object.keys(set).length === 0) return ev;
    const [updated] = await tx.update(events).set(set).where(eq(events.id, ev.id)).returning();
    return updated;
  });
}

/** Creates the next round from the current roster with rotating partners. */
export async function generateRound(db: Db, input: { eventId: string; actorPlayerId: string | null; now?: Date }): Promise<RoundWithMatches> {
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    if (ev.type !== "tournament") throw new DomainError("invalid", "not_a_tournament");
    if (ev.status === "cancelled") throw new DomainError("cancelled");
    if (ev.scoreLockedByCreator) throw new DomainError("locked");
    const existing = await loadRounds(tx, ev.id);
    const named = await namedRoster(tx, ev);
    if (existing.length === 0) {
      // Round 1 sets the field: names in fours (reserved-but-unaccepted count), open spots close.
      if (named.length < 4 || named.length % 4 !== 0) throw new DomainError("invalid", "multiple_of_4");
      const [creator] = await tx.select({ locale: players.locale }).from(players).where(eq(players.id, ev.creatorPlayerId));
      for (const s of named) {
        if (s.playerId) continue;
        // Reserved player without an account yet: a placeholder that merges into them when they accept.
        const [ph] = await tx.insert(players).values({ displayName: s.invitedName ?? "?", locale: creator?.locale ?? "en" }).returning();
        await tx.update(slots).set({ playerId: ph.id }).where(eq(slots.id, s.id));
        s.playerId = ph.id;
      }
      if (named.length < ev.capacity) await shrinkToNamed(tx, ev, named, input.actorPlayerId);
    }
    const ids = named.map((s) => s.playerId).filter((x): x is string => Boolean(x));
    if (ids.length < 4) throw new DomainError("invalid", "need_4_players");
    const history = buildHistory(existing.map((r) => ({ matches: r.matches, resting: r.resting })));
    const roundNumber = (existing.at(-1)?.roundNumber ?? 0) + 1;
    const plan = planRound(ids, ev.courts, history, mulberry32(seedFrom(`${ev.id}:${roundNumber}`)));
    const [round] = await tx.insert(tournamentRounds).values({ eventId: ev.id, roundNumber, resting: plan.resting }).returning();
    const matches = await tx
      .insert(tournamentMatches)
      .values(plan.matches.map((m) => ({ roundId: round.id, court: m.court, a1: m.a[0], a2: m.a[1], b1: m.b[0], b2: m.b[1] })))
      .returning();
    return { ...round, matches: matches.sort((a, b) => a.court - b.court) };
  });
}

/** Removes the latest round, only while none of its matches has a score. */
export async function deleteLastRound(db: Db, input: { eventId: string }): Promise<number | null> {
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    if (ev.scoreLockedByCreator) throw new DomainError("locked");
    const rounds = await loadRounds(tx, ev.id);
    const last = rounds.at(-1);
    if (!last) return null;
    if (last.matches.some((m) => m.sideA != null || m.sideB != null)) throw new DomainError("invalid", "round_scored");
    await tx.delete(tournamentRounds).where(eq(tournamentRounds.id, last.id));
    return last.roundNumber;
  });
}

/**
 * Any participant may enter or correct any match; once the organizer
 * finalizes (lock), only the organizer can change scores.
 */
export async function saveTournamentMatchScore(
  db: Db,
  input: { eventId: string; matchId: string; sideA: number | null; sideB: number | null; playerId: string | null; isCreator: boolean; now?: Date },
): Promise<TournamentMatch> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    if (ev.type !== "tournament") throw new DomainError("invalid", "not_a_tournament");
    if (ev.status === "cancelled") throw new DomainError("cancelled");
    // Scores can go in as soon as a round exists (warm-up games, early starts, testing).
    if (!input.isCreator) {
      if (!input.playerId) throw new DomainError("not_participant");
      const ids = await rosterIds(tx, ev);
      if (!ids.includes(input.playerId)) throw new DomainError("not_participant");
      if (ev.scoreLockedByCreator) throw new DomainError("locked");
    }
    const [match] = await tx
      .select({ m: tournamentMatches })
      .from(tournamentMatches)
      .innerJoin(tournamentRounds, eq(tournamentRounds.id, tournamentMatches.roundId))
      .where(and(eq(tournamentMatches.id, input.matchId), eq(tournamentRounds.eventId, ev.id)))
      .limit(1);
    if (!match) throw new DomainError("not_found");
    const clean = (v: number | null) => {
      if (v === null || v === undefined || Number.isNaN(v)) return null;
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 0 || n > 99) throw new DomainError("invalid", "score_range");
      return n;
    };
    const sideA = clean(input.sideA);
    const sideB = clean(input.sideB);
    if ((sideA === null) !== (sideB === null)) throw new DomainError("invalid", "both_sides");
    const [updated] = await tx
      .update(tournamentMatches)
      .set({ sideA, sideB, enteredByPlayerId: input.playerId, updatedAt: now })
      .where(eq(tournamentMatches.id, input.matchId))
      .returning();
    if (sideA !== null) {
      await tx.update(events).set({ scoreReminderSent: true }).where(eq(events.id, ev.id));
      const [round] = await tx.select({ n: tournamentRounds.roundNumber }).from(tournamentRounds).where(eq(tournamentRounds.id, updated.roundId));
      await tx.insert(activity).values({
        eventId: ev.id,
        actorPlayerId: input.playerId,
        verb: "score_entered",
        meta: { round: round?.n ?? null, court: updated.court, summary: `${sideA}-${sideB}`, byCreator: input.isCreator ? 1 : 0 },
      });
    }
    return updated;
  });
}

/** Organizer finalizes: locks scores and snapshots the standings. Unlock clears the snapshot. */
export async function setTournamentLock(db: Db, input: { eventId: string; locked: boolean; actorPlayerId: string | null }): Promise<Event> {
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    if (ev.type !== "tournament") throw new DomainError("invalid", "not_a_tournament");
    let standings: string[] | null = null;
    if (input.locked) {
      const ids = await rosterIds(tx, ev);
      const state = await getTournamentState(tx, ev, ids);
      standings = state.standings.map((r) => r.playerId);
    }
    const [updated] = await tx
      .update(events)
      .set({ scoreLockedByCreator: input.locked, standings, scoreReminderSent: input.locked ? true : ev.scoreReminderSent })
      .where(eq(events.id, ev.id))
      .returning();
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.actorPlayerId, verb: "updated", meta: { finalized: input.locked ? 1 : 0 } });
    return updated;
  });
}
