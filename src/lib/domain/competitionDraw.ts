import { and, asc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import {
  competitionCategories,
  competitionMatches,
  competitionPairs,
  competitions,
  players,
  type CategoryFormat,
  type Competition,
  type CompetitionCategory,
  type CompetitionMatch,
} from "@/db/schema";
import { checkScore, groupTable, isScoringCode, planDraw, progress, scoringOfMatch, type MatchLike, type ScoringCode, type TableRow } from "./draw";
import { DomainError } from "./errors";
import { isOrganizer } from "./competitions";
import { bumpMetric } from "./metrics";

/**
 * The draw of a category in the database: its settings, the seeds, making it, publishing it,
 * the scores and what they decide. The rules are in `draw.ts` and pure; this file reads and
 * writes rows in the order rule 8 asks for.
 */

const isCategoryFormat = (v: unknown): v is CategoryFormat => v === "groups_knockout" || v === "knockout";

async function ownCategory(db: Db, categoryId: string, organizerPlayerId: string): Promise<{ category: CompetitionCategory; competition: Competition }> {
  const [category] = await db.select().from(competitionCategories).where(eq(competitionCategories.id, categoryId)).limit(1);
  if (!category) throw new DomainError("not_found", "category");
  const [competition] = await db.select().from(competitions).where(eq(competitions.id, category.competitionId)).limit(1);
  if (!competition) throw new DomainError("not_found", "competition");
  if (!isOrganizer(competition, organizerPlayerId)) throw new DomainError("forbidden", "organizer");
  return { category, competition };
}

export type DrawSettings = {
  format?: string;
  groupSize?: number;
  groupsThrough?: number;
  consolation?: boolean;
  qualifyingSpots?: number;
  scoringGroup?: string;
  scoringKnockout?: string;
  scoringFinal?: string;
  goldenPoint?: boolean;
};

/** The draw's settings change until the draw is made; a made draw is cleared first. */
export async function updateDrawSettings(db: Db, input: DrawSettings & { categoryId: string; organizerPlayerId: string }): Promise<CompetitionCategory> {
  const { category } = await ownCategory(db, input.categoryId, input.organizerPlayerId);
  if (category.drawStatus !== "none") throw new DomainError("invalid", "drawn");
  const patch: Partial<typeof competitionCategories.$inferInsert> = {};
  if (input.format !== undefined) {
    if (!isCategoryFormat(input.format)) throw new DomainError("invalid", "format");
    patch.format = input.format;
  }
  if (input.groupSize !== undefined) {
    if (![3, 4, 5, 6].includes(input.groupSize)) throw new DomainError("invalid", "groupSize");
    patch.groupSize = input.groupSize;
  }
  if (input.groupsThrough !== undefined) {
    if (![1, 2, 3].includes(input.groupsThrough)) throw new DomainError("invalid", "groupsThrough");
    patch.groupsThrough = input.groupsThrough;
  }
  if (input.consolation !== undefined) patch.consolation = Boolean(input.consolation);
  if (input.qualifyingSpots !== undefined) {
    if (![0, 1, 2, 4, 8].includes(input.qualifyingSpots)) throw new DomainError("invalid", "qualifyingSpots");
    patch.qualifyingSpots = input.qualifyingSpots;
  }
  for (const k of ["scoringGroup", "scoringKnockout", "scoringFinal"] as const) {
    const v = input[k];
    if (v === undefined) continue;
    if (!isScoringCode(v)) throw new DomainError("invalid", k);
    patch[k] = v;
  }
  if (input.goldenPoint !== undefined) patch.goldenPoint = Boolean(input.goldenPoint);
  const size = patch.groupSize ?? category.groupSize;
  const through = patch.groupsThrough ?? category.groupsThrough;
  if (through >= size) throw new DomainError("invalid", "groupsThrough");
  const spots = patch.qualifyingSpots ?? category.qualifyingSpots;
  if (spots >= category.maxPairs) throw new DomainError("invalid", "qualifyingSpots");
  const [updated] = await db.update(competitionCategories).set(patch).where(eq(competitionCategories.id, category.id)).returning();
  return updated;
}

/** A seed number (1 is the strongest), or none, and the wildcard mark; the draw reads them when it is made. */
export async function setPairSeed(db: Db, input: { pairId: string; organizerPlayerId: string; seed: number | null; wildcard?: boolean }): Promise<void> {
  const [pair] = await db.select().from(competitionPairs).where(eq(competitionPairs.id, input.pairId)).limit(1);
  if (!pair) throw new DomainError("not_found", "pair");
  await ownCategory(db, pair.categoryId, input.organizerPlayerId);
  const seed = input.seed === null ? null : Number.isInteger(input.seed) && input.seed >= 1 && input.seed <= 64 ? input.seed : undefined;
  if (seed === undefined) throw new DomainError("invalid", "seed");
  await db
    .update(competitionPairs)
    .set({ seed, ...(input.wildcard === undefined ? {} : { wildcard: input.wildcard }) })
    .where(eq(competitionPairs.id, pair.id));
}

const matchesOf = (db: Db, categoryId: string) =>
  db
    .select()
    .from(competitionMatches)
    .where(eq(competitionMatches.categoryId, categoryId))
    .orderBy(asc(competitionMatches.phase), asc(competitionMatches.round), asc(competitionMatches.position));

const asLike = (m: CompetitionMatch): MatchLike => ({ ...m, pairA: m.pairAId, pairB: m.pairBId });

/** The groups as the matches show them: every pair that plays in a group's matches belongs to it. */
export function groupsFrom(matches: readonly CompetitionMatch[]): { label: string; pairIds: string[] }[] {
  const seen = new Map<string, string[]>();
  for (const m of matches) {
    if (m.phase !== "group" || !m.groupLabel) continue;
    const list = seen.get(m.groupLabel) ?? [];
    for (const id of [m.pairAId, m.pairBId]) if (id && !list.includes(id)) list.push(id);
    seen.set(m.groupLabel, list);
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, pairIds]) => ({ label, pairIds }));
}

