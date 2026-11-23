import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, scores, slots } from "@/db/schema";
import { recordMatchStats, matchNumbers } from "@/lib/domain/matchStats";
import { recordPlayedMatch } from "@/lib/domain/playedMatch";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const NOW = new Date("2026-11-23T03:00:00Z");
const PLAYED = new Date(NOW.getTime() - 5 * DAY);
const SETS = [{ sideA: 3, sideB: 6 }, { sideA: 2, sideB: 6 }, { sideA: 1, sideB: 6 }, { sideA: 0, sideB: 6 }];

describe("a match that was played with no match page", () => {
  it("is written as it was: the players on their own records, the pairs, the score, and nothing new for somebody who has a record", async () => {
    const [ana, bo, cy] = [await makePlayer(db, "Ana"), await makePlayer(db, "Bo"), await makePlayer(db, "Cy")];
    const before = (await db.select({ id: players.id }).from(players)).length;
    const res = await recordPlayedMatch(db, { startsAt: PLAYED, tz: "Asia/Bangkok", durationMinutes: 90, venueName: "Played Club", teamA: [ana.id, bo.id], teamB: ["Dana", cy.id], sets: SETS, now: NOW });
    expect(res.existed).toBe(false);
    expect(res.players.map((p) => [p.name, p.team, p.created])).toEqual([["Ana", "a", false], ["Bo", "a", false], ["Dana", "b", true], ["Cy", "b", false]]);
    // One new record, for the one player who had none.
    expect((await db.select({ id: players.id }).from(players)).length).toBe(before + 1);

    const [ev] = await db.select().from(events).where(eq(events.code, res.code));
    expect(ev).toMatchObject({ creatorPlayerId: ana.id, type: "match", status: "past", durationMinutes: 90, venueName: "Played Club", scoreLockedByCreator: true });
    expect(ev.startsAt.getTime()).toBe(PLAYED.getTime());
    const seats = await db.select().from(slots).where(eq(slots.eventId, ev.id)).orderBy(asc(slots.position));
    expect(seats.filter((s) => s.playerId).map((s) => [s.status, s.team])).toEqual([["joined", "a"], ["joined", "a"], ["joined", "b"], ["joined", "b"]]);
    expect(seats.filter((s) => s.team === "a").map((s) => s.playerId).sort()).toEqual([ana.id, bo.id].sort());
    const sets = await db.select().from(scores).where(eq(scores.eventId, ev.id)).orderBy(asc(scores.setNumber));
    expect(sets.map((s) => [s.sideA, s.sideB])).toEqual([[3, 6], [2, 6], [1, 6], [0, 6]]);

    // The numbers of the match now have a place, by first name.
    const sent = await recordMatchStats(db, { code: res.code, stats: [{ player: "Ana", kind: "fastestShot", value: 84, margin: 0.1 }, { player: "Dana", partner: "Cy", kind: "gamesInRow", value: 8 }], now: NOW });
    expect(sent).toEqual({ saved: 3, refused: [] });
    expect((await matchNumbers(db, ev.id)).map((r) => r.kind)).toEqual(["gamesInRow", "fastestShot"]);
  });

  it("answers a second call with the first match and writes nothing", async () => {
    const [ana, bo, cy, di] = [await makePlayer(db, "Ana two"), await makePlayer(db, "Bo two"), await makePlayer(db, "Cy two"), await makePlayer(db, "Di two")];
    const call = () => recordPlayedMatch(db, { startsAt: PLAYED, tz: "Asia/Bangkok", teamA: [ana.id, bo.id], teamB: [cy.id, di.id], sets: SETS, now: NOW });
    const first = await call();
    const count = (await db.select({ id: events.id }).from(events)).length;
    expect(await call()).toEqual({ code: first.code, existed: true, players: [] });
    expect((await db.select({ id: events.id }).from(events)).length).toBe(count);
  });

  it("refuses what is not a played match of four, before it writes anything", async () => {
    const [ana, bo, cy, di] = [await makePlayer(db, "Ana three"), await makePlayer(db, "Bo three"), await makePlayer(db, "Cy three"), await makePlayer(db, "Di three")];
    const base = { startsAt: PLAYED, tz: "Asia/Bangkok", teamA: [ana.id, bo.id], teamB: [cy.id, di.id], sets: SETS, now: NOW };
    const rows = async () => [(await db.select({ id: events.id }).from(events)).length, (await db.select({ id: players.id }).from(players)).length];
    const before = await rows();
    // Still to come, and still on: a match like that is made in the app.
    await expect(recordPlayedMatch(db, { ...base, startsAt: new Date(NOW.getTime() + HOUR) })).rejects.toMatchObject({ code: "invalid", message: "not_played" });
    await expect(recordPlayedMatch(db, { ...base, startsAt: new Date(NOW.getTime() - HOUR), durationMinutes: 90 })).rejects.toMatchObject({ code: "invalid", message: "not_played" });
    await expect(recordPlayedMatch(db, { ...base, teamB: [cy.id, ana.id] })).rejects.toMatchObject({ code: "invalid", message: "teams" });
    await expect(recordPlayedMatch(db, { ...base, teamB: [cy.id] })).rejects.toMatchObject({ code: "invalid", message: "teams" });
    await expect(recordPlayedMatch(db, { ...base, teamB: ["New name", "00000000-0000-4000-8000-000000000000"] })).rejects.toMatchObject({ code: "not_found" });
    await expect(recordPlayedMatch(db, { ...base, teamB: ["New name", cy.id], tz: "Mars/Olympus" })).rejects.toMatchObject({ code: "invalid", message: "tz" });
    await expect(recordPlayedMatch(db, { ...base, teamB: ["New name", cy.id], sets: [] })).rejects.toMatchObject({ code: "invalid" });
    await expect(recordPlayedMatch(db, { ...base, durationMinutes: 75 })).rejects.toMatchObject({ code: "invalid", message: "durationMinutes" });
    expect(await rows()).toEqual(before);
  });
});
