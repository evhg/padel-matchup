import type { TournamentFormat } from "@/db/schema";
import { mulberry32, seededShuffle, seedFrom, type MatchRef, type Pairing, type RoundPlan, type StandingRow } from "./americano";
import { DomainError } from "./errors";

/**
 * Fixed pairs: the owner's decision F of 9 October 2026, "Fixed pairs in social tournaments (two
 * partners play every round together), as Phuket nights often do". Pure, and a leaf the create form
 * and the cards may import.
 *
 * The pair is the unit. Americano with fixed pairs rotates the opponents only: on every court the
 * field can fill, the circle method gives the exact round robin, so every pair meets every other pair
 * once in P − 1 rounds (P even) or P rounds (P odd, where the pair facing the empty place rests, each
 * pair once). On fewer courts than that the round is chosen by the fewest rests, then the fewest
 * repeated meetings. Mexicano puts the pairs on courts by the pairs' table, first against second;
 * King of the Court moves a winning pair up a court and a losing pair down. In all three a round rests
 * whoever does not fit a court, a pair at a time, and nobody's pair rests twice before every pair has
 * rested once: in King of the Court too, where a pair back from a rest starts at the bottom court.
 *
 * A draw is a pure function of the event, the round number and the pairs, through the same seeded
 * engine (`mulberry32`, `seedFrom`) as rotating partners, so the same night always draws the same round.
 *
 * The seats: a pair is the two named seats of one event that share `slots.pair_id` (`seatUnits`).
 * A named seat whose key nobody else shares is a player with no partner yet, "Partner needed".
 */

export type Pair = readonly [string, string];

/** One key per pair whatever the order of its two players. */
export const pairKey = (p: readonly [string, string] | readonly string[]): string => (p[0] < p[1] ? `${p[0]}|${p[1]}` : `${p[1]}|${p[0]}`);

/** Courts a round of this many pairs fills: one court per two pairs, never more than the organiser gave. */
export function pairCourts(pairs: number, courts?: number | null): number {
  const max = Math.floor(pairs / 2);
  if (max === 0) return 0;
  return Math.max(1, Math.min(courts ?? max, max));
}

/**
 * Rounds until every pair has met every other pair once. There are P × (P − 1) / 2 meetings and a round
 * holds one per court: P − 1 rounds for an even field, P for an odd one (each pair rests once), more on
 * fewer courts. Null below two pairs.
 */
export function pairRotationRounds(pairs: number, courts?: number | null): number | null {
  const c = pairCourts(pairs, courts);
  if (c === 0) return null;
  return Math.ceil((pairs * (pairs - 1)) / (2 * c));
}

/** Why round 1 cannot be drawn with these pairs, or null when it can: a pair without a partner cannot be drawn, and one court needs two pairs. */
export function pairsRefusal(completePairs: number, singles: number): "partner_needed" | "need_2_pairs" | null {
  if (singles > 0) return "partner_needed";
  if (completePairs < 2) return "need_2_pairs";
  return null;
}

// ---------------------------------------------------------------------------
// The seats
// ---------------------------------------------------------------------------

export type SeatLike = { id: string; pairId: string | null; status: string; position: number };

/** A seat with a name on it: joined, confirmed, or reserved and not yet accepted. */
export const isNamedSeat = (s: Pick<SeatLike, "status">) => s.status === "joined" || s.status === "confirmed" || s.status === "invited";

export type SeatUnit<T> = { kind: "pair"; seats: [T, T] } | { kind: "single"; seat: T };

/**
 * The named seats as the night sees them: pairs (two named seats sharing a key) and singles, in the
 * order of their first seat. A key held by one named seat, or by more than two (which no write makes),
 * is a single each: a partner is somebody named, never a guess.
 */
export function seatUnits<T extends SeatLike>(seats: readonly T[]): SeatUnit<T>[] {
  const named = seats.filter(isNamedSeat).sort((a, b) => a.position - b.position);
  const byKey = new Map<string, T[]>();
  for (const s of named) if (s.pairId) byKey.set(s.pairId, [...(byKey.get(s.pairId) ?? []), s]);
  const units: SeatUnit<T>[] = [];
  const done = new Set<string>();
  for (const s of named) {
    if (done.has(s.id)) continue;
    const group = s.pairId ? byKey.get(s.pairId)! : [s];
    if (group.length === 2) {
      units.push({ kind: "pair", seats: [group[0], group[1]] });
      done.add(group[0].id).add(group[1].id);
    } else {
      units.push({ kind: "single", seat: s });
      done.add(s.id);
    }
  }
  return units;
}

