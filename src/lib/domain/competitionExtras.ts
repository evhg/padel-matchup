import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import { competitionCategories, competitionMatches, competitionPairs, competitions, players, type Competition, type CompetitionMatch, type CompetitionPair } from "@/db/schema";
import { isOrganizer } from "./competitions";
import type { PlayRow } from "./competitionSchedule";
import { scoreText } from "./draw";
import { DomainError } from "./errors";

/**
 * What a big event asks for on top: a stream link on a match (rule 26: we link, we never host),
 * the desk's check-in mark, the lucky loser who takes a withdrawn pair's place in the draw, the
 * results as a file, and a ranking across the editions that share a series tag.
 */

export const EXTRAS = { urlMax: 300, tagMax: 40 } as const;

async function ownMatch(db: Db, matchId: string, organizerPlayerId: string): Promise<{ match: CompetitionMatch; competition: Competition }> {
  const [match] = await db.select().from(competitionMatches).where(eq(competitionMatches.id, matchId)).limit(1);
  if (!match) throw new DomainError("not_found", "match");
  const [competition] = await db.select().from(competitions).where(eq(competitions.id, match.competitionId)).limit(1);
  if (!competition) throw new DomainError("not_found", "competition");
  if (!isOrganizer(competition, organizerPlayerId)) throw new DomainError("forbidden", "organizer");
  return { match, competition };
}

/** A https link to wherever the organiser streams; the page and the screen show "Watch live". Empty clears it. */
export async function setStreamUrl(db: Db, input: { matchId: string; organizerPlayerId: string; url: string | null }): Promise<CompetitionMatch> {
  const { match } = await ownMatch(db, input.matchId, input.organizerPlayerId);
  const raw = (input.url ?? "").trim();
  let url: string | null = null;
  if (raw) {
    if (raw.length > EXTRAS.urlMax) throw new DomainError("invalid", "url");
    try {
      const u = new URL(raw);
      if (u.protocol !== "https:") throw new Error("scheme");
      url = u.toString();
    } catch {
      throw new DomainError("invalid", "url");
    }
  }
  const [updated] = await db.update(competitionMatches).set({ streamUrl: url, updatedAt: new Date() }).where(eq(competitionMatches.id, match.id)).returning();
  return updated;
}

/** The desk's mark on the day: the pair is here. */
export async function setCheckedIn(db: Db, input: { pairId: string; organizerPlayerId: string; on: boolean; now?: Date }): Promise<CompetitionPair> {
  const [pair] = await db.select().from(competitionPairs).where(eq(competitionPairs.id, input.pairId)).limit(1);
  if (!pair) throw new DomainError("not_found", "pair");
  const [competition] = await db.select().from(competitions).where(eq(competitions.id, pair.competitionId)).limit(1);
  if (!competition || !isOrganizer(competition, input.organizerPlayerId)) throw new DomainError("forbidden", "organizer");
  const [updated] = await db
    .update(competitionPairs)
    .set({ checkedInAt: input.on ? (input.now ?? new Date()) : null })
    .where(eq(competitionPairs.id, pair.id))
    .returning();
  return updated;
}

export type LuckyLoser = { replacement: CompetitionPair | null; matches: number };

/**
 * A pair out of a made draw: the first pair waiting takes its place in every match still to play;
 * with nobody waiting, those matches become byes and the other side goes through. Results already
 * played stand. The caller advances the category afterwards.
 */