/**
 * Writes what the results decide, until nothing moves: byes walk through, a winner takes the next
 * slot, a finished group sends its places on. When the main final is over, the category is done.
 */
export async function advanceCategory(db: Db, categoryId: string): Promise<number> {
  let total = 0;
  for (let i = 0; i < 12; i++) {
    const rows = await matchesOf(db, categoryId);
    const changes = progress(rows.map(asLike), groupsFrom(rows));
    if (changes.length === 0) break;
    for (const c of changes) {
      const patch: Partial<typeof competitionMatches.$inferInsert> = { updatedAt: new Date() };
      if (c.pairA !== undefined) patch.pairAId = c.pairA;
      if (c.pairB !== undefined) patch.pairBId = c.pairB;
      if (c.bye) patch.bye = true;
      if (c.status) patch.status = c.status;
      if (c.winner !== undefined) patch.winner = c.winner;
      await db.update(competitionMatches).set(patch).where(eq(competitionMatches.id, c.id));
    }
    total += changes.length;
  }
  const rows = await matchesOf(db, categoryId);
  const main = rows.filter((m) => m.phase === "main");
  const rounds = Math.max(0, ...main.map((m) => m.round));
  const final = main.find((m) => m.round === rounds);
  if (final && (final.status === "done" || final.status === "walkover")) await db.update(competitionCategories).set({ drawStatus: "done" }).where(and(eq(competitionCategories.id, categoryId), eq(competitionCategories.drawStatus, "published")));
  return total;
}

/**
 * The draw from the pairs in play: entered first, then the waiting list, seeds and wildcards as
 * the organiser set them. A draw that exists is replaced; a published one is cleared first.
 */
