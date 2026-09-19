import { describe, expect, it } from "vitest";
import { bracketOrder, checkScore, groupTable, planDraw, progress, roundKey, roundRobin, scoreText, splitGroups, type Entrant, type MatchLike } from "@/lib/domain/draw";

const entrants = (n: number, seeds: Record<number, number> = {}): Entrant[] => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, seed: seeds[i + 1] ?? null, wildcard: false, order: i + 1 }));
const cfg = { format: "groups_knockout" as const, maxPairs: 8, groupSize: 4, groupsThrough: 2, consolation: true, qualifyingSpots: 0, seed: "test" };
let nextId = 1;
const rows = (planned: ReturnType<typeof planDraw>["matches"]): MatchLike[] => planned.map((m) => ({ ...m, id: `m${nextId++}`, status: "pending", winner: null, scoreA: null, scoreB: null }));
const key = (m: MatchLike) => `${m.phase}:${m.round}:${m.position}`;

describe("scoring per phase", () => {
  it("accepts the sets each rule allows and nothing else", () => {
    expect(checkScore("set6tb", [6], [4])).toMatchObject({ ok: true, winner: "A" });
    expect(checkScore("set6tb", [7], [6])).toMatchObject({ ok: true, winner: "A" });
    expect(checkScore("set6tb", [5], [7])).toMatchObject({ ok: true, winner: "B" });
    expect(checkScore("set6tb", [6], [5])).toEqual({ ok: false, reason: "set" });
    expect(checkScore("set6tb", [8], [6])).toEqual({ ok: false, reason: "set" });
    expect(checkScore("set6tb", [6, 6], [4, 4])).toEqual({ ok: false, reason: "shape" });
    expect(checkScore("set9", [9], [7])).toMatchObject({ ok: true, winner: "A" });
    expect(checkScore("set9", [8], [9])).toMatchObject({ ok: true, winner: "B" });
    expect(checkScore("set9", [10], [8])).toEqual({ ok: false, reason: "set" });
    expect(checkScore("set9", [9], [8])).toMatchObject({ ok: true });
    expect(checkScore("sets2stb", [6, 6], [4, 3])).toMatchObject({ ok: true, winner: "A", setsA: 2, setsB: 0 });
    expect(checkScore("sets2stb", [6, 3, 10], [4, 6, 8])).toMatchObject({ ok: true, winner: "A" });
    expect(checkScore("sets2stb", [6, 3, 6], [4, 6, 4])).toEqual({ ok: false, reason: "set" }); // the third is a super tie-break
    expect(checkScore("sets2stb", [6, 6, 6], [4, 3, 2])).toEqual({ ok: false, reason: "sets" }); // one set too many
    expect(checkScore("sets2stb", [6], [4])).toEqual({ ok: false, reason: "sets" }); // not decided
    expect(checkScore("sets3", [6, 3, 7], [4, 6, 5])).toMatchObject({ ok: true, winner: "A" });
    expect(checkScore("sets3", [6, 3, 10], [4, 6, 8])).toEqual({ ok: false, reason: "set" });
    expect(scoreText([6, 3, 10], [4, 6, 8])).toBe("6-4 3-6 10-8");
  });
});

