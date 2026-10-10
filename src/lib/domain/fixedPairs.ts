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

/** Round 1 of mexicano and king, and americano on fewer courts than the field fills. */
function fairRound(pairs: readonly Pair[], courts: number | null | undefined, h: PairHistory, rnd: () => number): RoundPlan {
  const c = pairCourts(pairs.length, courts);
  const resting = restingPairs(pairs, h, pairs.length - 2 * c, rnd, (x, y) => (h.played.get(pairKey(y)) ?? 0) - (h.played.get(pairKey(x)) ?? 0));
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

/**
 * The next round of a fixed-pairs night, in any format: what `drawRound` returns when the night keeps
 * its partners. The seeds are the event's and the round's, as for rotating partners; the circle's
 * order is seeded per event from the pairs sorted by key, so the same pairs always meet in the same
 * order whatever order the seats list them in.
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
  if (pairCourts(pairs.length, courts) === Math.floor(pairs.length / 2)) {
    const ordered = seededShuffle(pairs, mulberry32(seedFrom(`${eventId}:pairs`)));
    const r = roundRobin(ordered, roundNumber - 1);
    return { matches: r.matches, resting: r.resting.flat() };
  }
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
