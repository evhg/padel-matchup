import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { addCategory, categoriesOf, createCompetition, enterPair } from "@/lib/domain/competitions";
import { clearDraw, competitionDraws, enterMatchScore, groupsFrom, makeDraw, publishDraw, setPairSeed, updateDrawSettings, walkoverMatch } from "@/lib/domain/competitionDraw";
import { DomainError } from "@/lib/domain/errors";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer } from "./helpers/db";

/** Tuesday 8 September 2026, 16:00 in Phuket. */
const NOW = new Date("2026-09-08T09:00:00Z");
freezeClock(NOW);

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DomainError ? `${e.code}:${e.message === e.code ? "" : e.message}` : String(e);
  }
};

describe("the draw in the database", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  it("makes, publishes, scores and finishes a groups-then-knockout draw, and keeps a result final once built on", async () => {
    const org = await makePlayer(db, "Org");
    const c = await createCompetition(db, { organizerPlayerId: org.id, name: "Draw Open", tz: "Asia/Bangkok", startsOn: "2026-10-10" });
    const gold = await addCategory(db, { competitionId: c.id, organizerPlayerId: org.id, name: "Gold", maxPairs: 8 });
    const people: { player: { id: string }; pair: string }[] = [];
    for (let i = 1; i <= 8; i++) {
      const player = await makePlayer(db, `P${i}`);
      const e = await enterPair(db, { categoryId: gold.id, playerId: player.id, partner: { name: `M${i}` }, locale: "en", byOrganizer: true });
      people.push({ player, pair: e.pair.id });
    }
    await setPairSeed(db, { pairId: people[0].pair, organizerPlayerId: org.id, seed: 1 });
    await setPairSeed(db, { pairId: people[1].pair, organizerPlayerId: org.id, seed: 2 });
    expect(await code(setPairSeed(db, { pairId: people[2].pair, organizerPlayerId: people[0].player.id, seed: 3 }))).toBe("forbidden:organizer");
    expect(await code(updateDrawSettings(db, { categoryId: gold.id, organizerPlayerId: org.id, groupsThrough: 4 }))).toBe("invalid:groupsThrough");
    expect(await code(updateDrawSettings(db, { categoryId: gold.id, organizerPlayerId: org.id, scoringGroup: "x" }))).toBe("invalid:scoringGroup");
    await updateDrawSettings(db, { categoryId: gold.id, organizerPlayerId: org.id, groupSize: 4, groupsThrough: 2, consolation: true, scoringGroup: "set6tb", scoringKnockout: "set9", scoringFinal: "sets2stb" });

    const made = await makeDraw(db, { categoryId: gold.id, organizerPlayerId: org.id, now: NOW });
    expect(made.category.drawStatus).toBe("drawn");
    expect(made.matches.filter((m) => m.phase === "group")).toHaveLength(12);
    expect(made.matches.filter((m) => m.phase === "main")).toHaveLength(3);
    expect(made.matches.filter((m) => m.phase === "consolation")).toHaveLength(3);
    const groups = groupsFrom(made.matches);
    expect(groups.map((g) => [g.label, g.pairIds.length])).toEqual([
      ["A", 4],
      ["B", 4],
    ]);
    expect(groups[0].pairIds).toContain(people[0].pair);
    expect(groups[1].pairIds).toContain(people[1].pair);
    // The field is closed by the draw; a score waits for the publication.
    const late = await makePlayer(db, "Late");
    expect(await code(enterPair(db, { categoryId: gold.id, playerId: late.id, partner: { name: "Later" }, locale: "en" }))).toBe("closed:drawn");
    const firstGroupMatch = made.matches.find((m) => m.phase === "group" && m.groupLabel === "A")!;
    expect(await code(enterMatchScore(db, { matchId: firstGroupMatch.id, actorPlayerId: org.id, scoreA: [6], scoreB: [3] }))).toBe("invalid:not_published");
    // A draw can be cleared and made again before anyone plays.
    expect((await clearDraw(db, { categoryId: gold.id, organizerPlayerId: org.id })).drawStatus).toBe("none");
    expect(await code(updateDrawSettings(db, { categoryId: gold.id, organizerPlayerId: org.id, goldenPoint: false }))).toBe("ok");
    const again = await makeDraw(db, { categoryId: gold.id, organizerPlayerId: org.id, now: NOW });
    expect(again.matches).toHaveLength(18);
    expect(await code(publishDraw(db, { categoryId: gold.id, organizerPlayerId: org.id }))).toBe("ok");
    expect(await code(publishDraw(db, { categoryId: gold.id, organizerPlayerId: org.id }))).toBe("invalid:not_drawn");
    expect(await code(updateDrawSettings(db, { categoryId: gold.id, organizerPlayerId: org.id, goldenPoint: true }))).toBe("invalid:drawn");

    // Group A: a stranger may not, a player of the pair may, and the rule of the phase holds.
    let view = (await competitionDraws(db, c.id, [again.category]))!.get(gold.id)!;
    const groupA = view.groups.find((g) => g.label === "A")!;
    const stranger = await makePlayer(db, "Stranger");
    const m0 = groupA.matches[0];
    expect(await code(enterMatchScore(db, { matchId: m0.id, actorPlayerId: stranger.id, scoreA: [6], scoreB: [3] }))).toBe("forbidden:");
    const ownerOfA = people.find((p) => p.pair === m0.pairAId)!.player;
    expect(await code(enterMatchScore(db, { matchId: m0.id, actorPlayerId: ownerOfA.id, scoreA: [6], scoreB: [5] }))).toBe("invalid:score_set");
    expect(await code(enterMatchScore(db, { matchId: m0.id, actorPlayerId: ownerOfA.id, scoreA: [6], scoreB: [3] }))).toBe("ok");
    for (const m of groupA.matches.slice(1)) await enterMatchScore(db, { matchId: m.id, actorPlayerId: org.id, scoreA: [6], scoreB: [4] });
    view = (await competitionDraws(db, c.id, [again.category]))!.get(gold.id)!;
    const tableA = view.groups.find((g) => g.label === "A")!;
    expect(tableA.complete).toBe(true);
    expect(tableA.table.map((r) => r.played)).toEqual([3, 3, 3, 3]);
    const semis = view.main[0];
    expect(semis).toHaveLength(2);
    expect(semis[0].pairAId).toBe(tableA.table[0].pairId); // G:A:1
    expect(semis[1].pairBId).toBe(tableA.table[1].pairId); // G:A:2
    expect(view.consolation[0][0].pairAId).toBe(tableA.table[2].pairId); // G:A:3
    expect(view.main[1][0].pairAId).toBeNull(); // the final waits
    // A group result is correctable while nothing is built on it.
    expect(await code(enterMatchScore(db, { matchId: m0.id, actorPlayerId: org.id, scoreA: [7], scoreB: [5] }))).toBe("ok");

    // Group B, then the semi-finals under the super set, then the final under two sets and a super tie-break.
    for (const m of view.groups.find((g) => g.label === "B")!.matches) await enterMatchScore(db, { matchId: m.id, actorPlayerId: org.id, scoreA: [6], scoreB: [2] });
    view = (await competitionDraws(db, c.id, [again.category]))!.get(gold.id)!;
    expect(view.main[0].every((m) => m.pairAId && m.pairBId)).toBe(true);
    expect(view.main[0][0].scoring).toBe("set9");
    expect(await code(enterMatchScore(db, { matchId: view.main[0][0].id, actorPlayerId: org.id, scoreA: [6], scoreB: [4] }))).toBe("invalid:score_set");
    await enterMatchScore(db, { matchId: view.main[0][0].id, actorPlayerId: org.id, scoreA: [9], scoreB: [7] });
    await enterMatchScore(db, { matchId: view.main[0][1].id, actorPlayerId: org.id, scoreA: [8], scoreB: [9] });
    // Now the group result is final: the knockout has started.
    expect(await code(enterMatchScore(db, { matchId: m0.id, actorPlayerId: org.id, scoreA: [6], scoreB: [1] }))).toBe("locked:");
    expect(await code(clearDraw(db, { categoryId: gold.id, organizerPlayerId: org.id }))).toBe("invalid:scored");
    view = (await competitionDraws(db, c.id, [again.category]))!.get(gold.id)!;
    const final = view.main[1][0];
    expect(final.scoring).toBe("sets2stb");
    expect(final.pairAId).toBe(view.main[0][0].pairAId);
    expect(final.pairBId).toBe(view.main[0][1].pairBId);
    expect(await code(enterMatchScore(db, { matchId: final.id, actorPlayerId: org.id, scoreA: [6, 3, 6], scoreB: [4, 6, 4] }))).toBe("invalid:score_set");
    await enterMatchScore(db, { matchId: final.id, actorPlayerId: org.id, scoreA: [6, 3, 10], scoreB: [4, 6, 8] });
    // The view echoes the category it is given: read it fresh, as a page does.
    const [fresh] = await categoriesOf(db, c.id);
    view = (await competitionDraws(db, c.id, [fresh]))!.get(gold.id)!;
    expect(view.category.drawStatus).toBe("done");
    expect(view.champion?.id).toBe(final.pairAId);
    // The consolation: a walkover counts like a win and moves the pair on.
    const cons = view.consolation[0][0];
    await walkoverMatch(db, { matchId: cons.id, organizerPlayerId: org.id, winner: "B" });
    view = (await competitionDraws(db, c.id, [again.category]))!.get(gold.id)!;
    expect(view.consolation[1][0].pairAId).toBe(cons.pairBId);
  });

  it("walks byes through a straight knockout and seeds the consolation with the first-round losers", async () => {
    const org = await makePlayer(db, "Org2");
    const c = await createCompetition(db, { organizerPlayerId: org.id, name: "Knockout Open", tz: "Asia/Bangkok", startsOn: "2026-10-17" });
    const mixed = await addCategory(db, { competitionId: c.id, organizerPlayerId: org.id, name: "Mixed", maxPairs: 8 });
    await updateDrawSettings(db, { categoryId: mixed.id, organizerPlayerId: org.id, format: "knockout" });
    const pairs: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const player = await makePlayer(db, `K${i}`);
      pairs.push((await enterPair(db, { categoryId: mixed.id, playerId: player.id, partner: { name: `KM${i}` }, locale: "en", byOrganizer: true })).pair.id);
    }
    await setPairSeed(db, { pairId: pairs[0], organizerPlayerId: org.id, seed: 1 });
    await setPairSeed(db, { pairId: pairs[1], organizerPlayerId: org.id, seed: 2 });
    const made = await makeDraw(db, { categoryId: mixed.id, organizerPlayerId: org.id, now: NOW });
    const r1 = made.matches.filter((m) => m.phase === "main" && m.round === 1);
    expect(r1).toHaveLength(4);
    const byes = r1.filter((m) => m.bye);
    expect(byes.map((m) => [m.status, m.winner, m.pairAId])).toEqual([
      ["done", "A", pairs[0]],
      ["done", "A", pairs[1]],
    ]);
    const r2 = made.matches.filter((m) => m.phase === "main" && m.round === 2);
    expect(r2.flatMap((m) => [m.pairAId, m.pairBId]).filter(Boolean).sort()).toEqual([pairs[0], pairs[1]].sort());
    expect(made.matches.filter((m) => m.phase === "consolation")).toHaveLength(1);
  });

  it("plays a qualifying knockout for the spots past the direct entries", async () => {
    const org = await makePlayer(db, "Org3");
    const c = await createCompetition(db, { organizerPlayerId: org.id, name: "Qualifying Open", tz: "Asia/Bangkok", startsOn: "2026-10-24" });
    const pro = await addCategory(db, { competitionId: c.id, organizerPlayerId: org.id, name: "Pro", maxPairs: 4 });
    await updateDrawSettings(db, { categoryId: pro.id, organizerPlayerId: org.id, format: "knockout", qualifyingSpots: 2, consolation: false });
    for (let i = 1; i <= 7; i++) {
      const player = await makePlayer(db, `Q${i}`);
      await enterPair(db, { categoryId: pro.id, playerId: player.id, partner: { name: `QM${i}` }, locale: "en", byOrganizer: true });
    }
    const made = await makeDraw(db, { categoryId: pro.id, organizerPlayerId: org.id, now: NOW });
    const q = made.matches.filter((m) => m.phase === "qualifying");
    expect(q.map((m) => m.round)).toEqual([1, 1, 1, 1, 2, 2]);
    expect(q.filter((m) => m.round === 1 && m.bye)).toHaveLength(3);
    const main1 = made.matches.filter((m) => m.phase === "main" && m.round === 1);
    expect(main1.flatMap((m) => [m.sourceA, m.sourceB]).filter(Boolean).sort()).toEqual(["Q:1", "Q:2"]);
    expect(main1.flatMap((m) => [m.pairAId, m.pairBId]).filter(Boolean)).toHaveLength(2);
    await publishDraw(db, { categoryId: pro.id, organizerPlayerId: org.id });
    // The one real first-round qualifying match, then the two second-round ones, fill Q:1 and Q:2.
    const real = q.find((m) => m.round === 1 && !m.bye)!;
    await enterMatchScore(db, { matchId: real.id, actorPlayerId: org.id, scoreA: [9], scoreB: [3] });
    let view = (await competitionDraws(db, c.id, [made.category]))!.get(pro.id)!;
    for (const m of view.qualifying[1]) await enterMatchScore(db, { matchId: m.id, actorPlayerId: org.id, scoreA: [9], scoreB: [4] });
    view = (await competitionDraws(db, c.id, [made.category]))!.get(pro.id)!;
    expect(view.main[0].every((m) => m.pairAId && m.pairBId)).toBe(true);
  });
});