export async function luckyLoser(db: Db, input: { categoryId: string; withdrawnPairId: string; /** The pair `withdrawPair` already moved up from the waiting list, when it did. */ replacementId?: string | null }): Promise<LuckyLoser> {
  const [category] = await db.select().from(competitionCategories).where(eq(competitionCategories.id, input.categoryId)).limit(1);
  if (!category || category.drawStatus === "none") return { replacement: null, matches: 0 };
  let replacement: CompetitionPair | null = null;
  if (input.replacementId) {
    replacement = (await db.select().from(competitionPairs).where(eq(competitionPairs.id, input.replacementId)).limit(1))[0] ?? null;
  } else {
    const [next] = await db
      .select()
      .from(competitionPairs)
      .where(and(eq(competitionPairs.categoryId, category.id), eq(competitionPairs.status, "waiting")))
      .orderBy(asc(competitionPairs.position))
      .limit(1);
    replacement = next ? (await db.update(competitionPairs).set({ status: "entered" }).where(eq(competitionPairs.id, next.id)).returning())[0] : null;
  }
  const open = await db
    .select()
    .from(competitionMatches)
    .where(and(eq(competitionMatches.categoryId, category.id), inArray(competitionMatches.status, ["pending", "scheduled", "live"])));
  let touched = 0;
  for (const m of open) {
    const sideA = m.pairAId === input.withdrawnPairId;
    const sideB = m.pairBId === input.withdrawnPairId;
    if (!sideA && !sideB) continue;
    touched++;
    if (replacement) {
      await db.update(competitionMatches).set(sideA ? { pairAId: replacement.id } : { pairBId: replacement.id }).where(eq(competitionMatches.id, m.id));
    } else {
      // Nobody to take the place: the other side walks through, or the match is empty.
      const other = sideA ? m.pairBId : m.pairAId;
      await db
        .update(competitionMatches)
        .set({ ...(sideA ? { pairAId: null, sourceA: null } : { pairBId: null, sourceB: null }), bye: true, status: "done", winner: other ? (sideA ? "B" : "A") : null, updatedAt: new Date() })
        .where(eq(competitionMatches.id, m.id));
    }
  }
  return { replacement, matches: touched };
}

export type ResultsLabels = { category: string; phase: string; round: string; when: string; court: string; a: string; b: string; score: string; winner: string };

const csvCell = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Every match with a result or a time, one line each, for a spreadsheet. */
export function resultsCsv(rows: readonly PlayRow[], tz: string, labels: ResultsLabels): string {
  const when = (d: Date | null) => (d ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d) : "");
  const head = [labels.category, labels.phase, labels.round, labels.when, labels.court, labels.a, labels.b, labels.score, labels.winner];
  const lines = rows
    .filter((m) => !m.bye)
    .map((m) => [m.categoryName, m.phase, m.round, when(m.scheduledAt), m.courtName, m.aName, m.bName, m.status === "walkover" ? "w/o" : scoreText(m.scoreA, m.scoreB), m.winner === "A" ? m.aName : m.winner === "B" ? m.bName : ""].map(csvCell).join(","));
  return [head.map(csvCell).join(","), ...lines].join("\n") + "\n";
}

/** Points for the deepest round reached in a category's main draw, and a bonus for the consolation winner. */
export const RANKING_POINTS = { champion: 100, finalist: 60, semi: 35, quarter: 20, of16: 10, of32: 5, played: 2, consolationWinner: 15 } as const;

export type RankingRow = { playerId: string; name: string; points: number; podiums: number; editions: number };

/**
 * A ranking across the competitions that share a series tag: every finished category gives each
 * pair points for the round it reached, and both players of the pair carry them.
 */
