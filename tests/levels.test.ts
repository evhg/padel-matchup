import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { balancedTeams, formatLevel, levelFit, matchDeltas, normalizeLevel, normalizeRange, presetFor, rangeFor, tournamentDeltas } from "@/lib/domain/levels";
import { applyEventLevels, setPlayerLevel } from "@/lib/domain/rating";
import { createJoinRequest, decideJoinRequest, getJoinRequests, withdrawJoinRequest } from "@/lib/domain/requests";
import { saveMatchScore } from "@/lib/domain/scores";
import { joinEvent } from "@/lib/domain/slots";
import { generateRound, saveTournamentMatchScore, setTournamentLock } from "@/lib/domain/tournament";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("levels (pure)", () => {
  it("normalizes to quarter steps inside 0–7 and formats compactly", () => {
    expect(normalizeLevel("3.3")).toBe(3.25);
    expect(normalizeLevel(9)).toBe(7);
    expect(normalizeLevel(-1)).toBe(0);
    expect(normalizeLevel("")).toBeNull();
    expect(normalizeLevel("abc")).toBeNull();
    expect(formatLevel(3)).toBe("3.0");
    expect(formatLevel(3.5)).toBe("3.5");
    expect(formatLevel(3.25)).toBe("3.25");
    expect(formatLevel(3.274)).toBe("3.27");
  });
  it("ranges: presets round-trip, custom detected, full span means open", () => {
    expect(presetFor(rangeFor("gold"))).toBe("gold");
    expect(presetFor(rangeFor("platinum"))).toBe("platinum");
    expect(rangeFor("platinum")).toEqual({ min: 4.5, max: null });
    expect(presetFor(normalizeRange(2, 3))).toBe("custom");
    expect(normalizeRange(0, 7)).toEqual({ min: null, max: null });
    expect(normalizeRange(4, 2)).toEqual({ min: 2, max: 4 });
    expect(presetFor({ min: null, max: null })).toBeNull();
  });
  it("fit: open events take everyone, ranged ones need a level inside", () => {
    expect(levelFit({ min: null, max: null }, null)).toBe("ok");
    expect(levelFit(rangeFor("gold"), null)).toBe("unknown");
    expect(levelFit(rangeFor("gold"), 3)).toBe("ok");
    expect(levelFit(rangeFor("gold"), 4.5)).toBe("ok");
    expect(levelFit(rangeFor("gold"), 2.75)).toBe("below");
    expect(levelFit(rangeFor("gold"), 4.75)).toBe("above");
    expect(levelFit(rangeFor("platinum"), 7)).toBe("ok");
  });
  it("balanced teams pick the smallest gap; needs four rated players", () => {
    const b = balancedTeams([
      { id: "a", level: 4 },
      { id: "b", level: 2 },
      { id: "c", level: 3.5 },
      { id: "d", level: 2.5 },
    ]);
    expect(b).not.toBeNull();
    expect([...b!.a].sort()).toEqual(["a", "b"]);
    expect(b!.diff).toBe(0);
    expect(balancedTeams([{ id: "a", level: 4 }, { id: "b", level: null }, { id: "c", level: 3 }, { id: "d", level: 3 }])).toBeNull();
  });
  it("match deltas: upsets move more than expected wins, sides mirror, unrated players don't move", () => {
    const fav = [{ id: "a1", level: 4 }, { id: "a2", level: 4 }];
    const dog = [{ id: "b1", level: 3 }, { id: "b2", level: null }];
    const expected = matchDeltas(fav, dog, "a");
    const upset = matchDeltas(fav, dog, "b");
    expect(expected.get("a1")!).toBeGreaterThan(0);
    expect(expected.get("a1")!).toBeLessThan(0.02);
    expect(upset.get("a1")!).toBeLessThan(-0.08);
    expect(expected.get("b1")).toBe(-expected.get("a1")!);
    expect(expected.has("b2")).toBe(false);
    expect(matchDeltas(fav, dog, "draw").get("a1")!).toBeLessThan(0);
  });
  it("tournament deltas: winner up, last down, unrated ignored", () => {
    const d = tournamentDeltas([
      { id: "w", level: 3, rank: 1 },
      { id: "m", level: 3, rank: 2 },
      { id: "l", level: 3, rank: 3 },
      { id: "u", level: null, rank: 4 },
    ]);
    expect(d.get("w")!).toBeGreaterThan(0);
    expect(d.get("l")!).toBeLessThan(0);
    expect(d.has("u")).toBe(false);
  });
});

