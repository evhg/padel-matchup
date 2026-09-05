import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { buildHistory, mulberry32 } from "@/lib/domain/americano";
import { CITIES, venueInCity } from "@/lib/domain/cities";
import { createEvent } from "@/lib/domain/events";
import { bestSplit, computeKingStandings, planKingRound, planMexicanoRound, type CourtRound } from "@/lib/domain/formats";
import { isLevelVerified } from "@/lib/domain/levels";
import { getRanking, setRankingOptIn, verifyPlayerLevel } from "@/lib/domain/ranking";
import { setPlayerLevel } from "@/lib/domain/rating";
import { joinEvent } from "@/lib/domain/slots";
import { generateRound, getTournamentState, saveTournamentMatchScore, setTournamentLock, setTournamentSettings } from "@/lib/domain/tournament";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const pair = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
type Plan = { matches: { court: number; a: [string, string]; b: [string, string] }[]; resting: string[] };
const onCourt = (plan: Plan, court: number) => {
  const m = plan.matches.find((x) => x.court === court)!;
  return [...m.a, ...m.b].sort();
};

/** Scores a planned round with the given side A / side B points per court. */
function scored(plan: Plan, margins: Record<number, [number, number]>): CourtRound {
  return {
    matches: plan.matches.map((m) => ({ court: m.court, a1: m.a[0], a2: m.a[1], b1: m.b[0], b2: m.b[1], sideA: margins[m.court][0], sideB: margins[m.court][1] })),
    resting: plan.resting,
  };
}
const unscored = (plan: Plan): CourtRound => ({ matches: plan.matches.map((m) => ({ court: m.court, a1: m.a[0], a2: m.a[1], b1: m.b[0], b2: m.b[1], sideA: null, sideB: null })), resting: plan.resting });

describe("mexicano", () => {
  it("round 1 is random and complete; round 2 seats the courts by standings, 1st+4th against 2nd+3rd", () => {
    const rnd = mulberry32(7);
    const players = ids(8);
    const r1 = planMexicanoRound({ ids: players, rounds: [], rnd });
    expect(r1.matches).toHaveLength(2);
    expect(r1.resting).toEqual([]);
    expect(new Set(r1.matches.flatMap((m) => [...m.a, ...m.b])).size).toBe(8);
    // Court 1: A wins 16-8. Court 2: A wins 20-4. Standings: court-2 A (20), court-1 A (16), court-1 B (8), court-2 B (4).
    const round1 = scored(r1, { 1: [16, 8], 2: [20, 4] });
    const r2 = planMexicanoRound({ ids: players, rounds: [round1], rnd });
    const c1 = r1.matches.find((m) => m.court === 1)!;
    const c2 = r1.matches.find((m) => m.court === 2)!;
    expect(onCourt(r2, 1)).toEqual([...c2.a, ...c1.a].sort());
    expect(onCourt(r2, 2)).toEqual([...c1.b, ...c2.b].sort());
    // 1st+4th vs 2nd+3rd: each pair on court 1 has one 20-point and one 16-point player.
    const m1 = r2.matches.find((m) => m.court === 1)!;
    for (const team of [m1.a, m1.b]) expect(team.filter((p) => c2.a.includes(p))).toHaveLength(1);
  });
  it("needs the previous round's scores and rotates sit-outs fairly", () => {
    const rnd = mulberry32(3);
    const players = ids(10);
    const r1 = planMexicanoRound({ ids: players, rounds: [], rnd });
    expect(r1.resting).toHaveLength(2);
    expect(() => planMexicanoRound({ ids: players, rounds: [unscored(r1)], rnd })).toThrow(/scores_missing/);
    const rounds: CourtRound[] = [scored(r1, { 1: [12, 12], 2: [15, 9] })];
    const rested = new Set(r1.resting);
    for (let i = 0; i < 4; i++) {
      const next = planMexicanoRound({ ids: players, rounds, rnd });
      for (const p of next.resting) expect(rested.has(p)).toBe(false);
      next.resting.forEach((p) => rested.add(p));
      rounds.push(scored(next, { 1: [13, 11], 2: [10, 14] }));
    }
    expect(rested.size).toBe(10);
    expect(() => planMexicanoRound({ ids: ids(3), rounds: [], rnd })).toThrow();
  });
});

