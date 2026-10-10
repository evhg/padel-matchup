import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, events, players, slots, tournamentMatches, tournamentRounds, type Event, type Slot, type TournamentFormat, type TournamentMatch, type TournamentRound } from "@/db/schema";
import { computeStandings, maxCourtsFor, rotationLength, type StandingRow } from "./americano";
import { presentSpots } from "./checkIn";
import { DomainError } from "./errors";
import { computeKingStandings, drawRound, firstRoundRefusal, FORMATS, formatOf, type KingStandingRow } from "./formats";
import { computeKingPairStandings, computePairStandings, pairCourts, pairRotationRounds, pairRowsToPlayers, pairsOfRounds, pairsRefusal, seatUnits, unitCounts, type Pair, type PairStandingRow } from "./fixedPairs";
import { MAX_TOURNAMENT_CAPACITY } from "@/lib/config";
import { recomputeStatus } from "./events";
import { normalizeName } from "./players";
import { lockEvent, reserveLocked } from "./slots";

export type RoundWithMatches = TournamentRound & { matches: TournamentMatch[] };
export type TournamentState = {
  format: TournamentFormat;
  rounds: RoundWithMatches[];
  standings: (StandingRow | KingStandingRow)[];
  participantIds: string[];
  maxCourts: number;
  scoredMatches: number;
  /** Rounds until everyone has partnered everyone once (field in fours), else null. With fixed pairs: until every pair has met every other, on every court the field fills. */
  rotationLength: number | null;
  /** A fixed-pairs night: the pairs' table, one row a pair. `standings` then carries each pair's row once per partner. */
  pairStandings: PairStandingRow[] | null;
};

/** A fixed-pairs night's pairs, from its named seats: the complete pairs as player ids, in seat order. */
export function pairsOfSeats(named: readonly Slot[]): Pair[] {
  return seatUnits(named).flatMap((u) => (u.kind === "pair" && u.seats[0].playerId && u.seats[1].playerId ? [[u.seats[0].playerId, u.seats[1].playerId] as const] : []));
}

/** A roster spot with a name on it: joined, confirmed, or reserved and not yet accepted. */
export const isNamedSlot = (s: Pick<Slot, "status">) => s.status === "joined" || s.status === "confirmed" || s.status === "invited";

async function namedRoster(tx: Db, ev: Event): Promise<Slot[]> {
  return tx
    .select()
    .from(slots)
    .where(and(eq(slots.eventId, ev.id), sql`${slots.position} <= ${ev.capacity}`, inArray(slots.status, ["joined", "confirmed", "invited"])))
    .orderBy(asc(slots.position));
}

/** The waiting list: joined names behind the capacity, in order. Bounded by the event's own slots. A fixed-pairs night's waiting pair may hold a reserved partner, named like any other. */
async function waitingList(tx: Db, ev: Event): Promise<Slot[]> {
  return tx
    .select()
    .from(slots)
    .where(and(eq(slots.eventId, ev.id), sql`${slots.position} > ${ev.capacity}`, ev.fixedPairs ? inArray(slots.status, ["joined", "confirmed", "invited"]) : eq(slots.status, "joined")))
    .orderBy(asc(slots.position));
}

async function rosterIds(tx: Db, ev: Event): Promise<string[]> {
  return (await namedRoster(tx, ev)).map((r) => r.playerId).filter((x): x is string => Boolean(x));
}

/**
 * Round 1 with a field other than the list: the tournament becomes exactly those
 * players. Named spots move to positions 1..n, open spots and absent names go,
 * capacity = n. A waiting-list name the check-in ticked is one of the n; the rest
 * of the waiting list stays behind them, as it was.
 */