/** The seat's partner: the other named seat with its key, or null for a single. */
export function partnerOf<T extends SeatLike>(seats: readonly T[], seat: T): T | null {
  for (const u of seatUnits(seats)) if (u.kind === "pair" && u.seats.some((s) => s.id === seat.id)) return u.seats.find((s) => s.id !== seat.id)!;
  return null;
}

/** The complete pairs and the singles, counted. */
export function unitCounts(units: readonly SeatUnit<unknown>[]): { pairs: number; singles: number } {
  const pairs = units.filter((u) => u.kind === "pair").length;
  return { pairs, singles: units.length - pairs };
}

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

type RoundRef = { matches: readonly (MatchRef & { court?: number })[]; resting: readonly string[] };
export type PairRound = RoundRef & { roundNumber: number; matches: readonly (MatchRef & { court: number })[] };

type PairHistory = { met: Map<string, number>; rested: Map<string, number>; played: Map<string, number> };

const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const meetKey = (x: string, y: string) => (x < y ? `${x}#${y}` : `${y}#${x}`);

/** Meetings between pairs, rests and matches per pair, from the rounds drawn so far. A pair rests when its players do. */
function pairHistory(rounds: readonly RoundRef[], pairs: readonly Pair[]): PairHistory {
  const h: PairHistory = { met: new Map(), rested: new Map(), played: new Map() };
  const keyOf = new Map<string, string>();
  for (const p of pairs) for (const id of p) keyOf.set(id, pairKey(p));
  for (const r of rounds) {
    for (const m of r.matches) {
      const a = pairKey([m.a1, m.a2]);
      const b = pairKey([m.b1, m.b2]);
      inc(h.met, meetKey(a, b));
      inc(h.played, a);
      inc(h.played, b);
    }
    const restedNow = new Set<string>();
    for (const id of r.resting) {
      const k = keyOf.get(id);
      if (k) restedNow.add(k);
    }
    for (const k of restedNow) inc(h.rested, k);
  }
  return h;
}

const asPairing = (court: number, a: Pair, b: Pair): Pairing => ({ court, a: [a[0], a[1]], b: [b[0], b[1]] });

/** Who rests: the fewest rests so far, then (`then`) the format's own order, then the seeded shuffle. */
function restingPairs(pairs: readonly Pair[], h: PairHistory, count: number, rnd: () => number, then: (x: Pair, y: Pair) => number = () => 0): Pair[] {
  if (count <= 0) return [];
  return seededShuffle(pairs, rnd)
    .map((p, i) => ({ p, i, rested: h.rested.get(pairKey(p)) ?? 0 }))
    .sort((x, y) => x.rested - y.rested || then(x.p, y.p) || x.i - y.i)
    .slice(0, count)
    .map((x) => x.p);
}

/**
 * The circle method over pairs: one pair stays, the rest turn one place a round. With an odd field the
 * fixed place is empty, and the pair facing it rests, so every pair rests exactly once in P rounds and
 * in the same order every rotation. Court numbers turn too, so no pair camps on court 1.
 */
function roundRobin(ordered: readonly Pair[], roundIndex: number): { matches: Pairing[]; resting: Pair[] } {
  const places: (Pair | null)[] = ordered.length % 2 === 1 ? [null, ...ordered] : [...ordered];
  const n = places.length;
  const r = ((roundIndex % (n - 1)) + (n - 1)) % (n - 1);
  const rest = places.slice(1);
  const rot = [places[0], ...rest.map((_, i) => rest[(i + r) % (n - 1)])];
  const meetings: [Pair, Pair][] = [];
  const resting: Pair[] = [];
  for (let i = 0; i < n / 2; i++) {
    const x = rot[i];
    const y = rot[n - 1 - i];
    if (x && y) meetings.push([x, y]);
    else resting.push((x ?? y)!);
  }
  const k = meetings.length;
  const matches = meetings.map(([a, b], i) => asPairing(((i + r) % k) + 1, a, b)).sort((x, y) => x.court - y.court);
  return { matches, resting };
}

