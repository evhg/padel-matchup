import { describe, expect, it } from "vitest";
import { computeStandings, mulberry32, rotationLength } from "@/lib/domain/americano";
import { drawRound, firstRoundRefusal, type DrawnRound } from "@/lib/domain/formats";
import { courtsUsed, nightPlan, roundMinutes, rotationRounds } from "@/lib/domain/tournamentPlan";

/**
 * The social tournament night (October 2026): any field of four or more starts round 1 in americano
 * and mexicano, whoever does not fit a court rests in turn, and the night is shown before it is
 * played — courts, rounds, minutes, the end — from one pure function.
 *
 * No clock here: every function under test is pure and takes no date.
 */

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${String(i + 1).padStart(2, "0")}`);

/** Plays a night through `drawRound`, the function `generateRound` calls, scoring each round so mexicano can go on. */
function playNight(format: "americano" | "mexicano", n: number, roundCount: number, courts: number | null = null): DrawnRound[] {
  const field = ids(n);
  const rounds: DrawnRound[] = [];
  const score = mulberry32(n * 31 + roundCount);
  for (let r = 1; r <= roundCount; r++) {
    const plan = drawRound({ eventId: `night-${format}-${n}`, format, ids: field, courts, rounds });
    rounds.push({
      roundNumber: r,
      resting: plan.resting,
      matches: plan.matches.map((m) => {
        const a = Math.floor(score() * 22);
        return { court: m.court, a1: m.a[0], a2: m.a[1], b1: m.b[0], b2: m.b[1], sideA: a, sideB: 21 - Math.min(a, 21) };
      }),
    });
  }
  return rounds;
}

describe("round 1 at any count of four or more", () => {
  it("americano and mexicano start with any field of four or more; king keeps names in fours", () => {
    expect(firstRoundRefusal("americano", 3)).toBe("need_4_players");
    expect(firstRoundRefusal("mexicano", 0)).toBe("need_4_players");
    for (const n of [4, 5, 6, 7, 9, 10, 11, 13, 22]) {
      expect(firstRoundRefusal("americano", n)).toBeNull();
      expect(firstRoundRefusal("mexicano", n)).toBeNull();
    }
    expect(firstRoundRefusal("king", 10)).toBe("multiple_of_4");
    expect(firstRoundRefusal("king", 8)).toBeNull();
  });

  it("every round is valid: four distinct players a court, every court full, everyone either plays or rests, once", () => {
    for (const format of ["americano", "mexicano"] as const) {
      for (let n = 4; n <= 21; n++) {
        const field = ids(n);
        const c = courtsUsed(n);
        for (const r of playNight(format, n, 2 * n)) {
          const where = `${format} n=${n} round ${r.roundNumber}`;
          expect(r.matches.map((m) => m.court).sort((x, y) => x - y), where).toEqual(Array.from({ length: c }, (_, i) => i + 1));
          const playing = r.matches.flatMap((m) => [m.a1, m.a2, m.b1, m.b2]);
          for (const m of r.matches) expect(new Set([m.a1, m.a2, m.b1, m.b2]).size, where).toBe(4);
          expect(r.resting.length, where).toBe(n - 4 * c);
          expect([...playing, ...r.resting].sort(), where).toEqual(field);
        }
      }
    }
  });

  it("rests rotate fairly: nobody rests twice before everyone has rested once", () => {
    for (const format of ["americano", "mexicano"] as const) {
      for (const n of [5, 6, 7, 9, 10, 11, 13, 14, 15, 17, 18, 19]) {
        const rested = new Map(ids(n).map((p) => [p, 0]));
        for (const r of playNight(format, n, 3 * n)) {
          for (const p of r.resting) rested.set(p, rested.get(p)! + 1);
          const counts = [...rested.values()];
          expect(Math.max(...counts) - Math.min(...counts), `${format} n=${n} after round ${r.roundNumber}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("a field limited to fewer courts rests the rest, fairly", () => {
    const rested = new Map(ids(14).map((p) => [p, 0]));
    for (const r of playNight("americano", 14, 7, 2)) {
      expect(r.matches).toHaveLength(2);
      expect(r.resting).toHaveLength(6);
      for (const p of r.resting) rested.set(p, rested.get(p)! + 1);
    }
    // Seven rounds, six rests each: 42 rests over 14 players is three each, exactly.
    expect([...rested.values()].every((v) => v === 3)).toBe(true);
  });

  it("draws the same round twice from the same tournament, and a field in fours keeps its exact rotation", () => {
    const night = playNight("americano", 8, 8);
    const again = playNight("americano", 8, 8);
    expect(again).toEqual(night);
    // Seven rounds: every pair partners exactly once. Round 8 replays round 1.
    const partners = new Map<string, number>();
    for (const r of night.slice(0, 7)) for (const m of r.matches) for (const [x, y] of [[m.a1, m.a2], [m.b1, m.b2]]) partners.set([x, y].sort().join("|"), (partners.get([x, y].sort().join("|")) ?? 0) + 1);
    expect(partners.size).toBe(28);
    expect([...partners.values()].every((v) => v === 1)).toBe(true);
    expect(night[7].matches.map((m) => [m.a1, m.a2, m.b1, m.b2])).toEqual(night[0].matches.map((m) => [m.a1, m.a2, m.b1, m.b2]));
  });

  it("a rested round adds nothing to the table", () => {
    const night = playNight("americano", 5, 5);
    const all = night.flatMap((r) => r.matches);
    const table = computeStandings(ids(5), all);
    for (const p of ids(5)) {
      const row = table.find((x) => x.playerId === p)!;
      const mine = all.filter((m) => [m.a1, m.a2, m.b1, m.b2].includes(p));
      const points = mine.reduce((s, m) => s + ([m.a1, m.a2].includes(p) ? m.sideA! : m.sideB!), 0);
      expect(row.played).toBe(mine.length);
      expect(row.played).toBe(5 - night.filter((r) => r.resting.includes(p)).length);
      expect(row.points).toBe(points);
    }
  });
});

