import type { CategoryFormat, MatchPhase } from "@/db/schema";
import { mulberry32, seededShuffle, seedFrom } from "./americano";

/**
 * The draw of a category, pure: the scoring rules per phase and the check of a score against
 * them; the plan (qualifying, groups, the knockout skeleton, the consolation skeleton) from the
 * entrants and the settings; the group tables; and the progression that fills a later match from
 * an earlier result. Nothing here touches the database, so every rule is proven in
 * `tests/draw.test.ts` at the speed of a function call.
 */

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type ScoringCode = "set6tb" | "set9" | "sets2stb" | "sets3";
export type ScoringRule = {
  /** One set, or the best of three. */
  sets: 1 | 3;
  /** Games to win a set. */
  to: number;
  /** A tie-break at this score, decided by one game: 6-6 → 7-6, 8-8 → 9-8. */
  tiebreakAt: number;
  /** Best of three with a super tie-break to ten as the third set. */
  superTiebreak: boolean;
  /** What the schedule allows for one match. */
  minutes: number;
};

export const SCORING: Record<ScoringCode, ScoringRule> = {
  set6tb: { sets: 1, to: 6, tiebreakAt: 6, superTiebreak: false, minutes: 30 },
  set9: { sets: 1, to: 9, tiebreakAt: 8, superTiebreak: false, minutes: 40 },
  sets2stb: { sets: 3, to: 6, tiebreakAt: 6, superTiebreak: true, minutes: 75 },
  sets3: { sets: 3, to: 6, tiebreakAt: 6, superTiebreak: false, minutes: 90 },
};
export const SCORING_CODES = Object.keys(SCORING) as ScoringCode[];
export const isScoringCode = (v: unknown): v is ScoringCode => typeof v === "string" && v in SCORING;
export const scoringOr = (v: string | null | undefined, fallback: ScoringCode): ScoringCode => (isScoringCode(v) ? v : fallback);

/** A set that is over: to games with two clear, or the tie-break game after tiebreakAt-all. */
function completeSet(x: number, y: number, r: ScoringRule): boolean {
  const w = Math.max(x, y);
  const l = Math.min(x, y);
  if (!Number.isInteger(w) || !Number.isInteger(l) || l < 0) return false;
  if (w === r.to && l <= r.to - 2) return true;
  if (w === r.tiebreakAt + 1 && l === r.tiebreakAt) return true;
  if (r.tiebreakAt >= r.to && w === r.to + 1 && l === r.to - 1) return true;
  return false;
}

/** A super tie-break to ten, two clear. */
const completeSuperTiebreak = (x: number, y: number) => Number.isInteger(x) && Number.isInteger(y) && Math.max(x, y) >= 10 && Math.abs(x - y) >= 2;

export type ScoreCheck = { ok: true; winner: "A" | "B"; setsA: number; setsB: number } | { ok: false; reason: "shape" | "set" | "sets" };

/** A score against a rule: every set complete, the match decided, and not a set too many. */
export function checkScore(code: ScoringCode, a: readonly number[], b: readonly number[]): ScoreCheck {
  const r = SCORING[code];
  if (a.length !== b.length || a.length === 0 || a.length > r.sets) return { ok: false, reason: "shape" };
  let setsA = 0;
  let setsB = 0;
  for (let i = 0; i < a.length; i++) {
    const decided = setsA === 2 || setsB === 2;
    if (decided) return { ok: false, reason: "sets" };
    const third = r.sets === 3 && i === 2 && r.superTiebreak;
    const complete = third ? completeSuperTiebreak(a[i], b[i]) : completeSet(a[i], b[i], r);
    if (!complete || a[i] === b[i]) return { ok: false, reason: "set" };
    if (a[i] > b[i]) setsA++;
    else setsB++;
  }
  const need = r.sets === 1 ? 1 : 2;
  if (setsA < need && setsB < need) return { ok: false, reason: "sets" };
  return { ok: true, winner: setsA > setsB ? "A" : "B", setsA, setsB };
}