describe("the plan", () => {
  it("seeds a bracket so the top two meet last, and gives byes to the top seeds", () => {
    expect(bracketOrder(4)).toEqual([1, 4, 2, 3]);
    expect(bracketOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(bracketOrder(16)[0]).toBe(1);
    expect(bracketOrder(16)[8]).toBe(2); // the second seed opens the other half
  });

  it("splits a field into groups snake-wise and plays everyone against everyone", () => {
    expect(splitGroups(["1", "2", "3", "4", "5", "6", "7", "8"], 4)).toEqual([
      ["1", "4", "5", "8"],
      ["2", "3", "6", "7"],
    ]);
    expect(splitGroups(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"], 5)).toEqual([
      ["1", "4", "5", "8", "9"],
      ["2", "3", "6", "7", "10"],
    ]);
    expect(splitGroups(["1", "2", "3", "4", "5", "6", "7"], 4).map((g) => g.length)).toEqual([3, 4]); // the snake leaves the first group short
    const rr = roundRobin(["a", "b", "c", "d"]);
    expect(rr).toHaveLength(3);
    expect(rr.flat()).toHaveLength(6);
    const seen = new Set(rr.flat().map(([x, y]) => [x, y].sort().join("-")));
    expect(seen.size).toBe(6);
    for (const round of rr) expect(new Set(round.flat()).size).toBe(4); // nobody twice in a round
    const odd = roundRobin(["a", "b", "c", "d", "e"]);
    expect(odd).toHaveLength(5);
    expect(odd.flat()).toHaveLength(10);
  });

  it("plans groups then a knockout with the rest in the consolation, seeds in different groups", () => {
    const plan = planDraw(entrants(8, { 1: 1, 2: 2 }), cfg);
    expect(plan.groups.map((g) => g.pairIds.length)).toEqual([4, 4]);
    expect(plan.groups[0].pairIds).toContain("p1");
    expect(plan.groups[1].pairIds).toContain("p2");
    expect(plan.matches.filter((m) => m.phase === "group")).toHaveLength(12);
    const main = plan.matches.filter((m) => m.phase === "main");
    expect(main.map((m) => [m.round, m.sourceA, m.sourceB])).toEqual([
      [1, "G:A:1", "G:B:2"],
      [1, "G:B:1", "G:A:2"],
      [2, "W:main:1:1", "W:main:1:2"],
    ]);
    const cons = plan.matches.filter((m) => m.phase === "consolation");
    expect(cons.map((m) => [m.round, m.sourceA, m.sourceB])).toEqual([
      [1, "G:A:3", "G:B:4"],
      [1, "G:B:3", "G:A:4"],
      [2, "W:consolation:1:1", "W:consolation:1:2"],
    ]);
    expect(plan.out).toEqual([]);
    // The same seed gives the same draw; another seed may not.
    expect(planDraw(entrants(8, { 1: 1, 2: 2 }), cfg)).toEqual(plan);
  });

  it("plans a straight knockout with byes for the top seeds and the first-round losers in the consolation", () => {
    const plan = planDraw(entrants(6, { 1: 1, 2: 2 }), { ...cfg, format: "knockout" });
    const r1 = plan.matches.filter((m) => m.phase === "main" && m.round === 1);
    expect(r1).toHaveLength(4);
    expect(r1.filter((m) => m.bye).map((m) => m.pairA ?? m.pairB)).toEqual(["p1", "p2"]);
    expect(plan.matches.filter((m) => m.phase === "main").map((m) => m.round)).toEqual([1, 1, 1, 1, 2, 2, 3]);
    const cons = plan.matches.filter((m) => m.phase === "consolation");
    expect(cons).toHaveLength(1);
    expect([cons[0].sourceA, cons[0].sourceB].sort()).toEqual(["L:main:1:2", "L:main:1:4"]); // the matches that were played, not the byes
  });

  it("plans a qualifying knockout for the spots past the direct entries, feeding the main draw", () => {
    const plan = planDraw(entrants(7, { 1: 1 }), { ...cfg, format: "knockout", maxPairs: 4, qualifyingSpots: 2, consolation: false });
    expect(plan.direct).toHaveLength(2);
    expect(plan.qualifying).toHaveLength(5);
    const q = plan.matches.filter((m) => m.phase === "qualifying");
    expect(q.map((m) => m.round)).toEqual([1, 1, 1, 1, 2, 2]); // eight slots, three byes, two rounds for two spots
    expect(q.filter((m) => m.round === 1 && m.bye)).toHaveLength(3);
    const main = plan.matches.filter((m) => m.phase === "main" && m.round === 1);
    expect(main.flatMap((m) => [m.sourceA, m.sourceB]).filter(Boolean).sort()).toEqual(["Q:1", "Q:2"]);
    // Fewer beyond the direct entries than spots: they are in, no qualifying.
    const easy = planDraw(entrants(4), { ...cfg, format: "knockout", maxPairs: 4, qualifyingSpots: 2, consolation: false });
    expect(easy.matches.filter((m) => m.phase === "qualifying")).toHaveLength(0);
    expect(easy.matches.filter((m) => m.phase === "main" && m.round === 1).every((m) => m.pairA && m.pairB)).toBe(true);
    // Past the field with no qualifying: out — and it is the waiting-list pair, never one of the field.
    const nine = entrants(9).map((e) => (e.id === "p9" ? { ...e, tier: 1 as const } : e));
    expect(planDraw(nine, cfg).out).toEqual(["p9"]);
    expect(planDraw(nine, { ...cfg, format: "knockout", maxPairs: 4, qualifyingSpots: 2 }).qualifying).toContain("p9");
  });

  it("refuses settings that make no sense", () => {
    expect(() => planDraw(entrants(8), { ...cfg, groupsThrough: 4 })).toThrow("groupsThrough");
    expect(() => planDraw(entrants(8), { ...cfg, qualifyingSpots: 3 })).toThrow("qualifyingSpots");
  });
});

describe("tables and progression", () => {
  it("ranks a group by wins, then the match between two tied pairs, then sets and games", () => {
    const plan = planDraw(entrants(4), { ...cfg, maxPairs: 4, consolation: false });
    const ms = rows(plan.matches);
    const group = ms.filter((m) => m.phase === "group");
    const done = (m: MatchLike, a: number[], b: number[]) => Object.assign(m, { status: "done", scoreA: a, scoreB: b, winner: a[0] > b[0] ? "A" : "B" });
    // p1 beats p2 and p3, p2 beats p3 and p4, p3 beats p4, p4 beats p1: two pairs on two wins, two on one.
    const ids = plan.groups[0].pairIds;
    const find = (x: string, y: string) => group.find((m) => (m.pairA === x && m.pairB === y) || (m.pairA === y && m.pairB === x))!;
    const beat = (x: string, y: string, gx = 6, gy = 3) => {
      const m = find(x, y);
      m.pairA === x ? done(m, [gx], [gy]) : done(m, [gy], [gx]);
    };
    beat(ids[0], ids[1]);
    beat(ids[0], ids[2], 6, 0);
    beat(ids[1], ids[2]);
    beat(ids[1], ids[3]);
    beat(ids[2], ids[3]);
    beat(ids[3], ids[0]);
    const table = groupTable(ids, group);
    expect(table.map((r) => r.won)).toEqual([2, 2, 1, 1]);
    // Two tied on two wins: p1 beat p2, so p1 leads; two tied on one: p3 beat p4.
    expect(table.map((r) => r.pairId)).toEqual([ids[0], ids[1], ids[2], ids[3]]);
    // Sets and games are counted.
    expect(table[0]).toMatchObject({ played: 3, setsFor: 2, setsAgainst: 1, gamesFor: 15, gamesAgainst: 9 });
    // Two tied on one win each: the match between them decides.
    const two = groupTable([ids[2], ids[3]], group);
    expect(two[0].pairId).toBe(ids[2]);
  });

  it("fills the knockout from the groups, the next round from a winner, the consolation from a loser, and walks a bye through", () => {
    const plan = planDraw(entrants(8), cfg);
    const ms = rows(plan.matches);
    const byKey = new Map(ms.map((m) => [key(m), m]));
    // Nothing moves before a group is complete.
    expect(progress(ms, plan.groups)).toEqual([]);
    const win = (m: MatchLike) => Object.assign(m, { status: "done", scoreA: [6], scoreB: [3], winner: "A" });
    for (const m of ms.filter((m) => m.phase === "group" && m.groupLabel === "A")) win(m);
    let changes = progress(ms, plan.groups);
    const semi1 = byKey.get("main:1:1")!;
    const semi2 = byKey.get("main:1:2")!;
    expect(changes.find((c) => c.id === semi1.id)?.pairA).toBeTruthy(); // G:A:1
    expect(changes.find((c) => c.id === semi2.id)?.pairB).toBeTruthy(); // G:A:2
    expect(changes.find((c) => c.id === byKey.get("consolation:1:1")!.id)?.pairA).toBeTruthy(); // G:A:3
    for (const c of changes) Object.assign(byKey.get(ms.find((m) => m.id === c.id)!.phase + ":" + ms.find((m) => m.id === c.id)!.round + ":" + ms.find((m) => m.id === c.id)!.position)!, c);
    for (const m of ms.filter((m) => m.phase === "group" && m.groupLabel === "B")) win(m);
    changes = progress(ms, plan.groups);
    for (const c of changes) Object.assign(ms.find((m) => m.id === c.id)!, c);
    expect(semi1.pairA && semi1.pairB && semi2.pairA && semi2.pairB).toBeTruthy();
    win(semi1);
    changes = progress(ms, plan.groups);
    const final = byKey.get("main:2:1")!;
    expect(changes).toEqual([{ id: final.id, pairA: semi1.pairA }]);
    Object.assign(final, changes[0]);
    win(semi2);
    Object.assign(final, progress(ms, plan.groups)[0]);
    expect(final.pairB).toBe(semi2.pairA);
    expect(roundKey(2, 2)).toEqual({ key: "final" });
    expect(roundKey(1, 2)).toEqual({ key: "semi" });
    expect(roundKey(1, 4)).toEqual({ key: "of", of: 16 });
  });

  it("walks a bye through a knockout and leaves the consolation slot of a bye empty", () => {
    const plan = planDraw(entrants(6, { 1: 1, 2: 2 }), { ...cfg, format: "knockout" });
    const ms = rows(plan.matches);
    const first = progress(ms, []);
    // The two byes are over at once, with the seed as the winner...
    const byes = ms.filter((m) => m.round === 1 && m.bye);
    expect(first.filter((c) => byes.some((b) => b.id === c.id)).map((c) => c.winner)).toEqual(["A", "A"]);
    for (const c of first) Object.assign(ms.find((m) => m.id === c.id)!, c);
    // ...and the next pass carries them into round two.
    const second = progress(ms, []);
    const r2 = ms.filter((m) => m.phase === "main" && m.round === 2);
    expect(second.filter((c) => r2.some((m) => m.id === c.id)).length).toBe(2);
  });
});