async function shrinkToNamed(tx: Db, ev: Event, named: Slot[], actorPlayerId: string | null): Promise<Event> {
  const all = await tx.select().from(slots).where(eq(slots.eventId, ev.id)).orderBy(asc(slots.position));
  const keep = new Set(named.map((s) => s.id));
  const drop = all.filter((s) => s.position <= ev.capacity && !keep.has(s.id)).map((s) => s.id);
  if (drop.length) await tx.delete(slots).where(inArray(slots.id, drop));
  const order = [...named, ...all.filter((s) => s.position > ev.capacity && !keep.has(s.id))];
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

/** `pairs`: a fixed-pairs night's complete pairs on the list (`pairsOfSeats`); the rounds add any pair that has played since. */
export async function getTournamentState(db: Db, ev: Event, participantIds: string[], pairs: readonly Pair[] = []): Promise<TournamentState> {
  const rounds = await loadRounds(db, ev.id);
  const all = rounds.flatMap((r) => r.matches);
  const format = formatOf(ev.format);
  const scoredMatches = all.filter((m) => m.sideA != null && m.sideB != null).length;
  if (ev.fixedPairs) {
    const field = pairsOfRounds(rounds, pairs);
    const pairStandings = format === "king" ? computeKingPairStandings(field, rounds) : computePairStandings(field, all, { byWins: Boolean(ev.gamesTo) });
    // The round robin repeats once every pair has met every other, when every court the field fills is in play.
    const inPlay = pairs.length || field.length;
    const exact = pairCourts(inPlay, ev.courts) === Math.floor(inPlay / 2);
    return { format, rounds, standings: pairRowsToPlayers(pairStandings), participantIds, maxCourts: maxCourtsFor(participantIds.length), scoredMatches, rotationLength: format === "americano" && exact ? pairRotationRounds(inPlay) : null, pairStandings };
  }
  const ids = new Set(participantIds);
  for (const m of all) for (const p of [m.a1, m.a2, m.b1, m.b2]) ids.add(p);
  return {
    format,
    rounds,
    standings: format === "king" ? computeKingStandings([...ids], rounds) : computeStandings([...ids], all, { byWins: Boolean(ev.gamesTo) }),
    participantIds,
    maxCourts: maxCourtsFor(participantIds.length),
    scoredMatches,
    rotationLength: format === "americano" ? rotationLength(participantIds.length) : null,
    pairStandings: null,
  };
}

export async function setTournamentSettings(
  db: Db,
  input: { eventId: string; actorPlayerId: string | null; courts?: number | null; pointsPerMatch?: number | null; /** First to N games; setting it clears the points and the other way round: one way to score at a time. */ gamesTo?: number | null; courtNames?: string[] | null; format?: TournamentFormat; /** Fixed pairs or rotating partners, until round 1. */ fixedPairs?: boolean },
): Promise<Event> {
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    if (ev.type !== "tournament") throw new DomainError("invalid", "not_a_tournament");
    const set: Partial<typeof events.$inferInsert> = {};
    if (input.format !== undefined) {
      if (!FORMATS.includes(input.format)) throw new DomainError("invalid", "format");
      // The format decides how rounds are built, so it is fixed once round 1 exists.
      if (input.format !== formatOf(ev.format) && (await loadRounds(tx, ev.id)).length > 0) throw new DomainError("invalid", "format_locked");
      set.format = input.format;
    }
    if (input.fixedPairs !== undefined && input.fixedPairs !== ev.fixedPairs) {
      // The pairs are the field once round 1 is drawn. Turned off, the seats keep their keys and a night of rotating partners never reads them.
      if ((await loadRounds(tx, ev.id)).length > 0) throw new DomainError("invalid", "pairs_locked");
      set.fixedPairs = input.fixedPairs;
    }
    if (input.courts !== undefined) {
      if (input.courts !== null && (!Number.isInteger(input.courts) || input.courts < 1 || input.courts > 16)) throw new DomainError("invalid", "courts");
      set.courts = input.courts;
    }
    if (input.pointsPerMatch !== undefined) {
      if (input.pointsPerMatch !== null && (!Number.isInteger(input.pointsPerMatch) || input.pointsPerMatch < 4 || input.pointsPerMatch > 99)) throw new DomainError("invalid", "points");
      set.pointsPerMatch = input.pointsPerMatch;
      if (input.pointsPerMatch !== null) set.gamesTo = null;
    }
    if (input.gamesTo !== undefined) {
      if (input.gamesTo !== null && (!Number.isInteger(input.gamesTo) || input.gamesTo < 2 || input.gamesTo > 12)) throw new DomainError("invalid", "games");
      set.gamesTo = input.gamesTo;
      if (input.gamesTo !== null) set.pointsPerMatch = null;
    }
    if (input.courtNames !== undefined) {
      if (input.courtNames === null) set.courtNames = null;
      else {
        if (!Array.isArray(input.courtNames) || input.courtNames.length > 16) throw new DomainError("invalid", "court_names");
        const names = input.courtNames.map((n) => String(n ?? "").trim().slice(0, 20));
        set.courtNames = names.some(Boolean) ? names : null;
      }
    }
    if (Object.keys(set).length === 0) return ev;
    const [updated] = await tx.update(events).set(set).where(eq(events.id, ev.id)).returning();
    return updated;
  });
}

