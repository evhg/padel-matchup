import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mulberry32 } from "@/lib/domain/americano";
import { drawRound, type DrawnRound } from "@/lib/domain/formats";
import { computeKingPairStandings, computePairStandings, pairCourts, pairKey, pairRotation, pairRotationRounds, pairRowsToPlayers, pairsRefusal, seatUnits, type Pair } from "@/lib/domain/fixedPairs";
import { nightField, nightPlan } from "@/lib/domain/tournamentPlan";

/**
 * Fixed pairs (the owner's decision F, 9 October 2026): the pair is the unit of a social night. Whole
 * nights of 2 to 8 pairs, played through `drawRound` — the function `generateRound` calls — prove the
 * three promises: every pair meets every other pair as evenly as the courts allow, nobody's pair rests
 * twice before every pair has rested once, and the same night always draws the same rounds.
 *
 * No clock here: every function under test is pure and takes no date.
 */

const pairsOf = (n: number): Pair[] => Array.from({ length: n }, (_, i) => [`p${i + 1}a`, `p${i + 1}b`] as const);
type Format = "americano" | "mexicano" | "king";

/** Plays a night, scoring every round so mexicano and king can go on. */
function playNight(format: Format, n: number, roundCount: number, courts: number | null = null): DrawnRound[] {
  const pairs = pairsOf(n);
  const ids = pairs.flat();
  const rounds: DrawnRound[] = [];
  const score = mulberry32(n * 17 + roundCount);
  for (let r = 1; r <= roundCount; r++) {
    const plan = drawRound({ eventId: `pairs-${format}-${n}`, format, ids, courts, rounds, pairs });
    rounds.push({
      roundNumber: r,
      resting: plan.resting,
      matches: plan.matches.map((m) => {
        const a = Math.floor(score() * 22);
        return { court: m.court, a1: m.a[0], a2: m.a[1], b1: m.b[0], b2: m.b[1], sideA: a, sideB: a === 11 ? 10 : 21 - Math.min(a, 21) };
      }),
    });
  }
  return rounds;
}

const meetings = (rounds: readonly DrawnRound[]) => {
  const met = new Map<string, number>();
  for (const r of rounds) for (const m of r.matches) {
    const k = [pairKey([m.a1, m.a2]), pairKey([m.b1, m.b2])].sort().join(" v ");
    met.set(k, (met.get(k) ?? 0) + 1);
  }
  return met;
};

describe("fixed pairs: every round is valid", () => {
  it("partners stay together, every court holds two pairs, every pair plays or rests, once", () => {
    for (const format of ["americano", "mexicano", "king"] as const) {
      for (let n = 2; n <= 8; n++) {
        const pairs = pairsOf(n);
        const partner = new Map(pairs.flatMap((p) => [[p[0], p[1]], [p[1], p[0]]]));
        const c = pairCourts(n);
        for (const r of playNight(format, n, 3 * n)) {
          const where = `${format} ${n} pairs, round ${r.roundNumber}`;
          expect(r.matches.map((m) => m.court).sort((x, y) => x - y), where).toEqual(Array.from({ length: c }, (_, i) => i + 1));
          for (const m of r.matches) {
            expect(partner.get(m.a1), where).toBe(m.a2);
            expect(partner.get(m.b1), where).toBe(m.b2);
          }
          // An odd number of pairs rests one pair a round: both its players.
          expect(r.resting.length, where).toBe(2 * (n - 2 * c));
          for (const id of r.resting) expect(r.resting, where).toContain(partner.get(id));
          expect([...r.matches.flatMap((m) => [m.a1, m.a2, m.b1, m.b2]), ...r.resting].sort(), where).toEqual(pairs.flat().sort());
        }
      }
    }
  });
});