/** The cheapest way to put these pairs on courts two by two: fewest earlier meetings. Exhaustive up to eight pairs, then the best of many shuffles. */
function fewestMeetings(active: readonly Pair[], h: PairHistory, rnd: () => number): [Pair, Pair][] {
  const cost = (x: Pair, y: Pair) => h.met.get(meetKey(pairKey(x), pairKey(y))) ?? 0;
  if (active.length <= 8) {
    let best: [Pair, Pair][] = [];
    let bestCost = Number.POSITIVE_INFINITY;
    const walk = (left: readonly Pair[], acc: [Pair, Pair][], c: number) => {
      if (c >= bestCost) return;
      if (left.length === 0) {
        best = acc.slice();
        bestCost = c;
        return;
      }
      const [first, ...others] = left;
      for (let i = 0; i < others.length; i++) {
        acc.push([first, others[i]]);
        walk(
          others.filter((_, j) => j !== i),
          acc,
          c + cost(first, others[i]),
        );
        acc.pop();
      }
    };
    walk(seededShuffle(active, rnd), [], 0);
    return best;
  }
  let best: [Pair, Pair][] = [];
  let bestCost = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 200 && bestCost > 0; attempt++) {
    const pool = seededShuffle(active, rnd);
    const out: [Pair, Pair][] = [];
    let total = 0;
    while (pool.length) {
      const first = pool.shift()!;
      let bi = 0;
      for (let i = 1; i < pool.length; i++) if (cost(first, pool[i]) < cost(first, pool[bi])) bi = i;
      total += cost(first, pool[bi]);
      out.push([first, pool.splice(bi, 1)[0]]);
    }
    if (total < bestCost) {
      bestCost = total;
      best = out;
    }
  }
  return best;
}

/** The previous round must be fully scored before a round that is built from the table. */
const assertScored = (rounds: readonly RoundRef[]) => {
  const last = rounds.at(-1);
  if (last && !last.matches.every((m) => m.sideA != null && m.sideB != null)) throw new DomainError("invalid", "scores_missing");
};

/** The least the meetings of these pairs can cost: exact up to eight pairs, the greedy sum above. No randomness, so pricing a choice draws nothing from the seed. */
function meetingsCost(active: readonly Pair[], h: PairHistory): number {
  const cost = (x: Pair, y: Pair) => h.met.get(meetKey(pairKey(x), pairKey(y))) ?? 0;
  if (active.length <= 8) {
    let best = Number.POSITIVE_INFINITY;
    const walk = (left: readonly Pair[], c: number) => {
      if (c >= best) return;
      if (left.length === 0) {
        best = c;
        return;
      }
      const [first, ...others] = left;
      for (let i = 0; i < others.length; i++)
        walk(
          others.filter((_, j) => j !== i),
          c + cost(first, others[i]),
        );
    };
    walk(active, 0);
    return best;
  }
  const pool = active.slice();
  let total = 0;
  while (pool.length) {
    const first = pool.shift()!;
    let bi = 0;
    for (let i = 1; i < pool.length; i++) if (cost(first, pool[i]) < cost(first, pool[bi])) bi = i;
    total += cost(first, pool.splice(bi, 1)[0]);
  }
  return total;
}

/** How many ways to choose `k` of `n`, stopping counting once it passes `cap`. */
function choose(n: number, k: number, cap: number): number {
  let c = 1;
  for (let i = 0; i < k && c <= cap; i++) c = (c * (n - i)) / (i + 1);
  return c;
}

/** At most this many ways to choose who rests are priced; past it, that many seeded ones. */
const REST_CHOICES = 600;

/**
 * Americano on fewer courts than the field fills (and round 1 of mexicano and king). The rest rule
 * holds first: every pair with fewer rests than the rest must rest, and the rest go to pairs tied on
 * the fewest rests. With few courts the choice among the tied decides who meets, so each way of
 * choosing is priced by the meetings of the pairs left to play, and the cheapest wins: four pairs on
 * one court meet each other once in six rounds, five pairs in ten. Before this, the rests were chosen
 * first and the meetings followed, and the same two pairs met three times while others never met.
 */
