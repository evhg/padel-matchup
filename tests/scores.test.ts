import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { createEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { outcomeForTeam, saveMatchScore, scorePermission, tally, validateSets } from "@/lib/domain/scores";
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
  it("validates 1–3 sets", () => {
    expect(() => validateSets([])).toThrow();
    expect(() => validateSets([{ setNumber: 1, sideA: 6, sideB: 4 }, { setNumber: 2, sideA: 6, sideB: 4 }, { setNumber: 3, sideA: 6, sideB: 4 }, { setNumber: 4, sideA: 6, sideB: 4 }])).toThrow();
    expect(validateSets([{ setNumber: 9, sideA: 6, sideB: 4 }])).toEqual([{ setNumber: 1, sideA: 6, sideB: 4 }]);
    expect(() => validateSets([{ setNumber: 1, sideA: -1, sideB: 4 }])).toThrow();
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
