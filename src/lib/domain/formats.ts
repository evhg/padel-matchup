import type { TournamentFormat } from "@/db/schema";
import { buildHistory, computeStandings, maxCourtsFor, type History, type MatchRef, type Pairing, type RoundPlan, type StandingRow } from "./americano";
import { DomainError } from "./errors";

/**
 * Tournament formats beyond the americano rotation.
 *
 * - mexicano: round 1 is random; from round 2 the courts are formed by the
 *   standings (top four on court 1, next four on court 2, …) and inside a
 *   court 1st+4th play 2nd+3rd. Scores must be in before the next round.
 * - king (King of the Court): winners move up a court, losers move down,
 *   the top court's winners and the bottom court's losers stay. Partners
 *   split every round. Standings follow the court you finish on.
 *
 * Both work for any field of four or more: sit-outs rotate fairly and
 * return at the bottom of the ladder.
 */
export const FORMATS: readonly TournamentFormat[] = ["americano", "mexicano", "king"];

export const formatOf = (f: string | null | undefined): TournamentFormat => (f === "mexicano" || f === "king" ? f : "americano");

/** Points per match that make the format work out of the box (organizers can still change it). */
export const DEFAULT_POINTS: Record<TournamentFormat, number | null> = { americano: null, mexicano: 24, king: null };

export type CourtMatch = MatchRef & { court: number };
export type CourtRound = { matches: CourtMatch[]; resting: string[] };

const pairKey = (p: string, q: string) => (p < q ? `${p}|${q}` : `${q}|${p}`);

function shuffle<T>(arr: readonly T[], rnd: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The scores of every match in the round are in. */
export const roundScored = (r: { matches: readonly MatchRef[] }) => r.matches.every((m) => m.sideA != null && m.sideB != null);

/** Cheapest of the three ways to split four players into two pairs: repeating a partner weighs triple. */
export function bestSplit(four: readonly string[], history: History, rnd: () => number): { a: [string, string]; b: [string, string] } {
  if (four.length !== 4) throw new Error("bestSplit needs four players");
  const partner = (p: string, q: string) => history.partner.get(pairKey(p, q)) ?? 0;
  const opponent = (p: string, q: string) => history.opponent.get(pairKey(p, q)) ?? 0;
  const options: [[number, number], [number, number]][] = [
    [
      [0, 1],
      [2, 3],
    ],
    [
      [0, 2],
      [1, 3],
    ],
    [
      [0, 3],
      [1, 2],
    ],
  ];
  let best: { a: [string, string]; b: [string, string] } | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const [x, y] of shuffle(options, rnd)) {
    const a: [string, string] = [four[x[0]], four[x[1]]];
    const b: [string, string] = [four[y[0]], four[y[1]]];
    const cost = 3 * (partner(a[0], a[1]) + partner(b[0], b[1])) + opponent(a[0], b[0]) + opponent(a[0], b[1]) + opponent(a[1], b[0]) + opponent(a[1], b[1]);
    if (cost < bestCost) {
      bestCost = cost;
      best = { a, b };
    }
  }
  return best!;
}

/** Sit-outs: fewest rests so far, then random. */
function pickResting(ids: readonly string[], history: History, count: number, rnd: () => number): string[] {
  if (count <= 0) return [];
  return shuffle(ids, rnd)
    .map((p, i) => ({ p, rested: history.rested.get(p) ?? 0, i }))
    .sort((x, y) => x.rested - y.rested || x.i - y.i)
    .slice(0, count)
    .map((x) => x.p);
}

function courtsFor(n: number, courts: number | null | undefined): number {
  const max = maxCourtsFor(n);
  return Math.max(1, Math.min(courts ?? max, max));
}