function fairRound(pairs: readonly Pair[], courts: number | null | undefined, h: PairHistory, rnd: () => number): RoundPlan {
  const c = pairCourts(pairs.length, courts);
  const restCount = pairs.length - 2 * c;
  // The seeded order, the most matches played first among equal rests: ties fall where they always did.
  const order = seededShuffle(pairs, rnd)
    .map((p, i) => ({ p, i, rested: h.rested.get(pairKey(p)) ?? 0, played: h.played.get(pairKey(p)) ?? 0 }))
    .sort((x, y) => x.rested - y.rested || y.played - x.played || x.i - y.i);
  let resting: Pair[] = [];
  if (restCount > 0) {
    const edge = order[restCount - 1].rested;
    const must = order.filter((x) => x.rested < edge).map((x) => x.p);
    const tied = order.filter((x) => x.rested === edge).map((x) => x.p);
    const need = restCount - must.length;
    const options: Pair[][] = [];
    if (choose(tied.length, need, REST_CHOICES) <= REST_CHOICES) {
      const pick = (from: number, acc: Pair[]) => {
        if (acc.length === need) return void options.push(acc.slice());
        for (let i = from; i <= tied.length - (need - acc.length); i++) pick(i + 1, [...acc, tied[i]]);
      };
      pick(0, []);
    } else for (let k = 0; k < REST_CHOICES; k++) options.push(seededShuffle(tied, rnd).slice(0, need));
    // Among equal prices, let play the pairs with the most meetings still to come: they are the ones a
    // later round cannot spare.
    const unmet = (p: Pair) => pairs.filter((q) => q !== p && !h.met.get(meetKey(pairKey(p), pairKey(q)))).length;
    let best = { cost: Number.POSITIVE_INFINITY, owed: Number.NEGATIVE_INFINITY };
    for (const option of options) {
      const out = new Set([...must, ...option].map(pairKey));
      const active = pairs.filter((p) => !out.has(pairKey(p)));
      const cost = meetingsCost(active, h);
      const owed = active.reduce((sum, p) => sum + unmet(p), 0);
      if (cost < best.cost || (cost === best.cost && owed > best.owed)) {
        best = { cost, owed };
        resting = [...must, ...option];
      }
    }
  }
  const out = new Set(resting.map(pairKey));
  const meetings = fewestMeetings(
    pairs.filter((p) => !out.has(pairKey(p))),
    h,
    rnd,
  );
  return { matches: meetings.map(([a, b], i) => asPairing(i + 1, a, b)), resting: resting.flat() };
}

export type PairStandingRow = { pair: Pair; key: string; rank: number; points: number; played: number; wins: number; losses: number; draws: number; diff: number; court: number | null };

/**
 * The pairs' table. Points scored, then the difference, then wins — or, on a night of first to N games,
 * wins first — exactly the order `computeStandings` uses for players, because a pair's two players
 * always carry the same numbers. Equal on all three → a shared rank.
 */
export function computePairStandings(pairs: readonly Pair[], matches: readonly MatchRef[], o: { byWins?: boolean } = {}): PairStandingRow[] {
  const rows = new Map<string, PairStandingRow>();
  const row = (p: Pair) => {
    const key = pairKey(p);
    let r = rows.get(key);
    if (!r) {
      // The pair as it was first named (the list's order, else the match's), so the table reads "Cy & Di" as the list does.
      r = { pair: [p[0], p[1]], key, rank: 0, points: 0, played: 0, wins: 0, losses: 0, draws: 0, diff: 0, court: null };
      rows.set(key, r);
    }
    return r;
  };
  for (const p of pairs) row(p);
  for (const m of matches) {
    if (m.sideA == null || m.sideB == null) continue;
    const apply = (p: Pair, mine: number, theirs: number) => {
      const r = row(p);
      r.points += mine;
      r.played += 1;
      r.diff += mine - theirs;
      if (mine > theirs) r.wins += 1;
      else if (mine < theirs) r.losses += 1;
      else r.draws += 1;
    };
    apply([m.a1, m.a2], m.sideA, m.sideB);
    apply([m.b1, m.b2], m.sideB, m.sideA);
  }
  const sorted = [...rows.values()].sort((x, y) => (o.byWins ? y.wins - x.wins || y.diff - x.diff || y.points - x.points : y.points - x.points || y.diff - x.diff || y.wins - x.wins) || x.key.localeCompare(y.key));
  let prev: PairStandingRow | null = null;
  sorted.forEach((r, i) => {
    r.rank = prev && prev.points === r.points && prev.diff === r.diff && prev.wins === r.wins ? prev.rank : i + 1;
    prev = r;
  });
  return sorted;
}