export async function makeDraw(db: Db, input: { categoryId: string; organizerPlayerId: string; now?: Date }): Promise<{ category: CompetitionCategory; matches: CompetitionMatch[] }> {
  const { category } = await ownCategory(db, input.categoryId, input.organizerPlayerId);
  if (category.drawStatus === "published" || category.drawStatus === "done") throw new DomainError("invalid", "published");
  const now = input.now ?? new Date();
  const pairs = await db
    .select()
    .from(competitionPairs)
    .where(and(eq(competitionPairs.categoryId, category.id), inArray(competitionPairs.status, ["entered", "waiting"])))
    .orderBy(asc(competitionPairs.status), asc(competitionPairs.position));
  if (pairs.length < 2) throw new DomainError("invalid", "few");
  const entrants = pairs.map((p, i) => ({ id: p.id, seed: p.seed, wildcard: p.wildcard, order: i + 1 }));
  const plan = planDraw(entrants, {
    format: category.format,
    maxPairs: category.maxPairs,
    groupSize: category.groupSize,
    groupsThrough: category.groupsThrough,
    consolation: category.consolation,
    qualifyingSpots: category.qualifyingSpots,
    seed: `${category.id}:${now.toISOString()}`,
  });
  await db.delete(competitionMatches).where(eq(competitionMatches.categoryId, category.id));
  if (plan.matches.length > 0) {
    await db.insert(competitionMatches).values(
      plan.matches.map((m) => ({
        categoryId: category.id,
        competitionId: category.competitionId,
        phase: m.phase,
        groupLabel: m.groupLabel,
        round: m.round,
        position: m.position,
        pairAId: m.pairA,
        pairBId: m.pairB,
        sourceA: m.sourceA,
        sourceB: m.sourceB,
        bye: m.bye,
      })),
    );
  }
  await advanceCategory(db, category.id);
  const [updated] = await db.update(competitionCategories).set({ drawStatus: "drawn", drawnAt: now }).where(eq(competitionCategories.id, category.id)).returning();
  await bumpMetric(db, "draw_made");
  return { category: updated, matches: await matchesOf(db, category.id) };
}

/** Published: the page shows it and the players hear. Nothing changes the draw after a score is in. */
export async function publishDraw(db: Db, input: { categoryId: string; organizerPlayerId: string }): Promise<CompetitionCategory> {
  const { category } = await ownCategory(db, input.categoryId, input.organizerPlayerId);
  if (category.drawStatus !== "drawn") throw new DomainError("invalid", "not_drawn");
  const [updated] = await db.update(competitionCategories).set({ drawStatus: "published" }).where(eq(competitionCategories.id, category.id)).returning();
  return updated;
}

/** Back to no draw: allowed until a score is entered. */
export async function clearDraw(db: Db, input: { categoryId: string; organizerPlayerId: string }): Promise<CompetitionCategory> {
  const { category } = await ownCategory(db, input.categoryId, input.organizerPlayerId);
  if (category.drawStatus === "none") return category;
  const rows = await matchesOf(db, category.id);
  if (rows.some((m) => m.scoreA !== null || m.status === "walkover")) throw new DomainError("invalid", "scored");
  await db.delete(competitionMatches).where(eq(competitionMatches.categoryId, category.id));
  const [updated] = await db.update(competitionCategories).set({ drawStatus: "none", drawnAt: null }).where(eq(competitionCategories.id, category.id)).returning();
  return updated;
}

const keyOf = (m: Pick<CompetitionMatch, "phase" | "round" | "position">) => `${m.phase}:${m.round}:${m.position}`;

/** A result is final once something built on it has a result of its own: the next round, the consolation, the knockout after a group. */
function lockedBy(rows: readonly CompetitionMatch[], m: CompetitionMatch): boolean {
  const started = (x: CompetitionMatch) => x.scoreA !== null || x.status === "walkover";
  if (m.phase === "group") return rows.some((x) => x.phase !== "group" && started(x) && [x.sourceA, x.sourceB].some((s) => s?.startsWith(`G:${m.groupLabel}:`)));
  const key = keyOf(m);
  return rows.some((x) => started(x) && [x.sourceA, x.sourceB].some((s) => s === `W:${key}` || s === `L:${key}`));
}