describe("the night at a glance", () => {
  it("a round's minutes at each score: about forty seconds a point, four minutes a game, two to change over", () => {
    expect(roundMinutes({ pointsPerMatch: 16 })).toBe(13);
    expect(roundMinutes({ pointsPerMatch: 21 })).toBe(16);
    expect(roundMinutes({ pointsPerMatch: 24 })).toBe(18);
    expect(roundMinutes({ pointsPerMatch: 32 })).toBe(24);
    expect(roundMinutes({ gamesTo: 4 })).toBe(28);
    expect(roundMinutes({ gamesTo: 6 })).toBe(41);
    expect(roundMinutes({ pointsPerMatch: null, gamesTo: null })).toBeNull();
  });

  it("a full rotation is the exact one for a field in fours, and the fewest rounds that could do it with rests", () => {
    for (let n = 4; n <= 64; n += 4) expect(rotationRounds(n)).toBe(rotationLength(n));
    expect(rotationRounds(5)).toBe(5);
    expect(rotationRounds(10)).toBe(12);
    expect(rotationRounds(16, 2)).toBe(30);
    expect(rotationRounds(3)).toBeNull();
  });

  it("eight players at 21 points fill two courts and finish the rotation inside two hours", () => {
    expect(nightPlan({ players: 8, format: "americano", pointsPerMatch: 21, durationMinutes: 120 })).toEqual({
      players: 8,
      courts: 2,
      resting: 0,
      rotation: 7,
      roundMinutes: 16,
      rotationMinutes: 112,
      fits: 7,
      rounds: 7,
      tooLong: false,
    });
  });

  it("sixteen at 32 points run past two hours, so the night is the rounds that fit", () => {
    const plan = nightPlan({ players: 16, format: "americano", pointsPerMatch: 32, durationMinutes: 120 })!;
    expect(plan).toMatchObject({ courts: 4, rotation: 15, rotationMinutes: 360, fits: 5, rounds: 5, tooLong: true });
  });

  it("ten players rest two a round; mexicano and king count the rounds that fit; free scoring knows no minutes", () => {
    expect(nightPlan({ players: 10, format: "americano", gamesTo: 4, durationMinutes: 90 })).toMatchObject({ courts: 2, resting: 2, rotation: 12, roundMinutes: 28, fits: 3, rounds: 3, tooLong: true });
    expect(nightPlan({ players: 8, format: "mexicano", pointsPerMatch: 24, durationMinutes: 120 })).toMatchObject({ rotation: null, fits: 6, rounds: 6, tooLong: false });
    expect(nightPlan({ players: 8, format: "americano", durationMinutes: 120 })).toMatchObject({ roundMinutes: null, rotation: 7, rounds: 7, tooLong: false });
    expect(nightPlan({ players: 8, format: "king", durationMinutes: 120 })).toMatchObject({ rounds: null, tooLong: false });
    expect(nightPlan({ players: 3, format: "americano", durationMinutes: 120 })).toBeNull();
  });
});
