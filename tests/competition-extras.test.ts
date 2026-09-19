import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { competitionMatches, competitionPairs } from "@/db/schema";
import { addCategory, categoriesOf, createCompetition, enterPair, updateCompetition, withdrawPair } from "@/lib/domain/competitions";
import { advanceCategory, competitionDraws, enterMatchScore, makeDraw, publishDraw } from "@/lib/domain/competitionDraw";
import { luckyLoser, resultsCsv, seriesRanking, setCheckedIn, setStreamUrl } from "@/lib/domain/competitionExtras";
import { orderOfPlay, scheduleCompetition, setCourts } from "@/lib/domain/competitionSchedule";
import { DomainError } from "@/lib/domain/errors";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer } from "./helpers/db";

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
const entriesStatus = async (db: Db, pairId: string) => (await db.select().from(competitionPairs).where(eq(competitionPairs.id, pairId)))[0]?.status;
const LABELS = { category: "Category", phase: "Phase", round: "Round", when: "When", court: "Court", a: "Pair A", b: "Pair B", score: "Score", winner: "Winner" };

/** A competition of eight pairs in one category, drawn and published; returns what the tests need. */
async function eightPairs(db: Db, name: string, seriesTag: string | null, count = 8) {
  const org = await makePlayer(db, `Org ${name}`);
  const c = await createCompetition(db, { organizerPlayerId: org.id, name, tz: "Asia/Bangkok", startsOn: "2026-10-10", seriesTag });
  const cat = await addCategory(db, { competitionId: c.id, organizerPlayerId: org.id, name: "Gold", maxPairs: 8 });
  const pairs: { pair: string; playerId: string }[] = [];
  for (let i = 1; i <= count; i++) {
    const p = await makePlayer(db, `${name} P${i}`);
    pairs.push({ pair: (await enterPair(db, { categoryId: cat.id, playerId: p.id, partner: { name: `${name} M${i}` }, locale: "en", byOrganizer: true })).pair.id, playerId: p.id });
  }
  await makeDraw(db, { categoryId: cat.id, organizerPlayerId: org.id, now: NOW });
  await publishDraw(db, { categoryId: cat.id, organizerPlayerId: org.id });
  return { org, c, cat, pairs };
}

/** Plays every match of the category, side A winning, until it is done. */
async function playOut(db: Db, competitionId: string, categoryId: string, orgId: string) {
  for (let i = 0; i < 6; i++) {
    const view = (await competitionDraws(db, competitionId, await categoriesOf(db, competitionId))).get(categoryId)!;
    const open = [...view.groups.flatMap((g) => g.matches), ...view.main.flat(), ...view.consolation.flat()].filter((m) => m.pairAId && m.pairBId && m.status !== "done" && m.status !== "walkover" && !m.bye);
    if (open.length === 0) break;
    for (const m of open) await enterMatchScore(db, { matchId: m.id, actorPlayerId: orgId, scoreA: m.scoring === "sets2stb" || m.scoring === "sets3" ? [6, 6] : m.scoring === "set9" ? [9] : [6], scoreB: m.scoring === "sets2stb" || m.scoring === "sets3" ? [3, 4] : m.scoring === "set9" ? [5] : [3] });
  }
}

