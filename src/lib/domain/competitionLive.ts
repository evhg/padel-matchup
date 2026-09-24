import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { Db } from "@/db";
import { competitionCategories, competitionMatches, competitionPairs, milestones, players, type CompetitionCategory, type Milestone, type Player } from "@/db/schema";
import { orderOfPlay, type PlayRow } from "./competitionSchedule";
import { SCORING, scoringOfMatch } from "./draw";

/**
 * The tournament as it runs: what is on each court now and next, the latest results, the
 * champions — the club's screen reads it every half minute — and the podium as a moment for
 * every player on it, once (rule 18).
 */

export type CourtNow = { courtName: string; now: PlayRow | null; next: PlayRow | null };
export type LiveBoard = {
  courts: CourtNow[];
  latest: PlayRow[];
  upcoming: PlayRow[];
  champions: { categoryName: string; name: string }[];
  /** Champions crowned and nothing left to play: the screen then leads with them, not four free courts. */
  finished: boolean;
  /** Rounds per `<categoryId>:<phase>`, which names a knockout source ("Winner of semi-final 1"). */
  rounds: Record<string, number>;
};

const isOver = (m: PlayRow) => m.status === "done" || m.status === "walkover";

/** Per court, the match in play and the one after; the last results; the champions so far. */
export async function liveBoard(db: Db, competitionId: string, courtNames: readonly string[], categories: readonly CompetitionCategory[], now = new Date()): Promise<LiveBoard> {
  const rows = await orderOfPlay(db, competitionId);
  const byCategory = new Map(categories.map((c) => [c.id, c]));
  const roundsOf = new Map(categories.map((c) => [c.id, Math.max(0, ...rows.filter((m) => m.categoryId === c.id && m.phase === "main").map((m) => m.round))]));
  const minutesOf = (m: PlayRow) => {
    const c = byCategory.get(m.categoryId);
    return c ? SCORING[scoringOfMatch(m, roundsOf.get(m.categoryId) ?? 0, c)].minutes : 60;
  };
  const t = now.getTime();
  const courts = courtNames.map((courtName) => {
    const mine = rows.filter((m) => m.courtName === courtName && !isOver(m) && m.scheduledAt);
    const playing = mine.find((m) => m.scheduledAt!.getTime() <= t && t < m.scheduledAt!.getTime() + minutesOf(m) * 60_000) ?? null;
    const next = mine.find((m) => m.scheduledAt!.getTime() > t && m !== playing) ?? mine.find((m) => m !== playing) ?? null;
    return { courtName, now: playing, next };
  });
  const latest = rows
    .filter(isOver)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 8);
  const upcoming = rows.filter((m) => !isOver(m) && m.scheduledAt && m.scheduledAt.getTime() > t).slice(0, 8);
  const champions: LiveBoard["champions"] = [];
  for (const c of categories) {
    if (c.drawStatus !== "done") continue;
    const rounds = roundsOf.get(c.id) ?? 0;
    const final = rows.find((m) => m.categoryId === c.id && m.phase === "main" && m.round === rounds);
    const name = final?.winner === "A" ? final.aName : final?.winner === "B" ? final.bName : null;
    if (name) champions.push({ categoryName: c.name, name });
  }
  const rounds: Record<string, number> = {};
  for (const m of rows) rounds[`${m.categoryId}:${m.phase}`] = Math.max(rounds[`${m.categoryId}:${m.phase}`] ?? 0, m.round);
  const finished = champions.length > 0 && !rows.some((m) => !isOver(m) && !m.bye);
  return { courts, latest, upcoming, champions, finished, rounds };
}

export type PodiumAward = { milestone: Milestone; player: Player; place: 1 | 2 | 3; partnerName: string };

/**
 * The podium of a finished category: the champions, the finalists, both semi-final losers — every
 * player of those pairs gets the moment once. The value carries the category so a player who
 * makes two podiums keeps both.
 */
export async function awardCompetitionPodium(db: Db, categoryId: string, now = new Date()): Promise<PodiumAward[]> {
  const [category] = await db.select().from(competitionCategories).where(eq(competitionCategories.id, categoryId)).limit(1);
  if (!category || category.drawStatus !== "done") return [];
  const main = await db
    .select()
    .from(competitionMatches)
    .where(and(eq(competitionMatches.categoryId, categoryId), eq(competitionMatches.phase, "main")))
    .orderBy(desc(competitionMatches.round));
  const rounds = Math.max(0, ...main.map((m) => m.round));
  const final = main.find((m) => m.round === rounds);
  if (!final || !final.winner) return [];
  const places: { pairId: string; place: 1 | 2 | 3 }[] = [];
  places.push({ pairId: (final.winner === "A" ? final.pairAId : final.pairBId)!, place: 1 });
  const runnerUp = final.winner === "A" ? final.pairBId : final.pairAId;
  if (runnerUp) places.push({ pairId: runnerUp, place: 2 });
  for (const semi of main.filter((m) => m.round === rounds - 1 && m.winner && !m.bye)) {
    const loser = semi.winner === "A" ? semi.pairBId : semi.pairAId;
    if (loser) places.push({ pairId: loser, place: 3 });
  }
  const pairIds = places.map((p) => p.pairId);
  const pairs = await db
    .select({ id: competitionPairs.id, p1: competitionPairs.p1PlayerId, p2: competitionPairs.p2PlayerId })
    .from(competitionPairs)
    .where(inArray(competitionPairs.id, pairIds));
  const out: PodiumAward[] = [];
  for (const { pairId, place } of places) {
    const pair = pairs.find((p) => p.id === pairId);
    if (!pair) continue;
    const two = await db.select().from(players).where(inArray(players.id, [pair.p1, pair.p2]));
    for (const player of two) {
      const [row] = await db
        .insert(milestones)
        .values({ playerId: player.id, kind: "podium", value: `competition:${categoryId}:${place}`, eventId: null, createdAt: now })
        .onConflictDoNothing()
        .returning();
      if (!row) continue;
      out.push({ milestone: row, player, place, partnerName: two.find((p) => p.id !== player.id)?.displayName ?? "" });
    }
  }
  return out;
}

/** The pairs a player is in, for the reply-score reader: the match a reply names must be theirs. */
export async function isInMatch(db: Db, playerId: string, m: { pairAId: string | null; pairBId: string | null }): Promise<boolean> {
  const ids = [m.pairAId, m.pairBId].filter((x): x is string => Boolean(x));
  if (ids.length === 0) return false;
  const rows = await db
    .select({ id: competitionPairs.id })
    .from(competitionPairs)
    .where(and(inArray(competitionPairs.id, ids), or(eq(competitionPairs.p1PlayerId, playerId), eq(competitionPairs.p2PlayerId, playerId)), isNotNull(competitionPairs.id)));
  return rows.length > 0;
}