/** The score as people write it: "6-4 3-6 10-7". */
export const scoreText = (a: readonly number[] | null | undefined, b: readonly number[] | null | undefined): string => (a && b ? a.map((x, i) => `${x}-${b[i]}`).join(" ") : "");

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type Entrant = { id: string; seed: number | null; wildcard: boolean; order: number };
export type PlannedMatch = {
  phase: MatchPhase;
  groupLabel: string | null;
  round: number;
  position: number;
  pairA: string | null;
  pairB: string | null;
  sourceA: string | null;
  sourceB: string | null;
  bye: boolean;
};
export type DrawConfig = {
  format: CategoryFormat;
  maxPairs: number;
  groupSize: number;
  groupsThrough: number;
  consolation: boolean;
  qualifyingSpots: number;
  /** Anything stable: the same seed gives the same draw. */
  seed: string;
};
export type DrawPlan = {
  matches: PlannedMatch[];
  groups: { label: string; pairIds: string[] }[];
  /** Pairs straight into the main draw, and pairs that play for a spot. */
  direct: string[];
  qualifying: string[];
  /** Pairs beyond the field with no qualifying to play: they stay out. */
  out: string[];
};

export const GROUP_LABELS = "ABCDEFGHIJKLMNOP".split("");
export const nextPow2 = (n: number): number => (n <= 1 ? 1 : 2 ** Math.ceil(Math.log2(n)));
const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

/** Seeds first (1 before 2), then wildcards, then the order of entry; the unseeded rest shuffled so a draw is a draw. */
export function orderEntrants(entrants: readonly Entrant[], rnd: () => number): Entrant[] {
  const seeded = entrants.filter((e) => e.seed !== null).sort((a, b) => a.seed! - b.seed! || a.order - b.order);
  const wild = entrants.filter((e) => e.seed === null && e.wildcard).sort((a, b) => a.order - b.order);
  const rest = seededShuffle(
    entrants.filter((e) => e.seed === null && !e.wildcard),
    rnd,
  );
  return [...seeded, ...wild, ...rest];
}