describe("the big-event extras", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  it("takes a stream link, a check-in, a lucky loser, and writes the results file", async () => {
    // Nine pairs before the draw: the ninth waits, and the draw is made on eight. Then a drawn pair
    // withdraws: the waiting pair takes its place in every match still to play.
    const { org, c, cat, pairs } = await eightPairs(db, "Extras", null, 9);
    const waiting = { pair: { id: pairs[8].pair, status: "waiting" } };
    expect((await entriesStatus(db, pairs[8].pair))).toBe("waiting");
    // The view echoes the category it is given: read it fresh, as a page does.
    const view = (await competitionDraws(db, c.id, await categoriesOf(db, c.id))).get(cat.id)!;
    const first = view.groups[0].matches[0];
    await enterMatchScore(db, { matchId: first.id, actorPlayerId: org.id, scoreA: [6], scoreB: [1] });
    const gone = first.pairBId!;
    // The withdrawal itself moves the waiting pair up (step 1); the lucky loser puts it into the draw.
    const { movedUp } = await withdrawPair(db, { pairId: gone, actorPlayerId: org.id });
    expect(movedUp?.id).toBe(waiting.pair.id);
    const lucky = await luckyLoser(db, { categoryId: cat.id, withdrawnPairId: gone, replacementId: movedUp?.id ?? null });
    expect(lucky.replacement?.id).toBe(waiting.pair.id);
    expect(lucky.replacement?.status).toBe("entered");
    expect(lucky.matches).toBe(2); // three group matches, one already played
    const rows = await db.select().from(competitionMatches).where(eq(competitionMatches.categoryId, cat.id));
    expect(rows.filter((m) => m.pairAId === waiting.pair.id || m.pairBId === waiting.pair.id)).toHaveLength(2);
    expect(rows.find((m) => m.id === first.id)!.pairBId).toBe(gone); // the played result stands
    // Nobody waiting: the other side walks through.
    const second = gone === first.pairAId ? first.pairBId! : pairs.find((p) => p.pair !== gone && rows.some((m) => m.status === "scheduled" || m.status === "pending"))!.pair;
    const again = await withdrawPair(db, { pairId: second, actorPlayerId: org.id });
    expect(again.movedUp).toBeNull();
    const bye = await luckyLoser(db, { categoryId: cat.id, withdrawnPairId: second, replacementId: null });
    expect(bye.replacement).toBeNull();
    expect(bye.matches).toBeGreaterThan(0);
    await advanceCategory(db, cat.id);
    const after = await db.select().from(competitionMatches).where(eq(competitionMatches.categoryId, cat.id));
    expect(after.filter((m) => m.bye && m.status === "done" && m.phase === "group").length).toBe(bye.matches);

    // The stream link: https only; the check-in mark.
    const anyMatch = after[0];
    expect(await code(setStreamUrl(db, { matchId: anyMatch.id, organizerPlayerId: org.id, url: "http://youtube.com/x" }))).toBe("invalid:url");
    expect(await code(setStreamUrl(db, { matchId: anyMatch.id, organizerPlayerId: pairs[0].playerId, url: "https://youtube.com/x" }))).toBe("forbidden:organizer");
    expect((await setStreamUrl(db, { matchId: anyMatch.id, organizerPlayerId: org.id, url: " https://youtube.com/live/abc " })).streamUrl).toBe("https://youtube.com/live/abc");
    expect((await setStreamUrl(db, { matchId: anyMatch.id, organizerPlayerId: org.id, url: "" })).streamUrl).toBeNull();
    expect((await setCheckedIn(db, { pairId: pairs[0].pair, organizerPlayerId: org.id, on: true })).checkedInAt).not.toBeNull();
    expect((await setCheckedIn(db, { pairId: pairs[0].pair, organizerPlayerId: org.id, on: false })).checkedInAt).toBeNull();

    // The results file: a header, one line per match that is not a bye, the played one with its score.
    await setCourts(db, { competitionId: c.id, organizerPlayerId: org.id, courtNames: ["A", "B"] });
    await scheduleCompetition(db, { competitionId: c.id, organizerPlayerId: org.id, now: NOW });
    const csv = resultsCsv(await orderOfPlay(db, c.id, { all: true }), c.tz, LABELS);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("Category,Phase,Round,When,Court,Pair A,Pair B,Score,Winner");
    expect(lines.some((l) => l.includes("6-1"))).toBe(true);
    expect(lines.length).toBe(1 + (await orderOfPlay(db, c.id, { all: true })).filter((m) => !m.bye).length);
  });

  it("ranks players across the editions of a series by the round they reached", async () => {
    const a = await eightPairs(db, "Series One", "thai-padel-series");
    const b = await eightPairs(db, "Series Two", "Thai Padel Series");
    expect(b.c.seriesTag).toBe("thai-padel-series");
    expect((await seriesRanking(db, "thai-padel-series")).rows).toEqual([]);
    await playOut(db, a.c.id, a.cat.id, a.org.id);
    await playOut(db, b.c.id, b.cat.id, b.org.id);
    const ranking = await seriesRanking(db, "thai-padel-series");
    expect(ranking.competitions).toHaveLength(2);
    // Eight pairs, two editions: sixteen pairs' players, the champions of each edition on top.
    expect(ranking.rows.length).toBe(32);
    expect(ranking.rows[0].points).toBeGreaterThanOrEqual(100);
    expect(ranking.rows[0].podiums).toBeGreaterThanOrEqual(1);
    expect(ranking.rows.every((r) => r.editions === 1)).toBe(true);
    const total = ranking.rows.reduce((s, r) => s + r.points, 0);
    // Per edition: eight pairs make a four-pair knockout — 100 + 60 + 35 + 35 — plus the consolation winner's 15 and the four pairs out of the groups at 2 each; twice, and twice again for the two players of every pair.
    expect(total).toBe(2 * 2 * (100 + 60 + 35 + 35 + 15 + 4 * 2));
    // A tag nobody used, or an empty one, is nothing.
    expect((await seriesRanking(db, "nothing-here")).competitions).toEqual([]);
    expect((await updateCompetition(db, { id: a.c.id, organizerPlayerId: a.org.id, name: a.c.name, tz: a.c.tz, startsOn: a.c.startsOn, seriesTag: "" })).seriesTag).toBeNull();
  });
});
