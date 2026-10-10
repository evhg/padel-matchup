import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { createEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { checkSets, isUsualSet, MAX_SETS, outcomeForTeam, saveMatchScore, scorePermission, tally, unusualSets, validateSets } from "@/lib/domain/scores";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const base = { startsAt: new Date("2026-01-01T18:00:00Z"), status: "open" as const, scoreLockedByCreator: false };
const before = new Date("2026-01-01T17:59:00Z");
const after = new Date("2026-01-01T19:30:00Z");

describe("score-lock rules (pure)", () => {
  it("nobody can enter before start", () => {
    expect(scorePermission({ event: base, now: before, viewerPlayerId: "p1", isCreator: true, participantIds: ["p1"] })).toEqual({ allowed: false, reason: "not_started" });
  });
  it("participants may enter and correct each other after start", () => {
    expect(scorePermission({ event: base, now: after, viewerPlayerId: "p1", isCreator: false, participantIds: ["p1", "p2"] })).toEqual({ allowed: true, locked: false });
    expect(scorePermission({ event: base, now: after, viewerPlayerId: "p2", isCreator: false, participantIds: ["p1", "p2"] })).toEqual({ allowed: true, locked: false });
  });
  it("non-participants and anonymous visitors cannot", () => {
    expect(scorePermission({ event: base, now: after, viewerPlayerId: "x", isCreator: false, participantIds: ["p1"] })).toEqual({ allowed: false, reason: "not_participant" });
    expect(scorePermission({ event: base, now: after, viewerPlayerId: null, isCreator: false, participantIds: ["p1"] })).toEqual({ allowed: false, reason: "not_participant" });
  });
  it("once the creator entered, players are locked out but the creator can still edit", () => {
    const locked = { ...base, scoreLockedByCreator: true };
    expect(scorePermission({ event: locked, now: after, viewerPlayerId: "p1", isCreator: false, participantIds: ["p1"] })).toEqual({ allowed: false, reason: "locked" });
    expect(scorePermission({ event: locked, now: after, viewerPlayerId: "c", isCreator: true, participantIds: ["p1"] })).toEqual({ allowed: true, locked: true });
  });
  it("cancelled events never take scores", () => {
    expect(scorePermission({ event: { ...base, status: "cancelled" }, now: after, viewerPlayerId: "c", isCreator: true, participantIds: [] })).toEqual({ allowed: false, reason: "cancelled" });
  });
  it("validates 1–5 sets of 0 to 30 games, whatever they look like (decision H)", () => {
    const set = (sideA: number, sideB: number, setNumber = 1) => ({ setNumber, sideA, sideB });
    expect(MAX_SETS).toBe(5);
    expect(() => validateSets([])).toThrow();
    // Four sets: the owner's own note ("we played 4 sets but we couldn't add the result!").
    expect(validateSets([set(6, 4), set(4, 6), set(6, 3), set(6, 5)])).toHaveLength(4);
    expect(validateSets([set(6, 4), set(4, 6), set(6, 3), set(3, 6), set(7, 6)])).toHaveLength(5);
    expect(() => validateSets([set(6, 4), set(6, 4), set(6, 4), set(6, 4), set(6, 4), set(6, 4)])).toThrow();
    // Unusual is not invalid: the server keeps taking any games score.
    expect(validateSets([set(6, 5), set(2, 2)])).toEqual([set(6, 5, 1), set(2, 2, 2)]);
    expect(validateSets([set(30, 28)])).toEqual([set(30, 28)]);
    expect(() => validateSets([set(31, 4)])).toThrow();
    expect(validateSets([{ setNumber: 9, sideA: 6, sideB: 4 }])).toEqual([{ setNumber: 1, sideA: 6, sideB: 4 }]);
    expect(() => validateSets([{ setNumber: 1, sideA: -1, sideB: 4 }])).toThrow();
  });
  it("says which sets look unusual: a question for the player, never a refusal", () => {
    const mid = { last: false, only: false };
    const last = { last: true, only: false };
    const only = { last: true, only: true };
    // [a, b, where the set stands, usual?]
    const table: [number, number, typeof mid, boolean][] = [
      // A set to six.
      [6, 0, mid, true], [6, 4, mid, true], [4, 6, mid, true], [7, 5, mid, true], [7, 6, mid, true], [6, 7, last, true],
      [6, 5, mid, false], [5, 6, last, false], [7, 4, mid, false], [7, 7, mid, false], [6, 6, only, false],
      // A short set to four, with 5-3 and 5-4 for a set played on or its tie-break.
      [4, 0, mid, true], [2, 4, mid, true], [5, 3, mid, true], [4, 5, last, true],
      [4, 3, mid, false], [3, 1, mid, false], [2, 2, last, false], [5, 2, mid, false], [5, 5, mid, false],
      // A pro set is the whole match: 8-0..8-6 and 9-0..9-8 as the only set, a typo inside a longer match.
      [8, 6, only, true], [9, 2, only, true], [7, 9, only, true], [9, 8, only, true],
      [9, 2, mid, false], [9, 2, last, false], [8, 3, mid, false], [8, 7, only, false], [9, 9, only, false],
      // A match tie-break as the last set: ten or more, two clear, and exactly two apart beyond ten.
      [10, 8, last, true], [8, 10, last, true], [10, 0, last, true], [11, 9, last, true], [12, 10, last, true], [18, 16, last, true], [10, 6, only, true],
      [10, 8, mid, false], [10, 9, last, false], [11, 8, last, false], [12, 6, last, false], [9, 7, last, false], [10, 10, last, false],
      // What a winner-only result looks like, and nothing at all.
      [1, 0, only, false], [0, 1, last, false],
    ];
    for (const [a, b, place, usual] of table) expect(isUsualSet({ sideA: a, sideB: b }, place), `${a}-${b} ${JSON.stringify(place)}`).toBe(usual);
    const sets = (...s: [number, number][]) => s.map(([sideA, sideB]) => ({ sideA, sideB }));
    expect(unusualSets(sets([6, 3], [6, 4]))).toEqual([]);
    expect(unusualSets(sets([6, 4], [4, 6], [10, 8]))).toEqual([]);
    expect(unusualSets(sets([6, 4], [4, 6], [6, 3], [6, 5]))).toEqual([3]);
    expect(unusualSets(sets([10, 8], [6, 4]))).toEqual([0]);
    expect(unusualSets(sets([9, 2]))).toEqual([]);
    expect(unusualSets(sets([9, 2], [6, 4]))).toEqual([0]);
    expect(unusualSets(sets([6, 5], [3, 1], [6, 4], [2, 2], [7, 6]))).toEqual([0, 1, 3]);
  });
  it("never asks about a winner-only result, and refuses a 0-0 set before it asks anything", () => {
    const sets = (...s: [number, number][]) => s.map(([sideA, sideB]) => ({ sideA, sideB }));
    // The 🏁 tap stores who won as one 1-0 set (WINNER_ONLY_SETS): "Is 1-0 right?" would question the tap itself.
    expect(unusualSets(sets([1, 0]))).toEqual([]);
    expect(unusualSets(sets([0, 1]))).toEqual([]);
    expect(checkSets(sets([1, 0]))).toEqual({ ask: [] });
    // 1-0 inside a longer score is no tap, it is a typo, and still asks.
    expect(unusualSets(sets([6, 4], [1, 0]))).toEqual([1]);
    // A 0-0 set is refused with the server's own message, before the question: the 6-5 beside it is
    // never asked about, so nobody answers "Yes, save" and is then refused.
    expect(checkSets(sets([0, 0]))).toEqual({ refuse: "empty_set" });
    expect(checkSets(sets([6, 5], [0, 0]))).toEqual({ refuse: "empty_set" });
    expect(() => validateSets([{ setNumber: 1, sideA: 0, sideB: 0 }])).toThrow("empty_set");
    expect(checkSets(sets([6, 5], [6, 4]))).toEqual({ ask: [0] });
    expect(checkSets(sets([6, 3], [6, 4]))).toEqual({ ask: [] });
  });
  it("tallies sets and derives outcomes per team", () => {
    const sets = [
      { sideA: 6, sideB: 4 },
      { sideA: 3, sideB: 6 },
      { sideA: 7, sideB: 5 },
    ];
    expect(tally(sets)).toEqual({ a: 2, b: 1 });
    expect(outcomeForTeam(sets, "a")).toBe("won");
    expect(outcomeForTeam(sets, "b")).toBe("lost");
    expect(outcomeForTeam(sets, null)).toBeNull();
    expect(outcomeForTeam([{ sideA: 6, sideB: 4 }, { sideA: 4, sideB: 6 }], "a")).toBe("draw");
  });
});

describe("score entry (db)", () => {
  it("player enters, another player corrects, creator locks, player rejected", async () => {
    const creator = await makePlayer(db, "C");
    const ev = await createEvent(db, {
      creatorPlayerId: creator.id,
      type: "match",
      startsAt: new Date(Date.now() + HOUR),
      tz: "UTC",
      venueName: "V",
      whenFull: "closed",
    });
    const a = await makePlayer(db, "A");
    const b = await makePlayer(db, "B");
    await joinEvent(db, { eventId: ev.id, playerId: creator.id });
    await joinEvent(db, { eventId: ev.id, playerId: a.id });
    await joinEvent(db, { eventId: ev.id, playerId: b.id });
    const later = new Date(Date.now() + 2 * HOUR);

    await expect(saveMatchScore(db, { eventId: ev.id, playerId: a.id, isCreator: false, sets: [{ setNumber: 1, sideA: 6, sideB: 2 }] })).rejects.toMatchObject({ code: "not_started" });

    const r1 = await saveMatchScore(db, { eventId: ev.id, playerId: a.id, isCreator: false, sets: [{ setNumber: 1, sideA: 6, sideB: 2 }], now: later, teamA: [creator.id, a.id] });
    expect(r1.scores).toHaveLength(1);
    expect(r1.event.scoreLockedByCreator).toBe(false);
    expect(r1.event.scoreReminderSent).toBe(true);

    const r2 = await saveMatchScore(db, { eventId: ev.id, playerId: b.id, isCreator: false, sets: [{ setNumber: 1, sideA: 6, sideB: 3 }, { setNumber: 2, sideA: 4, sideB: 6 }], now: later });
    expect(r2.scores.map((s) => `${s.sideA}-${s.sideB}`)).toEqual(["6-3", "4-6"]);

    const r3 = await saveMatchScore(db, { eventId: ev.id, playerId: creator.id, isCreator: true, sets: [{ setNumber: 1, sideA: 6, sideB: 3 }, { setNumber: 2, sideA: 6, sideB: 4 }], now: later });
    expect(r3.event.scoreLockedByCreator).toBe(true);

    await expect(saveMatchScore(db, { eventId: ev.id, playerId: a.id, isCreator: false, sets: [{ setNumber: 1, sideA: 1, sideB: 6 }], now: later })).rejects.toMatchObject({ code: "locked" });
    const r4 = await saveMatchScore(db, { eventId: ev.id, playerId: creator.id, isCreator: true, sets: [{ setNumber: 1, sideA: 7, sideB: 6 }], now: later });
    expect(r4.scores).toHaveLength(1);

    const stranger = await makePlayer(db, "S");
    await expect(saveMatchScore(db, { eventId: ev.id, playerId: stranger.id, isCreator: false, sets: [{ setNumber: 1, sideA: 6, sideB: 0 }], now: later })).rejects.toMatchObject({ code: "not_participant" });
  });
});