export type ScoreInput = { matchId: string; actorPlayerId: string; scoreA: number[]; scoreB: number[]; now?: Date };

/**
 * A score from the organiser or from a player of either pair, checked against the phase's
 * rule; then whatever it decides is written downstream. A score can be corrected until the
 * next match built on it has one.
 */
export async function enterMatchScore(db: Db, input: ScoreInput): Promise<CompetitionMatch> {
  const [m] = await db.select().from(competitionMatches).where(eq(competitionMatches.id, input.matchId)).limit(1);
  if (!m) throw new DomainError("not_found", "match");
  if (!m.pairAId || !m.pairBId || m.bye) throw new DomainError("invalid", "not_ready");
  const [category] = await db.select().from(competitionCategories).where(eq(competitionCategories.id, m.categoryId)).limit(1);
  const [competition] = await db.select().from(competitions).where(eq(competitions.id, m.competitionId)).limit(1);
  if (!category || !competition) throw new DomainError("not_found");
  if (category.drawStatus !== "published" && category.drawStatus !== "done") throw new DomainError("invalid", "not_published");
  if (!isOrganizer(competition, input.actorPlayerId)) {
    // A player of either pair may enter the score (rule 16's spirit); anyone else may not.
    const pairs = await db
      .select({ p1: competitionPairs.p1PlayerId, p2: competitionPairs.p2PlayerId })
      .from(competitionPairs)
      .where(inArray(competitionPairs.id, [m.pairAId, m.pairBId]));
    if (!pairs.some((p) => p.p1 === input.actorPlayerId || p.p2 === input.actorPlayerId)) throw new DomainError("forbidden");
  }
  const rows = await matchesOf(db, category.id);
  if (lockedBy(rows, m)) throw new DomainError("locked");
  const rounds = Math.max(0, ...rows.filter((x) => x.phase === "main").map((x) => x.round));
  const check = checkScore(scoringOfMatch(m, rounds, category), input.scoreA, input.scoreB);
  if (!check.ok) throw new DomainError("invalid", `score_${check.reason}`);
  const [updated] = await db
    .update(competitionMatches)
    .set({ scoreA: input.scoreA, scoreB: input.scoreB, winner: check.winner, status: "done", enteredByPlayerId: input.actorPlayerId, updatedAt: input.now ?? new Date() })
    .where(eq(competitionMatches.id, m.id))
    .returning();
  await advanceCategory(db, category.id);
  return updated;
}

