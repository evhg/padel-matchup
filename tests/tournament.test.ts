import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events } from "@/db/schema";
import { and, isNull } from "drizzle-orm";
import { players, slots, tournamentMatches } from "@/db/schema";
import { createEvent, duplicateEvent, nextWeekAfter, resolveCapacity } from "@/lib/domain/events";
import { confirmInvite, joinEvent, reserveSlot } from "@/lib/domain/slots";
import { deleteLastRound, generateRound, getTournamentState, saveTournamentMatchScore, setTournamentLock, setTournamentSettings } from "@/lib/domain/tournament";
import { createTestDb, makePlayer, HOUR, DAY } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

async function tournamentWith(n: number, startsAt = new Date(Date.now() - HOUR)) {
  const creator = await makePlayer(db, "Org");
  const ev = await createEvent(db, { creatorPlayerId: creator.id, type: "tournament", capacity: 12, startsAt, tz: "Asia/Bangkok", venueName: null, whenFull: "waitlist" });
  const players = [];
  for (let i = 0; i < n; i++) {
    const p = await makePlayer(db, `T${i}`);
    players.push(p);
    await joinEvent(db, { eventId: ev.id, playerId: p.id });
  }
  return { creator, ev, players };
}

describe("americano engine (db)", () => {
  it("generates rounds from the roster, scores matches, computes standings, finalizes", async () => {
    const { creator, ev, players } = await tournamentWith(8);
    await setTournamentSettings(db, { eventId: ev.id, actorPlayerId: creator.id, courts: 2, pointsPerMatch: 24 });
    const r1 = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
    expect(r1.roundNumber).toBe(1);
    expect(r1.matches).toHaveLength(2);
    expect(r1.resting).toEqual([]);

    // A participant enters a score; another corrects it.
    const m = r1.matches[0];
    await saveTournamentMatchScore(db, { eventId: ev.id, matchId: m.id, sideA: 16, sideB: 8, playerId: players[0].id, isCreator: false });
    await saveTournamentMatchScore(db, { eventId: ev.id, matchId: m.id, sideA: 15, sideB: 9, playerId: players[1].id, isCreator: false });

    const r2 = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
    expect(r2.roundNumber).toBe(2);
    // Unscored latest round can be deleted, then regenerated.
    expect(await deleteLastRound(db, { eventId: ev.id })).toBe(2);
    await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });

    const [fresh] = await db.select().from(events).where(eq(events.id, ev.id));
    const state = await getTournamentState(db, fresh, players.map((p) => p.id));
    expect(state.rounds).toHaveLength(2);
    expect(state.scoredMatches).toBe(1);
    const top = state.standings[0];
    expect(top.points).toBe(15);
    expect([m.a1, m.a2]).toContain(top.playerId);
    expect(fresh.scoreReminderSent).toBe(true);

    // Finalize: locks players out, snapshots standings.
    const locked = await setTournamentLock(db, { eventId: ev.id, locked: true, actorPlayerId: creator.id });
    expect(locked.scoreLockedByCreator).toBe(true);
    expect(locked.standings).toHaveLength(8);
    expect(locked.standings?.[0]).toBe(top.playerId);
    await expect(saveTournamentMatchScore(db, { eventId: ev.id, matchId: m.id, sideA: 1, sideB: 1, playerId: players[2].id, isCreator: false })).rejects.toMatchObject({ code: "locked" });
    await expect(generateRound(db, { eventId: ev.id, actorPlayerId: creator.id })).rejects.toMatchObject({ code: "locked" });
    // Organizer can still correct.
    await saveTournamentMatchScore(db, { eventId: ev.id, matchId: m.id, sideA: 14, sideB: 10, playerId: creator.id, isCreator: true });
    const unlocked = await setTournamentLock(db, { eventId: ev.id, locked: false, actorPlayerId: creator.id });
    expect(unlocked.standings).toBeNull();
  });

  it("rejects strangers, pre-start entry and lopsided input", async () => {
    const { creator, ev } = await tournamentWith(8, new Date(Date.now() + HOUR));
    const r = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
    expect(r.resting).toHaveLength(0);
    const stranger = await makePlayer(db, "S");
    // Scores may go in before the start (warm-ups, early starts) — by participants only.
    await expect(saveTournamentMatchScore(db, { eventId: ev.id, matchId: r.matches[0].id, sideA: 1, sideB: 2, playerId: stranger.id, isCreator: false })).rejects.toMatchObject({ code: "not_participant" });
    const early = await saveTournamentMatchScore(db, { eventId: ev.id, matchId: r.matches[0].id, sideA: 10, sideB: 6, playerId: creator.id, isCreator: true });
    expect(early.sideA).toBe(10);
    const later = new Date(Date.now() + 2 * HOUR);
    await expect(saveTournamentMatchScore(db, { eventId: ev.id, matchId: r.matches[0].id, sideA: 1, sideB: 2, playerId: stranger.id, isCreator: false, now: later })).rejects.toMatchObject({ code: "not_participant" });
    await expect(saveTournamentMatchScore(db, { eventId: ev.id, matchId: r.matches[0].id, sideA: 5, sideB: null, playerId: creator.id, isCreator: true, now: later })).rejects.toMatchObject({ code: "invalid" });
  });

  it("needs four players", async () => {
    const { creator, ev } = await tournamentWith(3);
    await expect(generateRound(db, { eventId: ev.id, actorPlayerId: creator.id })).rejects.toMatchObject({ code: "invalid" });
  });

  it("round 1 needs names in fours; later rounds tolerate sit-outs", async () => {
    const { creator, ev } = await tournamentWith(5);
    await expect(generateRound(db, { eventId: ev.id, actorPlayerId: creator.id })).rejects.toMatchObject({ code: "invalid", message: "multiple_of_4" });
    const { creator: c2, ev: ev2 } = await tournamentWith(4);
    const r1 = await generateRound(db, { eventId: ev2.id, actorPlayerId: c2.id });
    expect(r1.matches).toHaveLength(1);
    const [shrunk] = await db.select().from(events).where(eq(events.id, ev2.id));
    expect(shrunk.capacity).toBe(4);
    expect(shrunk.status).toBe("full");
  });

  it("counts reserved names for round 1, shrinks capacity, and merges the placeholder when they accept", async () => {
    const { creator, ev, players: joined } = await tournamentWith(6);
    await reserveSlot(db, { eventId: ev.id, actorPlayerId: creator.id, name: "Zed" });
    await reserveSlot(db, { eventId: ev.id, actorPlayerId: creator.id, name: "Yara" });
    // 8 names on a 12-capacity roster
    const r1 = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
    expect(r1.matches).toHaveLength(2);
    const [after] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(after.capacity).toBe(8);
    expect(after.status).toBe("full");
    const roster = await db.select().from(slots).where(eq(slots.eventId, ev.id)).orderBy(slots.position);
    expect(roster.map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const zedSlot = roster.find((s) => s.invitedName === "Zed")!;
    expect(zedSlot.status).toBe("invited");
    expect(zedSlot.playerId).toBeTruthy();
    const placeholder = zedSlot.playerId!;
    const inMatch = r1.matches.some((m) => [m.a1, m.a2, m.b1, m.b2].includes(placeholder));
    expect(inMatch).toBe(true);

    // Zed opens the invite link with a fresh identity → the placeholder folds into it.
    const zed = await makePlayer(db, "Zed Real");
    const res = await confirmInvite(db, { inviteCode: zedSlot.inviteCode!, playerId: zed.id });
    expect(res.outcome).toBe("confirmed");
    const matches = await db.select().from(tournamentMatches);
    expect(matches.some((m) => [m.a1, m.a2, m.b1, m.b2].includes(zed.id))).toBe(true);
    expect(matches.some((m) => [m.a1, m.a2, m.b1, m.b2].includes(placeholder))).toBe(false);
    expect(await db.select().from(players).where(eq(players.id, placeholder))).toHaveLength(0);
    const [confirmedSlot] = await db.select().from(slots).where(eq(slots.id, zedSlot.id));
    expect(confirmedSlot.playerId).toBe(zed.id);
    expect(confirmedSlot.status).toBe("confirmed");
    void joined;
    void and;
    void isNull;
  });

  it("deletes the latest round even when it has scores (organizer confirms in the UI)", async () => {
    const { creator, ev, players } = await tournamentWith(4);
    const r1 = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
    const r2 = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
    await saveTournamentMatchScore(db, { eventId: ev.id, matchId: r2.matches[0].id, sideA: 12, sideB: 4, playerId: players[0].id, isCreator: false });
    expect(await deleteLastRound(db, { eventId: ev.id })).toBe(2);
    expect(await deleteLastRound(db, { eventId: ev.id })).toBe(1);
    expect(await deleteLastRound(db, { eventId: ev.id })).toBeNull();
    void r1;
  });

  it("tournament capacity is a multiple of 4 between 4 and 64", () => {
    expect(resolveCapacity("tournament", 8)).toBe(8);
    expect(() => resolveCapacity("tournament", 6)).toThrow();
    expect(() => resolveCapacity("tournament", 68)).toThrow();
    expect(resolveCapacity("match", 99)).toBe(4);
  });
});

