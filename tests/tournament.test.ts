import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events } from "@/db/schema";
import { createEvent, duplicateEvent, nextWeekAfter } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
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
    // Round with a score can't be deleted.
    await expect(deleteLastRound(db, { eventId: ev.id })).rejects.toMatchObject({ code: "invalid" });

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
    const { creator, ev } = await tournamentWith(5, new Date(Date.now() + HOUR));
    const r = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
    expect(r.resting).toHaveLength(1);
    const stranger = await makePlayer(db, "S");
    await expect(saveTournamentMatchScore(db, { eventId: ev.id, matchId: r.matches[0].id, sideA: 1, sideB: 2, playerId: stranger.id, isCreator: false })).rejects.toMatchObject({ code: "not_started" });
    const later = new Date(Date.now() + 2 * HOUR);
    await expect(saveTournamentMatchScore(db, { eventId: ev.id, matchId: r.matches[0].id, sideA: 1, sideB: 2, playerId: stranger.id, isCreator: false, now: later })).rejects.toMatchObject({ code: "not_participant" });
    await expect(saveTournamentMatchScore(db, { eventId: ev.id, matchId: r.matches[0].id, sideA: 5, sideB: null, playerId: creator.id, isCreator: true, now: later })).rejects.toMatchObject({ code: "invalid" });
  });

  it("needs four players", async () => {
    const { creator, ev } = await tournamentWith(3);
    await expect(generateRound(db, { eventId: ev.id, actorPlayerId: creator.id })).rejects.toMatchObject({ code: "invalid" });
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
