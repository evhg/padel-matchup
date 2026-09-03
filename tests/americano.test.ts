import { describe, expect, it } from "vitest";
import { buildHistory, computeStandings, mulberry32, planRound, type RoundRef } from "@/lib/domain/americano";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${String(i + 1).padStart(2, "0")}`);

function simulate(n: number, courts: number | null, rounds: number, seed = 7): RoundRef[] {
  const players = ids(n);
  const rnd = mulberry32(seed);
  const history: RoundRef[] = [];
  for (let r = 0; r < rounds; r++) {
    const plan = planRound(players, courts, buildHistory(history), rnd);
    history.push({ matches: plan.matches.map((m) => ({ a1: m.a[0], a2: m.a[1], b1: m.b[0], b2: m.b[1], sideA: null, sideB: null })), resting: plan.resting });
  }
  return history;
}

function partnerRepeats(rounds: RoundRef[]) {
  const seen = new Map<string, number>();
  let repeats = 0;
  for (const r of rounds)
    for (const m of r.matches)
      for (const [p, q] of [
        [m.a1, m.a2],
        [m.b1, m.b2],
      ]) {
        const k = p < q ? `${p}|${q}` : `${q}|${p}`;
        if (seen.has(k)) repeats++;
        seen.set(k, 1);
      }
  return repeats;
}

describe("americano round generation", () => {
  it("uses every player exactly once per round on full courts", () => {
    const rounds = simulate(8, 2, 5);
    for (const r of rounds) {
      const used = r.matches.flatMap((m) => [m.a1, m.a2, m.b1, m.b2]);
      expect(new Set(used).size).toBe(8);
      expect(r.resting).toEqual([]);
      expect(r.matches.map((m) => m.a1).length).toBe(2);
    }
  });

  it("rotates partners: 8 players, 2 courts, 5 rounds → no repeated partners", () => {
    expect(partnerRepeats(simulate(8, 2, 5))).toBe(0);
  });

  it("keeps partner repeats minimal over a long session (8 players, 7 rounds)", () => {
    expect(partnerRepeats(simulate(8, 2, 7))).toBeLessThanOrEqual(2);
  });

  it("spreads sit-outs fairly: 6 players on 1 court, 3 rounds → everyone rests exactly once", () => {
    const rounds = simulate(6, 1, 3);
    const rested = new Map<string, number>();
    for (const r of rounds) {
      expect(r.resting).toHaveLength(2);
      for (const p of r.resting) rested.set(p, (rested.get(p) ?? 0) + 1);
    }
    expect([...rested.values()]).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("spreads sit-outs fairly: 5 players, 5 rounds → everyone rests exactly once", () => {
    const rounds = simulate(5, 1, 5);
    const rested = new Map<string, number>();
    for (const r of rounds) for (const p of r.resting) rested.set(p, (rested.get(p) ?? 0) + 1);
    expect(rested.size).toBe(5);
    expect([...rested.values()].every((v) => v === 1)).toBe(true);
  });

  it("clamps courts to the number of full foursomes", () => {
    const [r] = simulate(10, 5, 1);
    expect(r.matches).toHaveLength(2);
    expect(r.resting).toHaveLength(2);
    const [r2] = simulate(12, null, 1);
    expect(r2.matches).toHaveLength(3);
  });

  it("refuses fewer than 4 players", () => {
    expect(() => planRound(ids(3), 1, buildHistory([]), mulberry32(1))).toThrow();
  });

  it("is deterministic for a given seed", () => {
    const a = simulate(8, 2, 3, 42);
    const b = simulate(8, 2, 3, 42);
    expect(a).toEqual(b);
  });
});

describe("americano standings", () => {
  const players = ids(4);
  it("sums points per player, tracks diff and wins, ranks ties equally", () => {
    const rows = computeStandings(players, [
      { a1: "p01", a2: "p02", b1: "p03", b2: "p04", sideA: 16, sideB: 8 },
      { a1: "p01", a2: "p03", b1: "p02", b2: "p04", sideA: 12, sideB: 12 },
      { a1: "p01", a2: "p04", b1: "p02", b2: "p03", sideA: null, sideB: null }, // unscored, ignored
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.playerId, r]));
    expect(by.p01).toMatchObject({ points: 28, played: 2, wins: 1, draws: 1, losses: 0, diff: 8, rank: 1 });
    expect(by.p02).toMatchObject({ points: 28, played: 2, wins: 1, draws: 1, diff: 8, rank: 1 });
    expect(by.p03).toMatchObject({ points: 20, played: 2, wins: 0, losses: 1, draws: 1, diff: -8, rank: 3 });
    expect(by.p04).toMatchObject({ points: 20, rank: 3 });
    expect(rows.map((r) => r.playerId)).toEqual(["p01", "p02", "p03", "p04"]);
  });
  it("includes players with no matches yet at zero", () => {
    const rows = computeStandings(["x", "y"], []);
    expect(rows.map((r) => [r.playerId, r.points, r.rank])).toEqual([
      ["x", 0, 1],
      ["y", 0, 1],
    ]);
  });
});