/** What the organiser's "Who is here?" sent with round 1: the exceptions to the defaults, and the count they saw on the button (`src/lib/domain/checkIn.ts`). */
export type CheckIn = { away: string[]; waitingIn: string[]; count: number };

/** A name the check-in left out of round 1, for the notice that follows the write. */
export type AbsentName = { playerId: string | null; name: string | null };

/**
 * Creates the next round from the current roster with rotating partners.
 *
 * Round 1 may carry a check-in. Then the field is the ticked names, not the list: the unticked are
 * taken out in the same transaction as the draw (an activity row each, as the organiser's "Remove
 * player" writes, and returned as `absent` so the action can tell them), and ticked waiting-list
 * names play. It is one write on purpose. "Remove player" one name at a time would move the waiting
 * list up into each freed spot and offer it to strangers (`notifyRefill`), at the moment the spots
 * are about to close; and a draw that failed after three removals would leave them removed.
 */
export async function generateRound(db: Db, input: { eventId: string; actorPlayerId: string | null; checkIn?: CheckIn; now?: Date }): Promise<RoundWithMatches & { absent: AbsentName[] }> {
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    if (ev.type !== "tournament") throw new DomainError("invalid", "not_a_tournament");
    if (ev.status === "cancelled") throw new DomainError("cancelled");
    if (ev.scoreLockedByCreator) throw new DomainError("locked");
    const existing = await loadRounds(tx, ev.id);
    let named = await namedRoster(tx, ev);
    const absent: AbsentName[] = [];
    if (existing.length === 0 && input.checkIn) {
      const waiting = await waitingList(tx, ev);
      const away = new Set(input.checkIn.away);
      const waitingIn = new Set(input.checkIn.waitingIn);
      // A name the screen knew that is gone now, or a count that moved under it: the organiser looks again rather than starting a field they did not see.
      const listedIds = new Set(named.map((s) => s.id));
      const waitingIds = new Set(waiting.map((s) => s.id));
      if ([...away].some((id) => !listedIds.has(id)) || [...waitingIn].some((id) => !waitingIds.has(id))) throw new DomainError("invalid", "roster_changed");
      const present = new Set(presentSpots({ listed: named.map((s) => s.id), waiting: waiting.map((s) => s.id) }, { away, waitingIn }));
      if (present.size !== input.checkIn.count) throw new DomainError("invalid", "roster_changed");
      const gone = named.filter((x) => away.has(x.id));
      // Their names in one read, the way "Remove player" names its row.
      const goneIds = gone.map((s) => s.playerId).filter((x): x is string => Boolean(x));
      const nameOf = new Map(goneIds.length ? (await tx.select({ id: players.id, n: players.displayName }).from(players).where(inArray(players.id, goneIds))).map((p) => [p.id, p.n]) : []);
      for (const s of gone) absent.push({ playerId: s.playerId, name: (s.playerId ? nameOf.get(s.playerId) : null) ?? s.invitedName });
      if (absent.length) await tx.insert(activity).values(absent.map((a) => ({ eventId: ev.id, actorPlayerId: input.actorPlayerId, verb: "removed" as const, meta: { name: a.name, targetPlayerId: a.playerId } })));
      named = [...named.filter((s) => present.has(s.id)), ...waiting.filter((s) => present.has(s.id))];
    }
    if (existing.length === 0) {
      // Round 1 sets the field: four names or more (reserved-but-unaccepted count), open spots close.
      // Americano and mexicano rest whoever does not fit a court; king wants fours (`firstRoundRefusal`).
      // Fixed pairs: two complete pairs or more in any format, and nobody without a partner (`pairsRefusal`):
      // a partner the check-in left out leaves the other one single, and the organiser decides.
      if (ev.fixedPairs) {
        const units = seatUnits(named);
        const { pairs, singles } = unitCounts(units);
        const refusal = pairsRefusal(pairs, singles);
        if (refusal) throw new DomainError("invalid", refusal);
        // Partners side by side on the list the field becomes.
        named = units.flatMap((u) => (u.kind === "pair" ? u.seats : [u.seat]));
      }
      const refusal = ev.fixedPairs ? null : firstRoundRefusal(formatOf(ev.format), named.length);
      if (refusal) throw new DomainError("invalid", refusal);
      const [creator] = await tx.select({ locale: players.locale }).from(players).where(eq(players.id, ev.creatorPlayerId));
      for (const s of named) {
        if (s.playerId) continue;
        // Reserved player without an account yet: a placeholder that merges into them when they accept.
        const [ph] = await tx.insert(players).values({ displayName: s.invitedName ?? "?", locale: creator?.locale ?? "en" }).returning();
        await tx.update(slots).set({ playerId: ph.id }).where(eq(slots.id, s.id));
        s.playerId = ph.id;
      }
      // The field is the list exactly, or it becomes exactly the field.
      if (named.length !== ev.capacity || named.some((s) => s.position > ev.capacity)) await shrinkToNamed(tx, ev, named, input.actorPlayerId);
    }
    const ids = named.map((s) => s.playerId).filter((x): x is string => Boolean(x));
    // Fixed pairs: the complete pairs play; a partner taken out since round 1 leaves the other out of the draw.
    const pairs = ev.fixedPairs ? pairsOfSeats(named) : undefined;
    if (pairs && pairs.length < 2) throw new DomainError("invalid", "need_2_pairs");
    if (ids.length < 4) throw new DomainError("invalid", "need_4_players");
    const roundNumber = (existing.at(-1)?.roundNumber ?? 0) + 1;
    // The draw itself is pure (`drawRound`): the same seeds and the same choices as always, so a
    // tournament already under way draws its next round exactly as it would have.
    const plan = drawRound({ eventId: ev.id, format: formatOf(ev.format), ids, courts: ev.courts, rounds: existing, pairs });
    const [round] = await tx.insert(tournamentRounds).values({ eventId: ev.id, roundNumber, resting: plan.resting }).returning();
    const matches = await tx
      .insert(tournamentMatches)
      .values(plan.matches.map((m) => ({ roundId: round.id, court: m.court, a1: m.a[0], a2: m.a[1], b1: m.b[0], b2: m.b[1] })))
      .returning();
    return { ...round, matches: matches.sort((a, b) => a.court - b.court), absent };
  });
}