/** King of the Court ranks pairs by the court they finish on, that court's winners first; the table breaks the ties. Pairs that rested the last round follow. */
export function computeKingPairStandings(pairs: readonly Pair[], rounds: readonly RoundRef[]): PairStandingRow[] {
  const base = computePairStandings(
    pairs,
    rounds.flatMap((r) => r.matches),
  );
  const court = new Map<string, number>();
  const wonLast = new Set<string>();
  const last = rounds.at(-1);
  for (const m of last?.matches ?? []) {
    const a = pairKey([m.a1, m.a2]);
    const b = pairKey([m.b1, m.b2]);
    court.set(a, m.court ?? 0);
    court.set(b, m.court ?? 0);
    if (m.sideA != null && m.sideB != null && m.sideA !== m.sideB) wonLast.add(m.sideA > m.sideB ? a : b);
  }
  const order = new Map(base.map((r, i) => [r.key, i]));
  const rows = base.map((r) => ({ ...r, court: court.get(r.key) ?? null }));
  rows.sort((x, y) => (x.court ?? Number.POSITIVE_INFINITY) - (y.court ?? Number.POSITIVE_INFINITY) || Number(wonLast.has(y.key)) - Number(wonLast.has(x.key)) || order.get(x.key)! - order.get(y.key)!);
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  return rows;
}

/** The pairs' table as one row per player, both partners carrying their pair's numbers and rank: what the finalize snapshot, the levels and the API read. */
export function pairRowsToPlayers(rows: readonly PairStandingRow[]): (StandingRow & { court: number | null })[] {
  return rows.flatMap((r) => r.pair.map((playerId) => ({ playerId, rank: r.rank, points: r.points, played: r.played, wins: r.wins, losses: r.losses, draws: r.draws, diff: r.diff, court: r.court })));
}

/** Mexicano: the pairs' table puts them on courts, first against second on court 1, third against fourth on court 2. */
function mexicanoPairs(pairs: readonly Pair[], courts: number | null | undefined, rounds: readonly PairRound[], h: PairHistory, rnd: () => number): RoundPlan {
  if (rounds.length === 0) return fairRound(pairs, courts, h, rnd);
  assertScored(rounds);
  const table = computePairStandings(
    pairs,
    rounds.flatMap((r) => r.matches),
  );
  const place = new Map(table.map((r, i) => [r.key, i]));
  const c = pairCourts(pairs.length, courts);
  const resting = restingPairs(pairs, h, pairs.length - 2 * c, rnd);
  const out = new Set(resting.map(pairKey));
  const active = pairs.filter((p) => !out.has(pairKey(p))).sort((x, y) => place.get(pairKey(x))! - place.get(pairKey(y))!);
  const matches: Pairing[] = [];
  for (let i = 0; i < c; i++) matches.push(asPairing(i + 1, active[2 * i], active[2 * i + 1]));
  return { matches, resting: resting.flat() };
}

/**
 * King of the Court with pairs: the winning pair moves up a court, the losing pair down; the top
 * court's winners and the bottom court's losers stay. The pair that rests is chosen first, by the
 * fewest rests and then the lowest place on the ladder, and it comes back in at the bottom court.
 */