describe("join requests", () => {
  it("out-of-range player asks, organizer approves → seated; declined stays declined; withdrawn can re-ask", async () => {
    const org = await makePlayer(db, "Org", { level: 3.5 });
    const low = await makePlayer(db, "Low", { level: 2 });
    const low2 = await makePlayer(db, "Low2", { level: 2 });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "UTC", whenFull: "waitlist", levelMin: 3, levelMax: 4.5 });
    expect(ev.levelMin).toBe(3);
    expect(ev.levelMax).toBe(4.5);

    const r1 = await createJoinRequest(db, { eventId: ev.id, playerId: low.id, level: 2 });
    expect(r1.status).toBe("pending");
    // asking twice is idempotent
    expect((await createJoinRequest(db, { eventId: ev.id, playerId: low.id, level: 2 })).id).toBe(r1.id);
    const approved = await decideJoinRequest(db, { eventId: ev.id, requestId: r1.id, approve: true, actorPlayerId: org.id });
    expect(approved.request.status).toBe("approved");
    expect(approved.join?.outcome).toBe("joined");
    await expect(decideJoinRequest(db, { eventId: ev.id, requestId: r1.id, approve: true, actorPlayerId: org.id })).rejects.toMatchObject({ code: "invalid" });

    const r2 = await createJoinRequest(db, { eventId: ev.id, playerId: low2.id, level: 2 });
    const declined = await decideJoinRequest(db, { eventId: ev.id, requestId: r2.id, approve: false, actorPlayerId: org.id });
    expect(declined.request.status).toBe("declined");
    expect(declined.join).toBeNull();
    // a declined request is not silently reopened
    expect((await createJoinRequest(db, { eventId: ev.id, playerId: low2.id, level: 2 })).status).toBe("declined");

    const third = await makePlayer(db, "Third", { level: 5 });
    const r3 = await createJoinRequest(db, { eventId: ev.id, playerId: third.id, level: 5 });
    expect(await withdrawJoinRequest(db, { eventId: ev.id, playerId: third.id })).toBe(true);
    const list = await getJoinRequests(db, ev.id);
    expect(list.find((r) => r.id === r3.id)).toBeUndefined();
    expect((await createJoinRequest(db, { eventId: ev.id, playerId: third.id, level: 5 })).status).toBe("pending");
  });
  it("approving a full waitlist event waitlists the player", async () => {
    const org = await makePlayer(db, "Org2", { level: 3.5 });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "UTC", whenFull: "waitlist", levelMin: 3, levelMax: 4 });
    for (const n of ["A", "B", "C", "D"]) await joinEvent(db, { eventId: ev.id, playerId: (await makePlayer(db, n, { level: 3.5 })).id });
    const late = await makePlayer(db, "Late", { level: 2 });
    const r = await createJoinRequest(db, { eventId: ev.id, playerId: late.id, level: 2 });
    const res = await decideJoinRequest(db, { eventId: ev.id, requestId: r.id, approve: true, actorPlayerId: org.id });
    expect(res.join?.outcome).toBe("waitlisted");
  });
});

describe("result-based level adjustment", () => {
  it("match: organizer-confirmed 2v2 result nudges levels once", async () => {
    const org = await makePlayer(db, "Cap", { level: 3.5, levelSource: "self" });
    const p2 = await makePlayer(db, "P2", { level: 3.5, levelSource: "self" });
    const p3 = await makePlayer(db, "P3", { level: 3, levelSource: "self" });
    const p4 = await makePlayer(db, "P4");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() - 3 * HOUR), tz: "UTC", whenFull: "waitlist" });
    for (const p of [org, p2, p3, p4]) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: new Date(Date.now() - 4 * HOUR) });
    // A player's entry does not lock → nothing applied
    await saveMatchScore(db, { eventId: ev.id, playerId: p2.id, isCreator: false, sets: [{ setNumber: 1, sideA: 6, sideB: 2 }], teamA: [org.id, p2.id] });
    expect((await applyEventLevels(db, ev.id)).applied).toBe(false);
    // Organizer confirms: favourites (3.5+3.5) beat underdogs (3.0 + unrated)
    await saveMatchScore(db, { eventId: ev.id, playerId: org.id, isCreator: true, sets: [{ setNumber: 1, sideA: 6, sideB: 2 }], teamA: [org.id, p2.id] });
    const r = await applyEventLevels(db, ev.id);
    expect(r.applied).toBe(true);
    const [cap] = await db.select().from(players).where(eq(players.id, org.id));
    const [three] = await db.select().from(players).where(eq(players.id, p3.id));
    const [four] = await db.select().from(players).where(eq(players.id, p4.id));
    expect(cap.level!).toBeGreaterThan(3.5);
    expect(cap.levelSource).toBe("adjusted");
    expect(cap.levelLog?.at(-1)).toMatchObject({ from: 3.5, code: ev.code, type: "match" });
    expect(three.level!).toBeLessThan(3);
    expect(four.level).toBeNull();
    // once only
    expect((await applyEventLevels(db, ev.id)).applied).toBe(false);
    const [ev2] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(ev2.levelsAppliedAt).not.toBeNull();
    expect((await db.select().from(players).where(eq(players.id, org.id)))[0].level).toBe(cap.level);
  });
  it("tournament: finalizing standings adjusts rated players by rank", async () => {
    const org = await makePlayer(db, "TOrg", { level: 3, levelSource: "self" });
    const others = [];
    for (const n of ["T2", "T3", "T4"]) others.push(await makePlayer(db, n, { level: 3, levelSource: "self" }));
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "tournament", capacity: 4, startsAt: new Date(Date.now() - 3 * HOUR), tz: "UTC", whenFull: "closed" });
    for (const p of [org, ...others]) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: new Date(Date.now() - 4 * HOUR) });
    const round = await generateRound(db, { eventId: ev.id, actorPlayerId: org.id });
    const m = round.matches[0];
    await saveTournamentMatchScore(db, { eventId: ev.id, matchId: m.id, sideA: 16, sideB: 8, playerId: org.id, isCreator: true });
    await setTournamentLock(db, { eventId: ev.id, locked: true, actorPlayerId: org.id });
    const r = await applyEventLevels(db, ev.id);
    expect(r.applied).toBe(true);
    const [winner] = await db.select().from(players).where(eq(players.id, m.a1));
    const [loser] = await db.select().from(players).where(eq(players.id, m.b1));
    expect(winner.level!).toBeGreaterThan(3);
    expect(loser.level!).toBeLessThan(3);
    expect(winner.levelLog?.at(-1)?.type).toBe("tournament");
  });
  it("setPlayerLevel snaps to quarter steps and marks the source", async () => {
    const p = await makePlayer(db, "Self");
    expect(await setPlayerLevel(db, p.id, 3.1)).toBe(3);
    const [row] = await db.select().from(players).where(eq(players.id, p.id));
    expect(row.levelSource).toBe("self");
    expect(await setPlayerLevel(db, p.id, "x")).toBeNull();
  });
});
