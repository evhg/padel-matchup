import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events } from "@/db/schema";
import { and, isNull } from "drizzle-orm";
import { players, slots, tournamentMatches } from "@/db/schema";
import { createEvent, duplicateEvent, fieldInFours, nextWeekAfter, resolveCapacity, updateEvent } from "@/lib/domain/events";
import { createGroupFromEvent } from "@/lib/domain/groups";
import { freezeClock } from "./helpers/clock";
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
  it("scores first to N games: the target clears the points, a side wins at N with the other below, the table ranks by wins", async () => {
    const { creator, ev, players } = await tournamentWith(4);
    expect((await setTournamentSettings(db, { eventId: ev.id, actorPlayerId: creator.id, pointsPerMatch: 24 })).pointsPerMatch).toBe(24);
    const games = await setTournamentSettings(db, { eventId: ev.id, actorPlayerId: creator.id, gamesTo: 4 });
    expect(games).toMatchObject({ gamesTo: 4, pointsPerMatch: null });
    await expect(setTournamentSettings(db, { eventId: ev.id, actorPlayerId: creator.id, gamesTo: 1 })).rejects.toMatchObject({ code: "invalid", message: "games" });
    const r1 = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
    const m = r1.matches[0];
    await expect(saveTournamentMatchScore(db, { eventId: ev.id, matchId: m.id, sideA: 4, sideB: 4, playerId: creator.id, isCreator: true })).rejects.toMatchObject({ code: "invalid", message: "games_range" });
    await expect(saveTournamentMatchScore(db, { eventId: ev.id, matchId: m.id, sideA: 5, sideB: 2, playerId: creator.id, isCreator: true })).rejects.toMatchObject({ code: "invalid", message: "games_range" });
    await saveTournamentMatchScore(db, { eventId: ev.id, matchId: m.id, sideA: 4, sideB: 2, playerId: creator.id, isCreator: true });
    const state = await getTournamentState(db, games, players.map((p) => p.id));
    expect(state.standings[0]).toMatchObject({ wins: 1, points: 4, rank: 1 });
    expect(state.standings.filter((s) => s.wins === 1)).toHaveLength(2);
    // Points back on: the target goes.
    expect((await setTournamentSettings(db, { eventId: ev.id, actorPlayerId: creator.id, pointsPerMatch: 16 })).gamesTo).toBeNull();
  });

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

  it("round 1 of king needs names in fours; a field in fours shrinks to its names", async () => {
    const { creator, ev } = await tournamentWith(5);
    await setTournamentSettings(db, { eventId: ev.id, actorPlayerId: creator.id, format: "king" });
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

describe("the tournament night: round 1 with rests (db)", () => {
  // Friday 9 October 2026, 19:00 in Bangkok; the tournaments started an hour before.
  const NOW = new Date("2026-10-09T12:00:00Z");
  freezeClock(NOW);
  const started = new Date(NOW.getTime() - HOUR);

  it("americano starts with five: one rests a round, capacity shrinks to five, everyone rests once in five rounds", async () => {
    const { creator, ev, players: field } = await tournamentWith(5, started);
    const r1 = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
    expect(r1.matches).toHaveLength(1);
    expect(r1.resting).toHaveLength(1);
    const [shrunk] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(shrunk.capacity).toBe(5);
    expect(shrunk.status).toBe("full");
    const rested = [r1.resting[0]];
    for (let i = 2; i <= 5; i++) rested.push(...(await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id })).resting);
    expect(rested.sort()).toEqual(field.map((p) => p.id).sort());
    // A rest adds nothing to the table.
    await saveTournamentMatchScore(db, { eventId: ev.id, matchId: r1.matches[0].id, sideA: 13, sideB: 8, playerId: creator.id, isCreator: true });
    const state = await getTournamentState(db, shrunk, field.map((p) => p.id));
    expect(state.standings.find((s) => s.playerId === r1.resting[0])).toMatchObject({ points: 0, played: 0 });
    expect(state.standings.filter((s) => s.played === 1)).toHaveLength(4);
  });

  it("mexicano starts with six: two rest a round, and every one rests once in three rounds", async () => {
    const { creator, ev, players: field } = await tournamentWith(6, started);
    await setTournamentSettings(db, { eventId: ev.id, actorPlayerId: creator.id, format: "mexicano" });
    const rested: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const r = await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
      expect(r.matches).toHaveLength(1);
      rested.push(...r.resting);
      await saveTournamentMatchScore(db, { eventId: ev.id, matchId: r.matches[0].id, sideA: 14, sideB: 10, playerId: creator.id, isCreator: true });
    }
    expect(rested.sort()).toEqual(field.map((p) => p.id).sort());
  });

  it("a field of ten copies as twelve, and an edit that leaves ten alone still saves", async () => {
    const { creator, ev } = await tournamentWith(10, started);
    await generateRound(db, { eventId: ev.id, actorPlayerId: creator.id });
    const [ten] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(ten.capacity).toBe(10);
    const { event: edited } = await updateEvent(db, ev.id, creator.id, { capacity: 10, note: "Courts 5 and 7" });
    expect(edited).toMatchObject({ capacity: 10, note: "Courts 5 and 7" });
    const again = await duplicateEvent(db, { sourceEventId: ev.id, creatorPlayerId: creator.id, now: NOW });
    expect(again.capacity).toBe(12);
    const group = await createGroupFromEvent(db, { eventId: ev.id, actorPlayerId: creator.id, fallbackName: "Friday crew" });
    expect(group.capacity).toBe(12);
    expect([fieldInFours(4), fieldInFours(5), fieldInFours(10), fieldInFours(64)]).toEqual([4, 8, 12, 64]);
  });
});