/** A pair that does not play: the organiser gives the match to the other side. */
export async function walkoverMatch(db: Db, input: { matchId: string; organizerPlayerId: string; winner: "A" | "B" }): Promise<CompetitionMatch> {
  const [m] = await db.select().from(competitionMatches).where(eq(competitionMatches.id, input.matchId)).limit(1);
  if (!m) throw new DomainError("not_found", "match");
  const { category } = await ownCategory(db, m.categoryId, input.organizerPlayerId);
  if (category.drawStatus !== "published" && category.drawStatus !== "done") throw new DomainError("invalid", "not_published");
  if (!m.pairAId || !m.pairBId || m.bye) throw new DomainError("invalid", "not_ready");
  const rows = await matchesOf(db, category.id);
  if (lockedBy(rows, m)) throw new DomainError("locked");
  const [updated] = await db
    .update(competitionMatches)
    .set({ scoreA: null, scoreB: null, winner: input.winner, status: "walkover", enteredByPlayerId: input.organizerPlayerId, updatedAt: new Date() })
    .where(eq(competitionMatches.id, m.id))
    .returning();
  await advanceCategory(db, category.id);
  return updated;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export type PairName = { id: string; name: string; seed: number | null };
export type MatchView = CompetitionMatch & { a: PairName | null; b: PairName | null; scoring: string };
export type GroupView = { label: string; table: (TableRow & { name: string; seed: number | null })[]; matches: MatchView[]; complete: boolean };
export type DrawView = {
  category: CompetitionCategory;
  groups: GroupView[];
  /** The knockout phases, each as rounds of matches. */
  qualifying: MatchView[][];
  main: MatchView[][];
  consolation: MatchView[][];
  champion: PairName | null;
  consolationWinner: PairName | null;
};

const byRounds = (ms: MatchView[]): MatchView[][] => {
  const out: MatchView[][] = [];
  for (const m of ms) (out[m.round - 1] ??= []).push(m);
  return out.filter(Boolean);
};

/** Every draw of a competition, two reads: the matches, and the pairs with their names. */
export async function competitionDraws(db: Db, competitionId: string, categories: readonly CompetitionCategory[]): Promise<Map<string, DrawView>> {
  const out = new Map<string, DrawView>();
  const drawn = categories.filter((c) => c.drawStatus !== "none");
  if (drawn.length === 0) return out;
  const rows = await db
    .select()
    .from(competitionMatches)
    .where(eq(competitionMatches.competitionId, competitionId))
    .orderBy(asc(competitionMatches.round), asc(competitionMatches.position));
  const p1 = alias(players, "p1");
  const p2 = alias(players, "p2");
  const pairRows = await db
    .select({ id: competitionPairs.id, seed: competitionPairs.seed, categoryId: competitionPairs.categoryId, n1: p1.displayName, n2: p2.displayName })
    .from(competitionPairs)
    .innerJoin(p1, eq(p1.id, competitionPairs.p1PlayerId))
    .innerJoin(p2, eq(p2.id, competitionPairs.p2PlayerId))
    .where(eq(competitionPairs.competitionId, competitionId));
  const names = new Map<string, PairName>(pairRows.map((p) => [p.id, { id: p.id, name: `${p.n1} & ${p.n2}`, seed: p.seed }]));
  const name = (id: string | null) => (id ? (names.get(id) ?? { id, name: "?", seed: null }) : null);
  for (const category of drawn) {
    const mine = rows.filter((m) => m.categoryId === category.id);
    const rounds = Math.max(0, ...mine.filter((m) => m.phase === "main").map((m) => m.round));
    const view = (m: CompetitionMatch): MatchView => ({ ...m, a: name(m.pairAId), b: name(m.pairBId), scoring: scoringOfMatch(m, rounds, category) });
    const groups = groupsFrom(mine).map((g) => {
      const gm = mine.filter((m) => m.phase === "group" && m.groupLabel === g.label);
      const table = groupTable(g.pairIds, gm.map(asLike)).map((r) => ({ ...r, name: name(r.pairId)?.name ?? "?", seed: name(r.pairId)?.seed ?? null }));
      return { label: g.label, table, matches: gm.map(view), complete: gm.every((m) => m.status === "done" || m.status === "walkover" || m.bye) };
    });
    const main = byRounds(mine.filter((m) => m.phase === "main").map(view));
    const consolation = byRounds(mine.filter((m) => m.phase === "consolation").map(view));
    const last = (phase: MatchView[][]) => {
      const f = phase.at(-1)?.[0];
      if (!f || !f.winner) return null;
      return f.winner === "A" ? f.a : f.b;
    };
    out.set(category.id, { category, groups, qualifying: byRounds(mine.filter((m) => m.phase === "qualifying").map(view)), main, consolation, champion: last(main), consolationWinner: last(consolation) });
  }
  return out;
}

/** The scoring rule one match plays under, or null when there is no such match. */
export async function matchRule(db: Db, matchId: string): Promise<{ code: ScoringCode; categoryId: string } | null> {
  const [m] = await db.select().from(competitionMatches).where(eq(competitionMatches.id, matchId)).limit(1);
  if (!m) return null;
  const [category] = await db.select().from(competitionCategories).where(eq(competitionCategories.id, m.categoryId)).limit(1);
  if (!category) return null;
  const rows = await matchesOf(db, category.id);
  const rounds = Math.max(0, ...rows.filter((x) => x.phase === "main").map((x) => x.round));
  return { code: scoringOfMatch(m, rounds, category), categoryId: category.id };
}