describe("king of the court", () => {
  it("winners move up, losers move down, partners split, the ends stay", () => {
    const rnd = mulberry32(11);
    const players = ids(12);
    const r1 = planKingRound({ ids: players, rounds: [], rnd });
    expect(r1.matches).toHaveLength(3);
    const c = (n: number) => r1.matches.find((m) => m.court === n)!;
    // Court 1: A wins. Court 2: B wins. Court 3: A wins.
    const round1 = scored(r1, { 1: [21, 10], 2: [8, 21], 3: [21, 19] });
    const r2 = planKingRound({ ids: players, rounds: [round1], rnd });
    expect(onCourt(r2, 1)).toEqual([...c(1).a, ...c(2).b].sort()); // court-1 winners stay, court-2 winners come up
    expect(onCourt(r2, 2)).toEqual([...c(1).b, ...c(3).a].sort()); // court-1 losers down, court-3 winners up
    expect(onCourt(r2, 3)).toEqual([...c(2).a, ...c(3).b].sort()); // court-2 losers down, court-3 losers stay
    // Nobody keeps last round's partner.
    const lastPartners = new Set(round1.matches.flatMap((m) => [pair(m.a1, m.a2), pair(m.b1, m.b2)]));
    for (const m of r2.matches) {
      expect(lastPartners.has(pair(m.a[0], m.a[1]))).toBe(false);
      expect(lastPartners.has(pair(m.b[0], m.b[1]))).toBe(false);
    }
    expect(() => planKingRound({ ids: players, rounds: [round1, unscored(r2)], rnd })).toThrow(/scores_missing/);
  });
  it("sit-outs re-enter at the bottom court and the standings follow the court", () => {
    const rnd = mulberry32(5);
    const players = ids(9);
    const r1 = planKingRound({ ids: players, rounds: [], rnd });
    expect(r1.resting).toHaveLength(1);
    const round1 = scored(r1, { 1: [21, 15], 2: [21, 18] });
    const r2 = planKingRound({ ids: players, rounds: [round1], rnd });
    expect(r2.resting).toHaveLength(1);
    expect(r2.resting[0]).not.toBe(r1.resting[0]);
    expect(onCourt(r2, 2)).toContain(r1.resting[0]);
    const standings = computeKingStandings(players, [round1]);
    expect(standings[0].court).toBe(1);
    expect(standings.slice(0, 2).map((s) => s.playerId).sort()).toEqual([...r1.matches.find((m) => m.court === 1)!.a].sort());
    expect(standings.at(-1)!.playerId).toBe(r1.resting[0]);
    expect(standings.map((s) => s.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it("bestSplit avoids repeating partners", () => {
    const history = buildHistory([{ matches: [{ a1: "a", a2: "b", b1: "c", b2: "d", sideA: 1, sideB: 0 }], resting: [] }]);
    const split = bestSplit(["a", "b", "c", "d"], history, mulberry32(1));
    expect(pair(...split.a)).not.toBe(pair("a", "b"));
    expect(pair(...split.b)).not.toBe(pair("c", "d"));
  });
});

describe("cities", () => {
  it("places venues by time zone and area names", () => {
    const phuket = CITIES.find((c) => c.slug === "phuket")!;
    expect(venueInCity(phuket, "rawai-padel-club", "Asia/Bangkok")).toBe(true);
    expect(venueInCity(phuket, "rawai-padel-club", "Europe/Madrid")).toBe(false);
    expect(venueInCity(phuket, "bangkok-padel-arena", "Asia/Bangkok")).toBe(false);
    const sg = CITIES.find((c) => c.slug === "singapore")!;
    expect(venueInCity(sg, "any-club", "Asia/Singapore")).toBe(true);
  });
});

describe("formats, verified levels and rankings (db)", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  async function tournament(format: "mexicano" | "king", n: number, extra: Partial<Parameters<typeof createEvent>[1]> = {}) {
    const creator = await makePlayer(db, "Org");
    const ev = await createEvent(db, { creatorPlayerId: creator.id, type: "tournament", format, capacity: n, startsAt: new Date(Date.now() - HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel Club", whenFull: "waitlist", ...extra });
    const players = [];
    for (let i = 0; i < n; i++) {
      const p = await makePlayer(db, `${format[0].toUpperCase()}${i}`);
      await setPlayerLevel(db, p.id, 3);
      players.push(p);
      await joinEvent(db, { eventId: ev.id, playerId: p.id });
    }
    return { creator, ev, players };
  }

  async function scoreAll(evId: string, roundMatches: { id: string; court: number }[], by: string) {
    for (const m of roundMatches) await saveTournamentMatchScore(db, { eventId: evId, matchId: m.id, sideA: m.court === 1 ? 16 : 10, sideB: m.court === 1 ? 8 : 14, playerId: by, isCreator: true });
  }

  it("mexicano rounds need scores, the format locks after round 1, standings snapshot on finalize", async () => {
    const { creator, ev, players } = await tournament("mexicano", 8);
    expect(ev.format).toBe("mexicano");
    const r1 = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
    expect(r1.matches).toHaveLength(2);
    await expect(generateRound(db, { eventId: ev.id, actorPlayerId: creator.id })).rejects.toThrow(/scores_missing/);
    await expect(setTournamentSettings(db, { eventId: ev.id, actorPlayerId: creator.id, format: "king" })).rejects.toThrow(/format_locked/);
    await scoreAll(ev.id, r1.matches, creator.id);
    const r2 = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
    const c1 = r1.matches.find((m) => m.court === 1)!;
    const c2 = r1.matches.find((m) => m.court === 2)!;
    const top = r2.matches.find((m) => m.court === 1)!;
    expect([top.a1, top.a2, top.b1, top.b2].sort()).toEqual([c1.a1, c1.a2, c2.b1, c2.b2].sort());
    const state = await getTournamentState(db, ev, players.map((p) => p.id));
    expect(state.format).toBe("mexicano");
    expect(state.rotationLength).toBeNull();
    await scoreAll(ev.id, r2.matches, creator.id);
    const locked = await setTournamentLock(db, { eventId: ev.id, locked: true, actorPlayerId: creator.id });
    expect(locked.standings).toHaveLength(8);
  });

  it("king standings carry the court; the organizer confirms levels only after the result", async () => {
    const { creator, ev, players } = await tournament("king", 8);
    const r1 = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
    await expect(verifyPlayerLevel(db, { eventId: ev.id, byPlayerId: creator.id, playerId: players[0].id })).rejects.toThrow(/no_result/);
    await scoreAll(ev.id, r1.matches, creator.id);
    const state = await getTournamentState(db, ev, players.map((p) => p.id));
    expect(state.format).toBe("king");
    expect("court" in state.standings[0] && state.standings[0].court).toBe(1);
    await setTournamentLock(db, { eventId: ev.id, locked: true, actorPlayerId: creator.id });
    await expect(verifyPlayerLevel(db, { eventId: ev.id, byPlayerId: players[1].id, playerId: players[0].id })).rejects.toThrow(/forbidden/);
    const outsider = await makePlayer(db, "Out");
    await expect(verifyPlayerLevel(db, { eventId: ev.id, byPlayerId: creator.id, playerId: outsider.id })).rejects.toThrow(/not_participant/);
    const verified = await verifyPlayerLevel(db, { eventId: ev.id, byPlayerId: creator.id, playerId: players[0].id });
    expect(isLevelVerified(verified)).toBe(true);
    expect(verified.levelVerifiedBy).toBe(creator.id);
    // A small nudge keeps the tick; a new self-declaration far away drops it.
    await setPlayerLevel(db, players[0].id, 3.25);
    const nudged = await verifyPlayerLevel(db, { eventId: ev.id, byPlayerId: creator.id, playerId: players[0].id }).catch(() => null);
    expect(nudged && isLevelVerified(nudged)).toBe(true);
    await setPlayerLevel(db, players[0].id, 5);
    const [far] = await db.select().from((await import("@/db/schema")).players).where((await import("drizzle-orm")).eq((await import("@/db/schema")).players.id, players[0].id));
    expect(isLevelVerified(far)).toBe(false);
  });

  it("rankings list opted-in players only, per club and per city", async () => {
    const { creator, ev, players } = await tournament("mexicano", 8, { venueName: "Kata Padel" });
    const r1 = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
    await scoreAll(ev.id, r1.matches, creator.id);
    await setTournamentLock(db, { eventId: ev.id, locked: true, actorPlayerId: creator.id });
    const before = await getRanking(db, { venueSlug: "kata-padel" });
    expect(before.events).toBe(1);
    expect(before.rows).toEqual([]);
    const [first, second] = (await db.select().from((await import("@/db/schema")).events).where((await import("drizzle-orm")).eq((await import("@/db/schema")).events.id, ev.id)))[0].standings!;
    await setRankingOptIn(db, first, true);
    await setRankingOptIn(db, second, true);
    const club = await getRanking(db, { venueSlug: "kata-padel" });
    expect(club.rows.map((r) => r.playerId)).toEqual([first, second]);
    expect(club.rows[0]).toMatchObject({ rank: 1, points: 3, played: 1, wins: 1, podiums: 1 });
    expect(club.rows[1]).toMatchObject({ rank: 2, points: 2, wins: 0 });
    const phuket = CITIES.find((c) => c.slug === "phuket")!;
    const city = await getRanking(db, { city: phuket });
    expect(city.rows.map((r) => r.playerId)).toContain(first);
    const madrid = await getRanking(db, { city: { ...phuket, tz: "Europe/Madrid" } });
    expect(madrid.rows).toEqual([]);
    expect(players).toHaveLength(8);
  });
});