/** The slot order of a bracket by seed number: 1 meets the last seed, 2 the second-last, and the halves keep the top two apart. */
export function bracketOrder(size: number): number[] {
  if (!isPow2(size)) throw new Error("bracket size must be a power of two");
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

/** Groups of `groupSize`, filled snake-wise by strength; when the field does not divide, the first groups run one short. */
export function splitGroups(ordered: readonly string[], groupSize: number): string[][] {
  const n = ordered.length;
  if (n === 0) return [];
  const g = Math.max(1, Math.ceil(n / groupSize));
  const groups: string[][] = Array.from({ length: g }, () => []);
  let i = 0;
  let dir = 1;
  let gi = 0;
  while (i < n) {
    groups[gi].push(ordered[i]);
    i++;
    gi += dir;
    if (gi === g) {
      gi = g - 1;
      dir = -1;
    } else if (gi < 0) {
      gi = 0;
      dir = 1;
    }
  }
  return groups;
}

/** Every pair against every other, in rounds where nobody plays twice (the circle method; an odd group rests one pair a round). */
export function roundRobin(ids: readonly string[]): [string, string][][] {
  const list: (string | null)[] = [...ids];
  if (list.length % 2 === 1) list.push(null);
  const n = list.length;
  const rounds: [string, string][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const round: [string, string][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a && b) round.push(i % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(round);
    list.splice(1, 0, list.pop()!);
  }
  return rounds;
}

type Slot = { pair: string } | { source: string } | null;

/** A knockout from its first-round slots: round 1 from the slots, every later round from the winners before it. */
function knockout(phase: MatchPhase, slots: Slot[], rounds?: number): PlannedMatch[] {
  const size = slots.length;
  const total = Math.log2(size);
  const upTo = rounds ?? total;
  const out: PlannedMatch[] = [];
  for (let i = 0; i < size / 2; i++) {
    const a = slots[2 * i];
    const b = slots[2 * i + 1];
    out.push({
      phase,
      groupLabel: null,
      round: 1,
      position: i + 1,
      pairA: a && "pair" in a ? a.pair : null,
      pairB: b && "pair" in b ? b.pair : null,
      sourceA: a && "source" in a ? a.source : null,
      sourceB: b && "source" in b ? b.source : null,
      bye: a === null || b === null,
    });
  }
  for (let r = 2; r <= upTo; r++) {
    const matches = size / 2 ** r;
    for (let p = 1; p <= matches; p++) {
      out.push({ phase, groupLabel: null, round: r, position: p, pairA: null, pairB: null, sourceA: `W:${phase}:${r - 1}:${2 * p - 1}`, sourceB: `W:${phase}:${r - 1}:${2 * p}`, bye: false });
    }
  }
  return out;
}

/** Slots in bracket order from a strength-ordered list, byes where the list runs out. */
function seededSlots(ordered: readonly Slot[]): Slot[] {
  const size = nextPow2(ordered.length);
  const bySeed = bracketOrder(size);
  return bySeed.map((s) => ordered[s - 1] ?? null);
}

function checkConfig(c: DrawConfig) {
  if (c.groupSize < 3 || c.groupSize > 6) throw new Error("groupSize");
  if (c.groupsThrough < 1 || c.groupsThrough >= c.groupSize) throw new Error("groupsThrough");
  if (c.qualifyingSpots < 0 || (c.qualifyingSpots > 0 && !isPow2(c.qualifyingSpots)) || c.qualifyingSpots >= c.maxPairs) throw new Error("qualifyingSpots");
}

/**
 * The whole draw of a category at once. The field is `maxPairs`; with qualifying spots, that many
 * of its places are played for by the pairs beyond the direct entries, and the main draw carries
 * "Q:n" until those are decided. Groups then a knockout among the top of each (the rest in the
 * consolation), or a straight knockout with the first-round losers in the consolation.
 */
export function planDraw(entrants: readonly Entrant[], c: DrawConfig): DrawPlan {
  checkConfig(c);
  const rnd = mulberry32(seedFrom(c.seed));
  const ordered = orderEntrants(entrants, rnd).map((e) => e.id);
  const q = c.qualifyingSpots;
  const directCount = q > 0 && ordered.length > c.maxPairs - q ? c.maxPairs - q : Math.min(c.maxPairs, ordered.length);
  const direct = ordered.slice(0, directCount);
  const beyond = ordered.slice(directCount);
  const matches: PlannedMatch[] = [];
  let qualifying: string[] = [];
  let out: string[] = [];
  const mainSlotsInput: Slot[] = direct.map((id) => ({ pair: id }));
  if (q > 0 && beyond.length > 0) {
    if (beyond.length <= q) {
      // Nobody to beat: they are in.
      mainSlotsInput.push(...beyond.map((id) => ({ pair: id })));
    } else {
      qualifying = beyond;
      const size = nextPow2(beyond.length);
      const rounds = Math.log2(size) - Math.log2(q);
      matches.push(...knockout("qualifying", seededSlots(beyond.map((id) => ({ pair: id }))), rounds));
      for (let n = 1; n <= q; n++) mainSlotsInput.push({ source: `Q:${n}` });
    }
  } else {
    out = beyond;
  }

  const groups: DrawPlan["groups"] = [];
  if (c.format === "groups_knockout") {
    const ids = mainSlotsInput.map((s) => (s && "pair" in s ? s.pair : (s as { source: string }).source));
    const split = splitGroups(ids, c.groupSize);
    split.forEach((members, gi) => {
      const label = GROUP_LABELS[gi];
      groups.push({ label, pairIds: members.filter((m) => !m.startsWith("Q:")) });
      roundRobin(members).forEach((round, ri) => {
        round.forEach(([a, b], pi) => {
          matches.push({
            phase: "group",
            groupLabel: label,
            round: ri + 1,
            position: pi + 1,
            pairA: a.startsWith("Q:") ? null : a,
            pairB: b.startsWith("Q:") ? null : b,
            sourceA: a.startsWith("Q:") ? a : null,
            sourceB: b.startsWith("Q:") ? b : null,
            bye: false,
          });
        });
      });
    });
    // The knockout: the winners of every group, then the runners-up, seeded in that order.
    const through: Slot[] = [];
    for (let rank = 1; rank <= c.groupsThrough; rank++) for (const g of split) if (g.length >= rank) through.push({ source: `G:${GROUP_LABELS[split.indexOf(g)]}:${rank}` });
    matches.push(...knockout("main", seededSlots(through)));
    if (c.consolation) {
      const rest: Slot[] = [];
      const deepest = Math.max(...split.map((g) => g.length));
      for (let rank = c.groupsThrough + 1; rank <= deepest; rank++) for (const g of split) if (g.length >= rank) rest.push({ source: `G:${GROUP_LABELS[split.indexOf(g)]}:${rank}` });
      if (rest.length >= 2) matches.push(...knockout("consolation", seededSlots(rest)));
    }
  } else {
    const slots = seededSlots(mainSlotsInput);
    const main = knockout("main", slots);
    matches.push(...main);
    if (c.consolation) {
      const losers: Slot[] = main.filter((m) => m.round === 1 && !m.bye).map((m) => ({ source: `L:main:1:${m.position}` }));
      if (losers.length >= 2) matches.push(...knockout("consolation", seededSlots(losers)));
    }
  }
  return { matches, groups, direct, qualifying, out };
}

// ---------------------------------------------------------------------------
// Tables and progression
// ---------------------------------------------------------------------------

export type MatchLike = PlannedMatch & { id: string; status: string; winner: "A" | "B" | null; scoreA: number[] | null; scoreB: number[] | null };

export type TableRow = { pairId: string; played: number; won: number; lost: number; setsFor: number; setsAgainst: number; gamesFor: number; gamesAgainst: number };

const isOver = (m: MatchLike) => m.status === "done" || m.status === "walkover";

/** A group's table: wins, then the match between two tied pairs, then sets, then games, then the seeding order. */
export function groupTable(pairIds: readonly string[], matches: readonly MatchLike[]): TableRow[] {
  const rows = new Map<string, TableRow>(pairIds.map((id) => [id, { pairId: id, played: 0, won: 0, lost: 0, setsFor: 0, setsAgainst: 0, gamesFor: 0, gamesAgainst: 0 }]));
  const played = matches.filter((m) => isOver(m) && m.pairA && m.pairB && rows.has(m.pairA) && rows.has(m.pairB));
  for (const m of played) {
    const a = rows.get(m.pairA!)!;
    const b = rows.get(m.pairB!)!;
    a.played++;
    b.played++;
    if (m.winner === "A") {
      a.won++;
      b.lost++;
    } else if (m.winner === "B") {
      b.won++;
      a.lost++;
    }
    if (m.scoreA && m.scoreB) {
      for (let i = 0; i < m.scoreA.length; i++) {
        a.gamesFor += m.scoreA[i];
        a.gamesAgainst += m.scoreB[i];
        b.gamesFor += m.scoreB[i];
        b.gamesAgainst += m.scoreA[i];
        if (m.scoreA[i] > m.scoreB[i]) {
          a.setsFor++;
          b.setsAgainst++;
        } else {
          b.setsFor++;
          a.setsAgainst++;
        }
      }
    }
  }
  const order = new Map(pairIds.map((id, i) => [id, i]));
  const headToHead = (x: TableRow, y: TableRow): number => {
    const m = played.find((k) => (k.pairA === x.pairId && k.pairB === y.pairId) || (k.pairA === y.pairId && k.pairB === x.pairId));
    if (!m || !m.winner) return 0;
    const winnerId = m.winner === "A" ? m.pairA : m.pairB;
    return winnerId === x.pairId ? -1 : 1;
  };
  const list = [...rows.values()];
  list.sort((x, y) => {
    if (y.won !== x.won) return y.won - x.won;
    const tiedOnWins = list.filter((r) => r.won === x.won).length;
    if (tiedOnWins === 2) {
      const h = headToHead(x, y);
      if (h !== 0) return h;
    }
    const sd = y.setsFor - y.setsAgainst - (x.setsFor - x.setsAgainst);
    if (sd !== 0) return sd;
    const gd = y.gamesFor - y.gamesAgainst - (x.gamesFor - x.gamesAgainst);
    if (gd !== 0) return gd;
    return order.get(x.pairId)! - order.get(y.pairId)!;
  });
  return list;
}

export const groupComplete = (label: string, matches: readonly MatchLike[]): boolean => {
  const mine = matches.filter((m) => m.phase === "group" && m.groupLabel === label);
  return mine.length > 0 && mine.every((m) => isOver(m) || m.bye);
};

/** The ranked pairs of every finished group, by label. */
export function finishedGroups(groups: readonly { label: string; pairIds: string[] }[], matches: readonly MatchLike[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const g of groups) if (groupComplete(g.label, matches)) out.set(g.label, groupTable(g.pairIds, matches.filter((m) => m.groupLabel === g.label)).map((r) => r.pairId));
  return out;
}

export type Progress = { id: string; pairA?: string | null; pairB?: string | null; bye?: boolean; status?: "done"; winner?: "A" | "B" | null };

const winnerOf = (m: MatchLike): string | null => (m.winner === "A" ? m.pairA : m.winner === "B" ? m.pairB : null);
const loserOf = (m: MatchLike): string | null => (m.winner === "A" ? m.pairB : m.winner === "B" ? m.pairA : null);

/**
 * What a result decides downstream: the next round's slot, a consolation slot, a qualifier's place
 * in the main draw, a group's places once its last match is in. A side that resolves to nobody is
 * a bye, and a match with one side and a bye is over without being played. Returns only the
 * changes; the caller writes them and calls again until nothing moves.
 */
export function progress(matches: readonly MatchLike[], groups: readonly { label: string; pairIds: string[] }[]): Progress[] {
  const byKey = new Map<string, MatchLike>();
  for (const m of matches) byKey.set(`${m.phase}:${m.round}:${m.position}`, m);
  const tables = finishedGroups(groups, matches);
  const qualRounds = Math.max(0, ...matches.filter((m) => m.phase === "qualifying").map((m) => m.round));
  // undefined: not known yet; null: nobody (a bye); a string: the pair.
  const resolve = (source: string): string | null | undefined => {
    const [kind, ...rest] = source.split(":");
    if (kind === "Q") {
      const m = byKey.get(`qualifying:${qualRounds}:${rest[0]}`);
      if (!m || !isOver(m)) return undefined;
      return winnerOf(m);
    }
    if (kind === "G") {
      const ranked = tables.get(rest[0]);
      if (!ranked) return undefined;
      return ranked[Number(rest[1]) - 1] ?? null;
    }
    const m = byKey.get(rest.join(":"));
    if (!m) return null;
    if (!isOver(m)) return undefined;
    if (kind === "W") return winnerOf(m);
    // A loser: a bye has none, so the consolation slot is a bye too.
    return m.bye ? null : loserOf(m);
  };
  const out: Progress[] = [];
  for (const m of matches) {
    if (isOver(m)) continue;
    const change: Progress = { id: m.id };
    let touched = false;
    let a: string | null | undefined = m.pairA;
    let b: string | null | undefined = m.pairB;
    let byeA = m.bye && !m.pairA && !m.sourceA;
    let byeB = m.bye && !m.pairB && !m.sourceB;
    if (!m.pairA && m.sourceA) {
      const r = resolve(m.sourceA);
      if (r !== undefined) {
        touched = true;
        if (r === null) byeA = true;
        else change.pairA = r;
        a = r;
      }
    }
    if (!m.pairB && m.sourceB) {
      const r = resolve(m.sourceB);
      if (r !== undefined) {
        touched = true;
        if (r === null) byeB = true;
        else change.pairB = r;
        b = r;
      }
    }
    const aKnown = a !== undefined && (a !== null || byeA);
    const bKnown = b !== undefined && (b !== null || byeB);
    if (aKnown && bKnown && (byeA || byeB)) {
      change.bye = true;
      change.status = "done";
      change.winner = a && !b ? "A" : b && !a ? "B" : null;
      touched = true;
    }
    if (touched) out.push(change);
  }
  return out;
}

/** The name of a knockout round from the end: the final, the semi-finals, the quarter-finals, the round of N. */
export function roundKey(round: number, rounds: number): { key: "final" | "semi" | "quarter" | "of"; of?: number } {
  const fromEnd = rounds - round;
  if (fromEnd === 0) return { key: "final" };
  if (fromEnd === 1) return { key: "semi" };
  if (fromEnd === 2) return { key: "quarter" };
  return { key: "of", of: 2 ** (fromEnd + 1) };
}

/** The scoring rule a match plays under: the groups', the final's, or the rounds before it. */
export function scoringOfMatch(m: Pick<PlannedMatch, "phase" | "round">, rounds: number, c: { scoringGroup: string; scoringKnockout: string; scoringFinal: string }): ScoringCode {
  if (m.phase === "group") return scoringOr(c.scoringGroup, "set6tb");
  if (m.phase === "main" && m.round === rounds) return scoringOr(c.scoringFinal, "sets2stb");
  return scoringOr(c.scoringKnockout, "set9");
}