function kingPairs(pairs: readonly Pair[], courts: number | null | undefined, rounds: readonly PairRound[], h: PairHistory, rnd: () => number): RoundPlan {
  if (rounds.length === 0) return fairRound(pairs, courts, h, rnd);
  assertScored(rounds);
  const last = rounds.at(-1)!;
  const points = new Map(
    computePairStandings(
      pairs,
      rounds.flatMap((r) => r.matches),
    ).map((r) => [r.key, r.points]),
  );
  const k = pairCourts(pairs.length, courts);
  const target = new Map<string, { court: number; priority: number }>();
  const clamp = (c: number) => Math.max(1, Math.min(k, c));
  for (const m of last.matches) {
    const a = pairKey([m.a1, m.a2]);
    const b = pairKey([m.b1, m.b2]);
    let aWins: boolean;
    if (m.sideA! !== m.sideB!) aWins = m.sideA! > m.sideB!;
    else aWins = (points.get(a) ?? 0) !== (points.get(b) ?? 0) ? (points.get(a) ?? 0) > (points.get(b) ?? 0) : rnd() < 0.5;
    const [win, lose] = aWins ? [a, b] : [b, a];
    target.set(win, m.court === 1 ? { court: 1, priority: 2 } : { court: clamp(m.court - 1), priority: 3 });
    target.set(lose, m.court >= k ? { court: k, priority: 2 } : { court: clamp(m.court + 1), priority: 1 });
  }
  const where = (p: Pair) => target.get(pairKey(p)) ?? { court: k, priority: 0 };
  // Lowest on the ladder first: the bottom court, then the weakest claim on it, then the fewest points.
  const ladder = (x: Pair, y: Pair) => where(y).court - where(x).court || where(x).priority - where(y).priority || (points.get(pairKey(x)) ?? 0) - (points.get(pairKey(y)) ?? 0) || pairKey(x).localeCompare(pairKey(y));
  const resting = restingPairs(pairs, h, pairs.length - 2 * k, rnd, ladder);
  const out = new Set(resting.map(pairKey));
  // Top of the ladder first; each court takes the next two, so a crowded court sends its weakest claim down and an empty one pulls the best from below.
  const active = pairs.filter((p) => !out.has(pairKey(p))).sort((x, y) => -ladder(x, y));
  const matches: Pairing[] = [];
  for (let i = 0; i < k; i++) matches.push(asPairing(i + 1, active[2 * i], active[2 * i + 1]));
  return { matches, resting: resting.flat() };
}

/** One round planned ahead: who meets on which court, and which pairs rest. */
type PlannedRound = { matches: Pairing[]; resting: Pair[] };

/** How many search steps a round may take before it is drawn by the fewest rests and meetings alone. */
const PLAN_BUDGET = 40000;

/**
 * The next round, chosen by looking ahead: of the ways the rest rule allows (nobody's pair rests twice
 * before every pair has rested once), one from which every meeting not played yet still fits in the
 * fewest rounds that can hold them, with no meeting played twice before then except in the last of
 * those rounds, where the courts can force one (six pairs on two courts: fifteen meetings, sixteen
 * places). It starts from the night as it stands, so a field that changed after round 1 is planned from
 * there. A round-by-round choice paints itself into a corner: five pairs on one court met each other
 * once in 79 nights of 100. Bounded by `PLAN_BUDGET`; null when it runs out or every meeting is played.
 */
