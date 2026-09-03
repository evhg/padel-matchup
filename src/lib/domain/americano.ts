import { DomainError } from "./errors";

/**
 * Americano engine (pure functions, no I/O).
 *
 * Each round puts 4 players per court in rotating-partner doubles. Players
 * beyond `courts * 4` sit out; sit-outs are spread fairly. Pairings minimise
 * repeated partners first and repeated opponents second. Standings are the
 * sum of points scored by each player across all scored matches.
 */

export type MatchRef = { a1: string; a2: string; b1: string; b2: string; sideA: number | null; sideB: number | null };
export type RoundRef = { matches: MatchRef[]; resting: string[] };
export type Pairing = { court: number; a: [string, string]; b: [string, string] };
export type RoundPlan = { matches: Pairing[]; resting: string[] };

export type History = {
  partner: Map<string, number>;
  opponent: Map<string, number>;
  played: Map<string, number>;
  rested: Map<string, number>;
};

const pairKey = (p: string, q: string) => (p < q ? `${p}|${q}` : `${q}|${p}`);
const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

export function buildHistory(rounds: RoundRef[]): History {
  const h: History = { partner: new Map(), opponent: new Map(), played: new Map(), rested: new Map() };
  for (const r of rounds) {
    for (const m of r.matches) {
      inc(h.partner, pairKey(m.a1, m.a2));
      inc(h.partner, pairKey(m.b1, m.b2));
      for (const x of [m.a1, m.a2]) for (const y of [m.b1, m.b2]) inc(h.opponent, pairKey(x, y));
      for (const p of [m.a1, m.a2, m.b1, m.b2]) inc(h.played, p);
    }
    for (const p of r.resting) inc(h.rested, p);
  }
  return h;
}

/** Small deterministic PRNG so round generation is reproducible in tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shuffle<T>(arr: readonly T[], rnd: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const maxCourtsFor = (players: number) => Math.floor(players / 4);

export function planRound(playerIds: readonly string[], courts: number | null | undefined, history: History, rnd: () => number = Math.random, attempts = 400): RoundPlan {
  const players = [...new Set(playerIds)];
  const n = players.length;
  if (n < 4) throw new DomainError("invalid", "need_4_players");
  const maxCourts = maxCourtsFor(n);
  const c = Math.max(1, Math.min(courts ?? maxCourts, maxCourts));
  const restCount = n - c * 4;

  // Who sits out: fewest sit-outs so far, then most matches played, then random.
  const shuffled = shuffle(players, rnd);
  const resting = shuffled
    .map((p, i) => ({ p, rested: history.rested.get(p) ?? 0, played: history.played.get(p) ?? 0, i }))
    .sort((x, y) => x.rested - y.rested || y.played - x.played || x.i - y.i)
    .slice(0, restCount)
    .map((x) => x.p);
  const restingSet = new Set(resting);
  const active = shuffled.filter((p) => !restingSet.has(p));

  const partnerCost = (p: string, q: string) => history.partner.get(pairKey(p, q)) ?? 0;
  const opponentCost = (p: string, q: string) => history.opponent.get(pairKey(p, q)) ?? 0;
  const matchCost = (m: Pairing) =>
    3 * (partnerCost(m.a[0], m.a[1]) + partnerCost(m.b[0], m.b[1])) +
    opponentCost(m.a[0], m.b[0]) +
    opponentCost(m.a[0], m.b[1]) +
    opponentCost(m.a[1], m.b[0]) +
    opponentCost(m.a[1], m.b[1]);

  let best: Pairing[] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pool = shuffle(active, rnd);
    const teams: [string, string][] = [];
    while (pool.length) {
      const p = pool.shift()!;
      let bi = 0;
      let bc = Number.POSITIVE_INFINITY;
      for (let i = 0; i < pool.length; i++) {
        const cost = partnerCost(p, pool[i]);
        if (cost < bc) {
          bc = cost;
          bi = i;
        }
      }
      teams.push([p, pool.splice(bi, 1)[0]]);
    }
    const matches: Pairing[] = [];
    let court = 1;
    while (teams.length) {
      const t1 = teams.shift()!;
      let bi = 0;
      let bc = Number.POSITIVE_INFINITY;
      for (let i = 0; i < teams.length; i++) {
        const t2 = teams[i];
        const cost = opponentCost(t1[0], t2[0]) + opponentCost(t1[0], t2[1]) + opponentCost(t1[1], t2[0]) + opponentCost(t1[1], t2[1]);
        if (cost < bc) {
          bc = cost;
          bi = i;
        }
      }
      matches.push({ court: court++, a: t1, b: teams.splice(bi, 1)[0] });
    }
    const score = matches.reduce((s, m) => s + matchCost(m), 0);
    if (score < bestScore) {
      bestScore = score;
      best = matches;
      if (score === 0) break;
    }
  }
  return { matches: best!, resting };
}

export type StandingRow = {
  playerId: string;
  rank: number;
  points: number;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  diff: number;
};

/** Points scored, then point difference, then wins. Equal on all three → shared rank. */
export function computeStandings(playerIds: readonly string[], matches: readonly MatchRef[]): StandingRow[] {
  const rows = new Map<string, StandingRow>();
  const row = (p: string) => {
    let r = rows.get(p);
    if (!r) {
      r = { playerId: p, rank: 0, points: 0, played: 0, wins: 0, losses: 0, draws: 0, diff: 0 };
      rows.set(p, r);
    }
    return r;
  };
  for (const p of playerIds) row(p);
  for (const m of matches) {
    if (m.sideA == null || m.sideB == null) continue;
    const apply = (p: string, mine: number, theirs: number) => {
      const r = row(p);
      r.points += mine;
      r.played += 1;
      r.diff += mine - theirs;
      if (mine > theirs) r.wins += 1;
      else if (mine < theirs) r.losses += 1;
      else r.draws += 1;
    };
    apply(m.a1, m.sideA, m.sideB);
    apply(m.a2, m.sideA, m.sideB);
    apply(m.b1, m.sideB, m.sideA);
    apply(m.b2, m.sideB, m.sideA);
  }
  const sorted = [...rows.values()].sort((x, y) => y.points - x.points || y.diff - x.diff || y.wins - x.wins || x.playerId.localeCompare(y.playerId));
  let prev: StandingRow | null = null;
  sorted.forEach((r, i) => {
    r.rank = prev && prev.points === r.points && prev.diff === r.diff && prev.wins === r.wins ? prev.rank : i + 1;
    prev = r;
  });
  return sorted;
}

/** Suggested points-per-match presets (classic americano formats). */
export const POINTS_PRESETS = [16, 21, 24, 32] as const;