/** Round 1 of mexicano and king: random courts, random partners. */
function randomRound(ids: readonly string[], courts: number | null | undefined, history: History, rnd: () => number): RoundPlan {
  const c = courtsFor(ids.length, courts);
  const resting = pickResting(ids, history, ids.length - 4 * c, rnd);
  const rest = new Set(resting);
  const active = shuffle(
    ids.filter((p) => !rest.has(p)),
    rnd,
  );
  const matches: Pairing[] = [];
  for (let i = 0; i < c; i++) {
    const four = active.slice(i * 4, i * 4 + 4);
    matches.push({ court: i + 1, ...bestSplit(four, history, rnd) });
  }
  return { matches, resting };
}

/** Standings order restricted to the given players; players without a row go last. */
function rankedOrder(ids: readonly string[], standings: readonly StandingRow[]): string[] {
  const set = new Set(ids);
  const ranked = standings.map((r) => r.playerId).filter((p) => set.has(p));
  const seen = new Set(ranked);
  return [...ranked, ...ids.filter((p) => !seen.has(p))];
}

/**
 * Mexicano: courts by standings, 1st+4th against 2nd+3rd on each court.
 * Throws `scores_missing` when the previous round is not fully scored.
 */
export function planMexicanoRound(input: { ids: readonly string[]; courts?: number | null; rounds: readonly CourtRound[]; rnd?: () => number }): RoundPlan {
  const rnd = input.rnd ?? Math.random;
  const ids = [...new Set(input.ids)];
  if (ids.length < 4) throw new DomainError("invalid", "need_4_players");
  const history = buildHistory(input.rounds.map((r) => ({ matches: r.matches, resting: r.resting })));
  if (input.rounds.length === 0) return randomRound(ids, input.courts, history, rnd);
  if (!roundScored(input.rounds.at(-1)!)) throw new DomainError("invalid", "scores_missing");
  const standings = computeStandings(
    ids,
    input.rounds.flatMap((r) => r.matches),
  );
  const c = courtsFor(ids.length, input.courts);
  const resting = pickResting(ids, history, ids.length - 4 * c, rnd);
  const rest = new Set(resting);
  const active = rankedOrder(ids, standings).filter((p) => !rest.has(p));
  const matches: Pairing[] = [];
  for (let i = 0; i < c; i++) {
    const [p1, p2, p3, p4] = active.slice(i * 4, i * 4 + 4);
    matches.push({ court: i + 1, a: [p1, p4], b: [p2, p3] });
  }
  return { matches, resting };
}

type Candidate = { p: string; priority: number; points: number; rested: number };

/**
 * King of the Court: winners up, losers down, partners split. Sit-outs and
 * newcomers enter at the bottom court. Throws `scores_missing` when the
 * previous round is not fully scored.
 */