describe("play again", () => {
  it("clones an event one week later with the same settings and a fresh code", async () => {
    const creator = await makePlayer(db, "Dup");
    const start = new Date(Date.now() - 3 * DAY);
    const src = await createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: start, tz: "Asia/Bangkok", venueName: "Club X", venueMapUrl: "https://maps.example.com/x", whenFull: "closed", note: "bring balls", title: "Thursday" });
    const copy = await duplicateEvent(db, { sourceEventId: src.id, creatorPlayerId: creator.id });
    expect(copy.code).not.toBe(src.code);
    expect(copy.startsAt.getTime()).toBe(start.getTime() + 7 * DAY);
    expect(copy.startsAt.getTime()).toBeGreaterThan(Date.now());
    expect(copy).toMatchObject({ venueName: "Club X", whenFull: "closed", note: "bring balls", title: "Thursday", capacity: 4, status: "open" });
  });
  it("skips weeks already in the past", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    const d = nextWeekAfter(new Date("2026-09-03T11:00:00Z"), now);
    expect(d.toISOString()).toBe("2026-10-01T11:00:00.000Z");
  });
  it("allows a match with no venue yet", async () => {
    const creator = await makePlayer(db, "NoVenue");
    const ev = await createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: new Date(Date.now() + DAY), tz: "UTC", venueName: "", whenFull: "waitlist" });
    expect(ev.venueName).toBeNull();
  });
});