/**
 * A walk-in: somebody turned up who was not on the list, added by the organiser before round 1. It is
 * the organiser's "Open spot" reserve (`reserveLocked`), the same row and the same feed line. When the
 * field is full, the field grows by exactly this one spot, in the same transaction: the waiting list
 * moves back one place, so nobody on it is moved up or told they are in at the night itself, and no
 * spot is left open for the hourly cron to fill from the waiting list or to offer to strangers.
 * King of the Court's fours are the check-in's business (`startAdvice`), not this write's.
 */
export async function addWalkIn(db: Db, input: { eventId: string; actorPlayerId: string | null; name: string; /** A fixed-pairs night: the walk-in's partner, who came with them. */ partnerName?: string | null; now?: Date }): Promise<{ slot: Slot; event: Event; grew: boolean; partner: Slot | null }> {
  const now = input.now ?? new Date();
  const name = normalizeName(input.name);
  if (!name) throw new DomainError("invalid", "name");
  const partnerName = normalizeName(input.partnerName ?? "");
  return db.transaction(async (tx) => {
    let ev = await lockEvent(tx, input.eventId);
    if (ev.type !== "tournament") throw new DomainError("invalid", "not_a_tournament");
    if (ev.status === "cancelled") throw new DomainError("cancelled");
    if (partnerName && !ev.fixedPairs) throw new DomainError("invalid", "not_fixed_pairs");
    // Round 1 closed the field while the screen still showed the check-in: show the round.
    if ((await loadRounds(tx, ev.id)).length > 0) throw new DomainError("invalid", "roster_changed");
    const open = await tx
      .select({ id: slots.id })
      .from(slots)
      .where(and(eq(slots.eventId, ev.id), sql`${slots.position} <= ${ev.capacity}`, inArray(slots.status, ["empty", "declined"])))
      .orderBy(asc(slots.position))
      .limit(2);
    const need = partnerName ? 2 : 1;
    let grew = false;
    if (open.length < need) {
      // A fixed-pairs night grows by two, so the field stays in pairs; a walk-in alone leaves one seat beside them.
      const grow = ev.fixedPairs ? 2 : 1;
      if (ev.capacity + grow > MAX_TOURNAMENT_CAPACITY) throw new DomainError("full");
      // The waiting list moves back: two set-based passes keep the (event, position) unique index happy.
      await tx
        .update(slots)
        .set({ position: sql`-(${slots.position} + ${grow})` })
        .where(and(eq(slots.eventId, ev.id), gt(slots.position, ev.capacity)));
      await tx
        .update(slots)
        .set({ position: sql`-${slots.position}` })
        .where(and(eq(slots.eventId, ev.id), lt(slots.position, 0)));
      await tx.insert(slots).values(Array.from({ length: grow }, (_, i) => ({ eventId: ev.id, position: ev.capacity + 1 + i, kind: "open" as const, status: "empty" as const })));
      [ev] = await tx.update(events).set({ capacity: ev.capacity + grow }).where(eq(events.id, ev.id)).returning();
      await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.actorPlayerId, verb: "updated", meta: { capacity: ev.capacity } });
      grew = true;
    }
    const reserved = await reserveLocked(tx, ev, { actorPlayerId: input.actorPlayerId, name, now });
    if (!partnerName) return { ...reserved, grew, partner: null };
    // Walked in together: two seats, one key.
    const second = await reserveLocked(tx, ev, { actorPlayerId: input.actorPlayerId, name: partnerName, now });
    const pairId = crypto.randomUUID();
    const [slot] = await tx.update(slots).set({ pairId }).where(eq(slots.id, reserved.slot.id)).returning();
    const [partner] = await tx.update(slots).set({ pairId }).where(eq(slots.id, second.slot.id)).returning();
    return { slot, event: second.event, grew, partner };
  });
}

/** Removes the latest round (scores in it are lost; the organizer confirms in the UI). */
export async function deleteLastRound(db: Db, input: { eventId: string }): Promise<number | null> {
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    if (ev.scoreLockedByCreator) throw new DomainError("locked");
    const rounds = await loadRounds(tx, ev.id);
    const last = rounds.at(-1);
    if (!last) return null;
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
    // First to N games: a side wins at N and the other has fewer. A match the bell stopped (3–2) still counts as a win for the side ahead.
    if (ev.gamesTo && sideA !== null && sideB !== null && (sideA > ev.gamesTo || sideB > ev.gamesTo || (sideA === ev.gamesTo && sideB === ev.gamesTo))) throw new DomainError("invalid", "games_range");
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