function plannedNext(ordered: readonly Pair[], c: number, h: PairHistory, rnd: () => number): PlannedRound | null {
  const P = ordered.length;
  const restCount = P - 2 * c;
  const keys = ordered.map(pairKey);
  const edgeKey = (a: number, b: number) => (a < b ? `${a}#${b}` : `${b}#${a}`);
  const met = new Set<string>();
  for (let a = 0; a < P; a++) for (let b = a + 1; b < P; b++) if (h.met.get(meetKey(keys[a], keys[b]))) met.add(edgeKey(a, b));
  const meetings = (P * (P - 1)) / 2;
  const unmet = meetings - met.size;
  if (unmet === 0 || c === 0) return null;
  const tie = ordered.map(() => rnd());
  /** The perfect matchings of these pairs, cheapest first (a meeting played already costs one). */
  const matchings = (active: number[]): { cost: number; m: [number, number][] }[] => {
    const out: { cost: number; m: [number, number][] }[] = [];
    const walk = (left: number[], acc: [number, number][], cost: number) => {
      if (left.length === 0) return void out.push({ cost, m: acc.slice() });
      const [first, ...others] = left;
      for (let i = 0; i < others.length; i++) {
        acc.push([first, others[i]]);
        walk(
          others.filter((_, j) => j !== i),
          acc,
          cost + (met.has(edgeKey(first, others[i])) ? 1 : 0),
        );
        acc.pop();
      }
    };
    walk(active, [], 0);
    return out.sort((x, y) => x.cost - y.cost);
  };
  const attempt = (length: number): PlannedRound | null => {
    const rested = keys.map((k) => h.rested.get(k) ?? 0);
    const played = keys.map((k) => h.played.get(k) ?? 0);
    let steps = 0;
    let first: PlannedRound | null = null;
    const dfs = (round: number): boolean => {
      if (met.size === meetings) return true;
      if (round === length || ++steps > PLAN_BUDGET) return false;
      const order = ordered.map((_, i) => i).sort((x, y) => rested[x] - rested[y] || played[y] - played[x] || tie[x] - tie[y]);
      let options: number[][] = [[]];
      if (restCount > 0) {
        const edge = rested[order[restCount - 1]];
        const must = order.filter((i) => rested[i] < edge);
        const tied = order.filter((i) => rested[i] === edge);
        const need = restCount - must.length;
        options = [];
        const pick = (from: number, acc: number[]) => {
          if (options.length > 200) return;
          if (acc.length === need) return void options.push([...must, ...acc]);
          for (let i = from; i <= tied.length - (need - acc.length); i++) pick(i + 1, [...acc, tied[i]]);
        };
        pick(0, []);
      }
      for (const out of options) {
        const resting = new Set(out);
        const active = order.filter((i) => !resting.has(i));
        if (active.length > 8) return false;
        for (const { cost, m } of matchings(active)) {
          const fresh = m.filter(([a, b]) => !met.has(edgeKey(a, b)));
          const left = meetings - met.size - fresh.length;
          // A meeting played twice only in the round that plays the last new ones.
          if (cost > 0 && left > 0) break;
          // Whatever is left to meet must still fit in the rounds left.
          if (left > (length - round - 1) * c) continue;
          for (const [a, b] of fresh) met.add(edgeKey(a, b));
          for (const i of out) rested[i]++;
          for (const i of active) played[i]++;
          const ok = dfs(round + 1);
          for (const i of active) played[i]--;
          for (const i of out) rested[i]--;
          for (const [a, b] of fresh) met.delete(edgeKey(a, b));
          if (ok) {
            if (round === 0) first = { matches: m.map(([a, b], k) => asPairing(k + 1, ordered[a], ordered[b])), resting: out.map((i) => ordered[i]) };
            return true;
          }
          if (steps > PLAN_BUDGET) return false;
        }
      }
      return false;
    };
    return dfs(0) ? first : null;
  };
  // The fewest rounds that can hold every meeting left, then one more if the rest rule needs it.
  const least = Math.ceil(unmet / c);
  return attempt(least) ?? attempt(least + 1);
}

/** The circle's rounds for this field, seeded per event: P − 1 for an even field, P for an odd one, repeating once played through. */
const circleRounds = (ordered: readonly Pair[]): PlannedRound[] => Array.from({ length: ordered.length % 2 === 0 ? ordered.length - 1 : ordered.length }, (_, i) => roundRobin(ordered, i));

const meetingsOf = (matches: readonly { a: readonly string[]; b: readonly string[] }[]) =>
  matches
    .map((m) => [pairKey(m.a), pairKey(m.b)].sort().join(" v "))
    .sort()
    .join(",");

/**
 * Whether every round drawn so far is the circle's own round for these pairs. A field that changed after
 * round 1 (a partner taken out, a pair moved up), or courts changed under a running night, leaves the
 * circle, and from then the night is planned from where it stands (`plannedNext`).
 */
const followsCircle = (circle: readonly PlannedRound[], rounds: readonly PairRound[]) =>
  rounds.every((r) => meetingsOf(circle[(r.roundNumber - 1) % circle.length].matches) === meetingsOf(r.matches.map((m) => ({ a: [m.a1, m.a2], b: [m.b1, m.b2] }))));

/** The pairs sorted by key, then seeded per event: the order the circle and the plan read, whatever the seats' order. */
function seatedOrder(eventId: string, input: readonly Pair[]): Pair[] {
  const pairs = [...new Map(input.map((p) => [pairKey(p), p])).values()].sort((x, y) => pairKey(x).localeCompare(pairKey(y)));
  return seededShuffle(pairs, mulberry32(seedFrom(`${eventId}:pairs`)));
}

/**
 * The rounds of a full rotation while an americano night follows its circle (every court the field
 * fills, the same pairs since round 1): P − 1, or P for an odd field. Null otherwise: on fewer courts,
 * and once the field or the courts changed, so no screen says "every pair has met every other" when
 * that is no longer the night's promise.
 */