export function planKingRound(input: { ids: readonly string[]; courts?: number | null; rounds: readonly CourtRound[]; rnd?: () => number }): RoundPlan {
  const rnd = input.rnd ?? Math.random;
  const ids = [...new Set(input.ids)];
  if (ids.length < 4) throw new DomainError("invalid", "need_4_players");
  const history = buildHistory(input.rounds.map((r) => ({ matches: r.matches, resting: r.resting })));
  if (input.rounds.length === 0) return randomRound(ids, input.courts, history, rnd);
  const last = input.rounds.at(-1)!;
  if (!roundScored(last)) throw new DomainError("invalid", "scores_missing");
  const standings = computeStandings(
    ids,
    input.rounds.flatMap((r) => r.matches),
  );
  const points = new Map(standings.map((r) => [r.playerId, r.points]));
  const k = courtsFor(ids.length, input.courts);
  const present = new Set(ids);

  // Where everyone wants to go. Priority within a court: came up (3), stayed (2), came down (1), returning or new (0).
  const targets = new Map<number, Candidate[]>();
  const place = (p: string, court: number, priority: number) => {
    if (!present.has(p)) return;
    const c = Math.max(1, Math.min(k, court));
    const list = targets.get(c) ?? [];
    list.push({ p, priority, points: points.get(p) ?? 0, rested: history.rested.get(p) ?? 0 });
    targets.set(c, list);
  };
  const seen = new Set<string>();
  for (const m of last.matches) {
    const a = [m.a1, m.a2];
    const b = [m.b1, m.b2];
    let aWins: boolean;
    if (m.sideA! !== m.sideB!) aWins = m.sideA! > m.sideB!;
    else {
      const sum = (t: string[]) => t.reduce((s, p) => s + (points.get(p) ?? 0), 0);
      aWins = sum(a) !== sum(b) ? sum(a) > sum(b) : rnd() < 0.5;
    }
    const winners = aWins ? a : b;
    const losers = aWins ? b : a;
    for (const p of winners) {
      seen.add(p);
      if (m.court === 1) place(p, 1, 2);
      else place(p, m.court - 1, 3);
    }
    for (const p of losers) {
      seen.add(p);
      if (m.court >= k) place(p, k, 2);
      else place(p, m.court + 1, 1);
    }
  }
  for (const p of ids) if (!seen.has(p)) place(p, k, 0);

  // Every court takes exactly four: extras slide down, gaps pull from below; the bottom court's extras sit out (fewest rests first).
  const byPriority = (x: Candidate, y: Candidate) => y.priority - x.priority || y.points - x.points || x.p.localeCompare(y.p);
  const courts: string[][] = [];
  let carry: Candidate[] = [];
  for (let c = 1; c <= k; c++) {
    let pool = [...(targets.get(c) ?? []), ...carry].sort(byPriority);
    carry = [];
    if (pool.length < 4) {
      // Pull the best-placed candidates up from the courts below.
      for (let d = c + 1; d <= k && pool.length < 4; d++) {
        const below = (targets.get(d) ?? []).sort(byPriority);
        while (below.length && pool.length < 4) pool.push(below.shift()!);
        targets.set(d, below);
      }
      pool = pool.sort(byPriority);
    }
    if (c === k && pool.length > 4) {
      const extra = pool.length - 4;
      const resting = [...pool].sort((x, y) => x.rested - y.rested || x.priority - y.priority || x.points - y.points || x.p.localeCompare(y.p)).slice(0, extra);
      const restSet = new Set(resting.map((x) => x.p));
      courts.push(pool.filter((x) => !restSet.has(x.p)).map((x) => x.p));
      carry = resting;
      break;
    }
    courts.push(pool.slice(0, 4).map((x) => x.p));
    carry = pool.slice(4);
  }
  const resting = carry.map((x) => x.p);
  const matches: Pairing[] = courts.map((four, i) => ({ court: i + 1, ...bestSplit(four, history, rnd) }));
  return { matches, resting };
}

export type KingStandingRow = StandingRow & { court: number | null };

/**
 * King of the Court ranks by the court you finish on, winners of that court
 * first; points and difference break the ties. Players who sat out the last
 * round follow everyone who played it.
 */
export function computeKingStandings(ids: readonly string[], rounds: readonly CourtRound[]): KingStandingRow[] {
  const base = computeStandings(
    ids,
    rounds.flatMap((r) => r.matches),
  );
  const last = rounds.at(-1);
  const court = new Map<string, number>();
  const wonLast = new Map<string, number>();
  if (last) {
    for (const m of last.matches) {
      for (const p of [m.a1, m.a2, m.b1, m.b2]) court.set(p, m.court);
      if (m.sideA != null && m.sideB != null && m.sideA !== m.sideB) {
        for (const p of m.sideA > m.sideB ? [m.a1, m.a2] : [m.b1, m.b2]) wonLast.set(p, 1);
      }
    }
  }
  const order = new Map(base.map((r, i) => [r.playerId, i]));
  const rows: KingStandingRow[] = base.map((r) => ({ ...r, court: court.get(r.playerId) ?? null }));
  rows.sort((x, y) => {
    const cx = x.court ?? Number.POSITIVE_INFINITY;
    const cy = y.court ?? Number.POSITIVE_INFINITY;
    return cx - cy || (wonLast.get(y.playerId) ?? 0) - (wonLast.get(x.playerId) ?? 0) || order.get(x.playerId)! - order.get(y.playerId)!;
  });
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  return rows;
}