describe("fixed pairs: fairness for 2 to 8 pairs", () => {
  /**
   * The table the owner can read: on every court the field fills, americano with fixed pairs is the
   * exact round robin. P even: P − 1 rounds, no rests, every pair meets every other once. P odd: P
   * rounds, each pair rests exactly once and meets every other once.
   */
  const table: { pairs: number; courts: number; restingPerRound: number; rotation: number }[] = [
    { pairs: 2, courts: 1, restingPerRound: 0, rotation: 1 },
    { pairs: 3, courts: 1, restingPerRound: 1, rotation: 3 },
    { pairs: 4, courts: 2, restingPerRound: 0, rotation: 3 },
    { pairs: 5, courts: 2, restingPerRound: 1, rotation: 5 },
    { pairs: 6, courts: 3, restingPerRound: 0, rotation: 5 },
    { pairs: 7, courts: 3, restingPerRound: 1, rotation: 7 },
    { pairs: 8, courts: 4, restingPerRound: 0, rotation: 7 },
  ];

  it("americano: one rotation is the exact round robin, and the next rotation repeats it", () => {
    for (const row of table) {
      expect(pairCourts(row.pairs), `${row.pairs} pairs`).toBe(row.courts);
      expect(pairRotationRounds(row.pairs), `${row.pairs} pairs`).toBe(row.rotation);
      const night = playNight("americano", row.pairs, 2 * row.rotation);
      const first = night.slice(0, row.rotation);
      const met = meetings(first);
      // Every pair against every other pair, exactly once.
      expect(met.size, `${row.pairs} pairs`).toBe((row.pairs * (row.pairs - 1)) / 2);
      expect([...met.values()].every((v) => v === 1), `${row.pairs} pairs`).toBe(true);
      // Each pair rests exactly once in an odd field's rotation, never in an even one.
      const rests = new Map(pairsOf(row.pairs).map((p) => [p[0], 0]));
      for (const r of first) for (const id of r.resting) if (rests.has(id)) rests.set(id, rests.get(id)! + 1);
      expect([...rests.values()].every((v) => v === row.restingPerRound), `${row.pairs} pairs`).toBe(true);
      // The second rotation plays the first again, round for round.
      expect(night.slice(row.rotation).map((r) => r.matches.map((m) => [m.a1, m.b1]))).toEqual(first.map((r) => r.matches.map((m) => [m.a1, m.b1])));
    }
  });

  it("every format: nobody's pair rests twice before every pair has rested once", () => {
    for (const format of ["americano", "mexicano", "king"] as const) {
      for (let n = 2; n <= 8; n++) {
        const rested = new Map(pairsOf(n).map((p) => [p[0], 0]));
        for (const r of playNight(format, n, 3 * n + 1)) {
          for (const id of r.resting) if (rested.has(id)) rested.set(id, rested.get(id)! + 1);
          const counts = [...rested.values()];
          expect(Math.max(...counts) - Math.min(...counts), `${format} ${n} pairs after round ${r.roundNumber}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("on fewer courts than the field fills, rests stay fair and every pair meets every other once", () => {
    // Eight pairs on two courts: four play, four rest; 28 meetings at two a round is fourteen rounds.
    expect(pairRotationRounds(8, 2)).toBe(14);
    const night = playNight("americano", 8, 14, 2);
    const rested = new Map(pairsOf(8).map((p) => [p[0], 0]));
    for (const r of night) {
      expect(r.matches).toHaveLength(2);
      for (const id of r.resting) if (rested.has(id)) rested.set(id, rested.get(id)! + 1);
    }
    // Fourteen rounds, four pairs resting: 56 rests over eight pairs is seven each, exactly.
    expect([...rested.values()].every((v) => v === 7)).toBe(true);
    const met = meetings(night);
    expect(met.size).toBe(28);
    expect([...met.values()].every((v) => v === 1)).toBe(true);
  });

  /** A night of `rounds` on `courts` for event `eventId`: the meetings, and whether every rest stayed fair after every round. */
  const onCourts = (n: number, courts: number, rounds: number, eventId: string) => {
    const pairs = pairsOf(n);
    const night: DrawnRound[] = [];
    const rested = new Map(pairs.map((p) => [p[0], 0]));
    let fair = true;
    for (let r = 1; r <= rounds; r++) {
      const plan = drawRound({ eventId, format: "americano", ids: pairs.flat(), courts, rounds: night, pairs });
      night.push({ roundNumber: r, resting: plan.resting, matches: plan.matches.map((m) => ({ court: m.court, a1: m.a[0], a2: m.a[1], b1: m.b[0], b2: m.b[1], sideA: 21, sideB: 15 })) });
      for (const id of plan.resting) if (rested.has(id)) rested.set(id, rested.get(id)! + 1);
      if (Math.max(...rested.values()) - Math.min(...rested.values()) > 1) fair = false;
    }
    return { night, fair };
  };

  it("one court: four pairs meet each other once in six rounds and five pairs in ten, whatever the event, with fair rests", () => {
    // The reviewer's measured nights: before the night was planned ahead, 4 pairs met 4 of 6 times and 5 pairs 6 of 10.
    for (const eventId of ["ev-1", "ev-2", "ev-3", "night-a", "night-b", "phuket-friday"]) {
      for (const [n, rounds] of [
        [4, 6],
        [5, 10],
      ] as const) {
        const { night, fair } = onCourts(n, 1, rounds, eventId);
        const met = meetings(night);
        expect(met.size, `${n} pairs, ${eventId}`).toBe((n * (n - 1)) / 2);
        expect([...met.values()].every((v) => v === 1), `${n} pairs, ${eventId}`).toBe(true);
        expect(fair, `${n} pairs, ${eventId}`).toBe(true);
      }
    }
  });

  it("where the courts force a repeat, every meeting comes first and the repeat waits for the last round", () => {
    // Six pairs on two courts: fifteen meetings, sixteen places in eight rounds.
    for (const eventId of ["ev-1", "ev-2", "ev-3"]) {
      const { night, fair } = onCourts(6, 2, 8, eventId);
      const before = meetings(night.slice(0, 7));
      expect([...before.values()].every((v) => v === 1), eventId).toBe(true);
      expect(meetings(night).size, eventId).toBe(15);
      expect(fair, eventId).toBe(true);
    }
  });

  it("a field that loses a pair after round 1 leaves the circle: rests stay fair, no meeting twice before every meeting, no rotation promised", () => {
    for (const eventId of ["demo", "ev-1", "ev-7"]) {
      // Seven pairs on every court: the circle, which promises seven rounds.
      let pairs = pairsOf(7);
      const night: DrawnRound[] = [];
      const play = (r: number) => {
        const plan = drawRound({ eventId, format: "americano", ids: pairs.flat(), courts: null, rounds: night, pairs });
        night.push({ roundNumber: r, resting: plan.resting, matches: plan.matches.map((m) => ({ court: m.court, a1: m.a[0], a2: m.a[1], b1: m.b[0], b2: m.b[1], sideA: 21, sideB: 15 })) });
      };
      play(1);
      expect(pairRotation({ eventId, pairs, courts: null, rounds: night })).toBe(7);
      // A pair that played round 1 goes home: six pairs, every court full.
      const gone = pairKey([night[0].matches[0].a1, night[0].matches[0].a2]);
      pairs = pairs.filter((p) => pairKey(p) !== gone);
      expect(pairRotation({ eventId, pairs, courts: null, rounds: night }), eventId).toBeNull();
      const keys = new Set(pairs.map(pairKey));
      const among = (rounds: DrawnRound[]) => meetings(rounds.map((r) => ({ ...r, matches: r.matches.filter((m) => keys.has(pairKey([m.a1, m.a2])) && keys.has(pairKey([m.b1, m.b2]))) })));
      for (let r = 2; r <= 7; r++) {
        play(r);
        const met = among(night);
        // A meeting twice only once all fifteen are played.
        if (met.size < 15) expect([...met.values()].every((v) => v === 1), `${eventId} round ${r}`).toBe(true);
      }
      expect(among(night).size, eventId).toBe(15);
    }
  });

  it("a night of rotating partners draws exactly as it did before fixed pairs: 630 nights, hashed", () => {
    // The hash of these 630 nights (three formats, 4 to 17 players, fifteen events, four rounds each,
    // one court on every third event) as drawn by 69c3d3f, the main before decision F. A rotating night
    // must not move by one player because fixed pairs exist.
    const hash = createHash("sha256");
    let nights = 0;
    for (const format of ["americano", "mexicano", "king"] as const)
      for (let n = 4; n <= 17; n++)
        for (let e = 0; e < 15; e++) {
          const ids = Array.from({ length: n }, (_, i) => `p${i}`);
          const score = mulberry32(n * 101 + e);
          const rounds: DrawnRound[] = [];
          for (let r = 1; r <= 4; r++) {
            const plan = drawRound({ eventId: `golden-${e}`, format, ids, courts: e % 3 === 0 ? 1 : null, rounds });
            rounds.push({
              roundNumber: r,
              resting: plan.resting,
              matches: plan.matches.map((m) => {
                const a = Math.floor(score() * 22);
                return { court: m.court, a1: m.a[0], a2: m.a[1], b1: m.b[0], b2: m.b[1], sideA: a, sideB: 21 - Math.min(a, 21) };
              }),
            });
          }
          hash.update(JSON.stringify(rounds));
          nights++;
        }
    expect(nights).toBe(630);
    expect(hash.digest("hex")).toBe("b6f1936a7fde767077760ba4559f49b709022c084de5877d7049320fdd339b8a");
  });

  it("draws the same night twice from the same event", () => {
    for (const format of ["americano", "mexicano", "king"] as const) expect(playNight(format, 5, 6)).toEqual(playNight(format, 5, 6));
  });

  it("the pairs are read in any order: the seats' order does not change the draw", () => {
    const pairs = pairsOf(6);
    const a = drawRound({ eventId: "order", format: "americano", ids: pairs.flat(), courts: null, rounds: [], pairs });
    const b = drawRound({ eventId: "order", format: "americano", ids: pairs.flat(), courts: null, rounds: [], pairs: [...pairs].reverse().map((p) => [p[1], p[0]] as const) });
    expect(b.matches.map((m) => [pairKey(m.a), pairKey(m.b)])).toEqual(a.matches.map((m) => [pairKey(m.a), pairKey(m.b)]));
  });
});

describe("fixed pairs: mexicano and king follow the table", () => {
  it("mexicano puts the pairs' first against second on court 1, and waits for the scores", () => {
    const night = playNight("mexicano", 4, 2);
    const table = computePairStandings(pairsOf(4), night[0].matches);
    const court1 = night[1].matches.find((m) => m.court === 1)!;
    expect([pairKey([court1.a1, court1.a2]), pairKey([court1.b1, court1.b2])].sort()).toEqual([table[0].key, table[1].key].sort());
    const pairs = pairsOf(4);
    const unscored = [{ ...night[0], matches: night[0].matches.map((m) => ({ ...m, sideA: null, sideB: null })) }];
    expect(() => drawRound({ eventId: "x", format: "mexicano", ids: pairs.flat(), courts: null, rounds: unscored, pairs })).toThrow("scores_missing");
  });

  it("king moves the winning pair up a court and the losing pair down", () => {
    const pairs = pairsOf(4);
    const r1 = playNight("king", 4, 1)[0];
    // Court 2's winners beat court 1's losers to a place on court 1.
    const c1 = r1.matches.find((m) => m.court === 1)!;
    const c2 = r1.matches.find((m) => m.court === 2)!;
    const win = (m: typeof c1) => (m.sideA! > m.sideB! ? pairKey([m.a1, m.a2]) : pairKey([m.b1, m.b2]));
    const lose = (m: typeof c1) => (m.sideA! > m.sideB! ? pairKey([m.b1, m.b2]) : pairKey([m.a1, m.a2]));
    const r2 = drawRound({ eventId: "pairs-king-4", format: "king", ids: pairs.flat(), courts: null, rounds: [r1], pairs });
    const onCourt = (court: number) => r2.matches.filter((m) => m.court === court).flatMap((m) => [pairKey(m.a), pairKey(m.b)]).sort();
    expect(onCourt(1)).toEqual([win(c1), win(c2)].sort());
    expect(onCourt(2)).toEqual([lose(c1), lose(c2)].sort());
    const table = computeKingPairStandings(pairs, [r1, { roundNumber: 2, resting: [], matches: r2.matches.map((m) => ({ court: m.court, a1: m.a[0], a2: m.a[1], b1: m.b[0], b2: m.b[1], sideA: 21, sideB: 10 })) }]);
    expect(table[0].court).toBe(1);
    expect(table.at(-1)!.court).toBe(2);
  });
});

describe("fixed pairs: the table ranks pairs", () => {
  it("both partners carry their pair's numbers; a rest adds nothing", () => {
    const night = playNight("americano", 3, 3);
    const table = computePairStandings(pairsOf(3), night.flatMap((r) => r.matches));
    expect(table).toHaveLength(3);
    for (const row of table) expect(row.played).toBe(2);
    const players = pairRowsToPlayers(table);
    expect(players).toHaveLength(6);
    for (const row of table) {
      const mine = players.filter((p) => row.pair.includes(p.playerId));
      expect(mine.map((p) => p.rank)).toEqual([row.rank, row.rank]);
      expect(mine.map((p) => p.points)).toEqual([row.points, row.points]);
    }
  });

  it("first to N games ranks pairs by wins", () => {
    const pairs = pairsOf(2);
    const table = computePairStandings(pairs, [{ a1: "p1a", a2: "p1b", b1: "p2a", b2: "p2b", sideA: 4, sideB: 3 }, { a1: "p1a", a2: "p1b", b1: "p2a", b2: "p2b", sideA: 0, sideB: 4 }, { a1: "p2a", a2: "p2b", b1: "p1a", b2: "p1b", sideA: 1, sideB: 4 }], { byWins: true });
    expect(table[0].key).toBe(pairKey(pairs[0]));
    expect(table[0].wins).toBe(2);
  });
});

describe("fixed pairs: the seats and round 1", () => {
  const seat = (id: string, position: number, pairId: string | null, status = "joined") => ({ id, position, pairId, status });

  it("two named seats sharing a key are a pair; a key nobody shares, or none, is a single", () => {
    const units = seatUnits([seat("a", 1, "k1"), seat("c", 2, null), seat("b", 3, "k1"), seat("d", 4, "k2"), seat("e", 5, "k3", "empty"), seat("f", 6, "k3"), seat("g", 7, null, "empty")]);
    expect(units.map((u) => (u.kind === "pair" ? u.seats.map((s) => s.id).join("&") : u.seat.id))).toEqual(["a&b", "c", "d", "f"]);
    // A reserved partner is named: the pair is complete until the partner declines.
    expect(seatUnits([seat("a", 1, "k"), seat("b", 2, "k", "invited")])[0].kind).toBe("pair");
    expect(seatUnits([seat("a", 1, "k"), seat("b", 2, "k", "declined")]).map((u) => u.kind)).toEqual(["single"]);
  });

  it("round 1 takes any number of complete pairs from two, and no pair without a partner", () => {
    expect(pairsRefusal(1, 0)).toBe("need_2_pairs");
    expect(pairsRefusal(0, 0)).toBe("need_2_pairs");
    expect(pairsRefusal(4, 1)).toBe("partner_needed");
    for (let n = 2; n <= 32; n++) expect(pairsRefusal(n, 0)).toBeNull();
  });

  it("the night at a glance speaks of pairs", () => {
    // Five pairs, two courts: one pair rests a round, five rounds make the round robin.
    expect(nightPlan({ players: 10, format: "americano", fixedPairs: true, pointsPerMatch: 21, durationMinutes: 120 })).toEqual({
      players: 10,
      pairs: 5,
      courts: 2,
      resting: 1,
      rotation: 5,
      roundMinutes: 16,
      rotationMinutes: 80,
      fits: 7,
      rounds: 5,
      tooLong: false,
    });
    // Two pairs fill one court; one pair alone is no night.
    expect(nightPlan({ players: 4, format: "king", fixedPairs: true, durationMinutes: 120 })?.courts).toBe(1);
    expect(nightPlan({ players: 2, format: "americano", fixedPairs: true, durationMinutes: 120 })).toBeNull();
    // Before round 1 the field is the complete pairs when there are two, else the field opened. King keeps no fours with pairs.
    expect(nightField({ format: "king", names: 6, capacity: 12, roundsDrawn: 0, fixedPairs: true })).toBe(6);
    expect(nightField({ format: "americano", names: 2, capacity: 12, roundsDrawn: 0, fixedPairs: true })).toBe(12);
  });
});