export function pairRotation(input: { eventId: string; pairs: readonly Pair[]; courts: number | null | undefined; rounds: readonly PairRound[] }): number | null {
  const ordered = seatedOrder(input.eventId, input.pairs);
  if (ordered.length < 2 || pairCourts(ordered.length, input.courts) !== Math.floor(ordered.length / 2)) return null;
  const circle = circleRounds(ordered);
  return followsCircle(circle, input.rounds) ? circle.length : null;
}

/**
 * The next round of a fixed-pairs night, in any format: what `drawRound` returns when the night keeps
 * its partners. The seeds are the event's and the round's, as for rotating partners. Americano follows
 * the circle on every court the field fills while the rounds drawn so far are the circle's; otherwise
 * (fewer courts, or a field that changed) the next round is planned ahead from the night as it stands
 * (`plannedNext`), and once every meeting is played, drawn by the fewest rests and repeats (`fairRound`).
 */
export function drawPairRound(input: { eventId: string; format: TournamentFormat; pairs: readonly Pair[]; courts: number | null | undefined; rounds: readonly PairRound[] }): RoundPlan {
  const { eventId, format, courts, rounds } = input;
  const pairs = [...new Map(input.pairs.map((p) => [pairKey(p), p])).values()].sort((x, y) => pairKey(x).localeCompare(pairKey(y)));
  if (pairs.length < 2) throw new DomainError("invalid", "need_2_pairs");
  const roundNumber = (rounds.at(-1)?.roundNumber ?? 0) + 1;
  const rnd = mulberry32(seedFrom(`${eventId}:${roundNumber}`));
  const h = pairHistory(rounds, pairs);
  if (format === "mexicano") return mexicanoPairs(pairs, courts, rounds, h, rnd);
  if (format === "king") return kingPairs(pairs, courts, rounds, h, rnd);
  const ordered = seatedOrder(eventId, pairs);
  const c = pairCourts(pairs.length, courts);
  if (c === Math.floor(pairs.length / 2)) {
    const circle = circleRounds(ordered);
    if (followsCircle(circle, rounds)) {
      const r = circle[(roundNumber - 1) % circle.length];
      return { matches: r.matches, resting: r.resting.flat() };
    }
  }
  const next = plannedNext(ordered, c, h, mulberry32(seedFrom(`${eventId}:${roundNumber}:plan`)));
  if (next) return { matches: next.matches, resting: next.resting.flat() };
  return fairRound(pairs, courts, h, rnd);
}

/**
 * A finalised night's snapshot (`events.standings`, ordered player ids) as places: one player a place,
 * or on a fixed-pairs night the two partners of each pair, which `pairRowsToPlayers` writes side by
 * side. Every reader of the snapshot (a player's place, a podium, the card's result line) asks this, so
 * the second partner of the winning pair is first, not second.
 */
export function placesOf(ev: { standings: readonly string[] | null; fixedPairs: boolean }): string[][] {
  const ids = ev.standings ?? [];
  if (!ev.fixedPairs) return ids.map((id) => [id]);
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += 2) out.push(ids.slice(i, i + 2));
  return out;
}

/** A player's place in a finalised night (1 is first), or null when they are not in the snapshot. */
export function placeOf(ev: { standings: readonly string[] | null; fixedPairs: boolean }, playerId: string): number | null {
  const i = placesOf(ev).findIndex((p) => p.includes(playerId));
  return i >= 0 ? i + 1 : null;
}

/**
 * The pairs a night was drawn from, read back from its rounds: each side of a match, and the rests two
 * by two (`drawPairRound` writes a resting pair's two players side by side). The table outlives the
 * seats this way: a pair one partner of which left after round 3 still has its row.
 */
export function pairsOfRounds(rounds: readonly RoundRef[], pairs: readonly Pair[] = []): Pair[] {
  const out = new Map<string, Pair>(pairs.map((p) => [pairKey(p), p]));
  const add = (p: Pair) => {
    if (!out.has(pairKey(p))) out.set(pairKey(p), p);
  };
  for (const r of rounds) {
    for (const m of r.matches) for (const p of [[m.a1, m.a2], [m.b1, m.b2]] as Pair[]) add(p);
    for (let i = 0; i + 1 < r.resting.length; i += 2) add([r.resting[i], r.resting[i + 1]]);
  }
  return [...out.values()];
}