export async function seriesRanking(db: Db, seriesTag: string): Promise<{ competitions: Competition[]; rows: RankingRow[] }> {
  const tag = seriesTag.trim();
  if (!tag) return { competitions: [], rows: [] };
  const comps = await db.select().from(competitions).where(eq(competitions.seriesTag, tag)).orderBy(desc(competitions.startsOn));
  if (comps.length === 0) return { competitions: [], rows: [] };
  const compIds = comps.map((c) => c.id);
  const categories = await db.select().from(competitionCategories).where(and(inArray(competitionCategories.competitionId, compIds), eq(competitionCategories.drawStatus, "done")));
  if (categories.length === 0) return { competitions: comps, rows: [] };
  const matches = await db
    .select()
    .from(competitionMatches)
    .where(inArray(competitionMatches.categoryId, categories.map((c) => c.id)));
  const p1 = alias(players, "p1");
  const p2 = alias(players, "p2");
  const pairRows = await db
    .select({ id: competitionPairs.id, competitionId: competitionPairs.competitionId, p1: competitionPairs.p1PlayerId, p2: competitionPairs.p2PlayerId, n1: p1.displayName, n2: p2.displayName })
    .from(competitionPairs)
    .innerJoin(p1, eq(p1.id, competitionPairs.p1PlayerId))
    .innerJoin(p2, eq(p2.id, competitionPairs.p2PlayerId))
    .where(inArray(competitionPairs.competitionId, compIds));
  const pairs = new Map(pairRows.map((p) => [p.id, p]));
  const tally = new Map<string, RankingRow & { comps: Set<string> }>();
  const add = (pairId: string, points: number, podium: boolean) => {
    const pair = pairs.get(pairId);
    if (!pair) return;
    for (const [id, name] of [
      [pair.p1, pair.n1],
      [pair.p2, pair.n2],
    ] as const) {
      const row = tally.get(id) ?? { playerId: id, name, points: 0, podiums: 0, editions: 0, comps: new Set<string>() };
      row.points += points;
      if (podium) row.podiums++;
      row.comps.add(pair.competitionId);
      tally.set(id, row);
    }
  };
  for (const c of categories) {
    const main = matches.filter((m) => m.categoryId === c.id && m.phase === "main");
    const rounds = Math.max(0, ...main.map((m) => m.round));
    // The deepest round each pair reached: the round of its last main-draw match, one more for a winner.
    const deepest = new Map<string, number>();
    for (const m of main) {
      for (const [side, id] of [
        ["A", m.pairAId],
        ["B", m.pairBId],
      ] as const) {
        if (!id) continue;
        const reached = m.winner === side ? m.round + 1 : m.round;
        deepest.set(id, Math.max(deepest.get(id) ?? 0, reached));
      }
    }
    for (const [pairId, reached] of deepest) {
      const fromEnd = rounds + 1 - reached; // 0 = champion, 1 = lost the final, 2 = lost a semi …
      const points = fromEnd === 0 ? RANKING_POINTS.champion : fromEnd === 1 ? RANKING_POINTS.finalist : fromEnd === 2 ? RANKING_POINTS.semi : fromEnd === 3 ? RANKING_POINTS.quarter : fromEnd === 4 ? RANKING_POINTS.of16 : fromEnd === 5 ? RANKING_POINTS.of32 : RANKING_POINTS.played;
      add(pairId, points, fromEnd <= 2);
    }
    // Everyone who played and never reached the main draw: the points for taking part.
    for (const m of matches.filter((x) => x.categoryId === c.id && x.phase !== "main")) for (const id of [m.pairAId, m.pairBId]) if (id && !deepest.has(id)) {
      deepest.set(id, 0);
      add(id, RANKING_POINTS.played, false);
    }
    const cons = matches.filter((m) => m.categoryId === c.id && m.phase === "consolation");
    const consRounds = Math.max(0, ...cons.map((m) => m.round));
    const consFinal = cons.find((m) => m.round === consRounds && consRounds > 0);
    const consWinner = consFinal?.winner === "A" ? consFinal.pairAId : consFinal?.winner === "B" ? consFinal.pairBId : null;
    if (consWinner) add(consWinner, RANKING_POINTS.consolationWinner, false);
  }
  const rows = [...tally.values()].map((r) => ({ playerId: r.playerId, name: r.name, points: r.points, podiums: r.podiums, editions: r.comps.size })).sort((a, b) => b.points - a.points || b.podiums - a.podiums || a.name.localeCompare(b.name));
  return { competitions: comps, rows };
}
