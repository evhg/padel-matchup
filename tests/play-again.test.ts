import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, facts, groupMembers, groups, notices, scores, slots, tournamentMatches, tournamentRounds, type Event, type Player } from "@/db/schema";
import { NO_SIDE_EFFECTS, joinAsPlayer } from "@/lib/api/operations";
import { anonymizePlayer } from "@/lib/domain/anonymize";
import { createEvent, duplicateEvent, mayMoveStart, nextWeekAfter, updateEvent, type CreateEventInput } from "@/lib/domain/events";
import { autoCreateGroupMatches, createGroup, createGroupFromEvent, weeklyGroupFromEvent } from "@/lib/domain/groups";
import { joinWithPolicy, partnerAdmission } from "@/lib/domain/joining";
import { joinBarLevel, waivedByPlay } from "@/lib/domain/levels";
import { saveNoticeSettings } from "@/lib/domain/notices";
import { admissionAt, claimPlayAgainRound, crewGameAt, existingNextGame, lockCrewHour, maySendPlayAgainRound, nextGameFor, playAgainActor, rangeWaiverAt, playAgainDefault, playAgainRecipients, playAgainRoundOf, playAgainStart, playedWithOrganiser, sameNextGame, PLAY_AGAIN_FACT, PLAY_AGAIN_AHEAD_DAYS } from "@/lib/domain/playAgain";
import { getEventByCode } from "@/lib/domain/queries";
import { admitConfirmed, confirmLevel } from "@/lib/domain/verify";
import { joinEvent, reserveNames } from "@/lib/domain/slots";
import { notifyGroupMatch, notifyPlayAgain } from "@/lib/notify";
import { formatWeeklyWhen, timePatternOf } from "@/lib/dates";
import { baseUrl } from "@/lib/config";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";
import { freezeClock } from "./helpers/clock";
import ruMessages from "../messages/ru.json";

/**
 * "Play again", the owner's decision of 11 October 2026 (option A, "Make the one working group repeat
 * itself"): the organiser picks the day and the time, everything else carries over, the new match is
 * the crew's when the old one was, and each player of the last match hears once, "Are you in?". With it,
 * a player who already played a finished, scored match with the organiser is not held to that
 * organiser's level range.
 *
 * The clock: Sunday 11 October 2026, 12:00 in Phuket (05:00 UTC). The last game was Saturday 10
 * October at 18:00 Phuket (11:00 UTC), 90 minutes, scored. A week on is Saturday 17 October, 18:00.
 */
const NOW = new Date("2026-10-11T05:00:00.000Z");
freezeClock(NOW);
const TZ = "Asia/Bangkok";
const LAST = new Date("2026-10-10T11:00:00.000Z");

describe("Play again", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  /** A match these people played, the first organising, scored unless told otherwise. */
  const played = async (together: Player[], over: Partial<CreateEventInput> = {}, o: { scored?: boolean; startsAt?: Date } = {}) => {
    const startsAt = o.startsAt ?? LAST;
    const ev = await createEvent(db, { creatorPlayerId: together[0].id, type: "match", startsAt, tz: TZ, whenFull: "waitlist", venueName: "Warehaus", ...over });
    for (const p of together) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: new Date(startsAt.getTime() - HOUR) });
    if (o.scored !== false) await db.insert(scores).values([{ eventId: ev.id, setNumber: 1, sideA: 6, sideB: 4 }]);
    return ev;
  };

  describe("the day and the time", () => {
    it("defaults to the last game's day and time a week on, in the match's own zone", () => {
      expect(playAgainDefault({ startsAt: LAST, tz: TZ }, NOW)).toEqual({ date: "2026-10-17", time: "18:00" });
      expect(playAgainStart({ startsAt: LAST, tz: TZ }, null, NOW).toISOString()).toBe(nextWeekAfter(LAST, NOW).toISOString());
      // An empty pick is no pick.
      expect(playAgainStart({ startsAt: LAST, tz: TZ }, { date: "", time: "" }, NOW).toISOString()).toBe("2026-10-17T11:00:00.000Z");
    });

    it("counts the weeks from the last game however long ago it was", () => {
      // Three weeks and a day before the last game: the default is still the first Saturday after now.
      expect(playAgainDefault({ startsAt: new Date(LAST.getTime() - 21 * DAY), tz: TZ }, NOW)).toEqual({ date: "2026-10-17", time: "18:00" });
    });

    it("keeps the wall-clock time across a change of clocks", () => {
      // Madrid: Saturday 24 October 18:00 CEST (16:00 UTC). The clocks go back on Sunday 25 October, so
      // a week on is 18:00 CET, 17:00 UTC, and not 17:00 on the wall as seven times 24 hours would make it.
      const madrid = { startsAt: new Date("2026-10-24T16:00:00.000Z"), tz: "Europe/Madrid" };
      const sunday = new Date("2026-10-25T10:00:00.000Z");
      expect(playAgainDefault(madrid, sunday)).toEqual({ date: "2026-10-31", time: "18:00" });
      expect(playAgainStart(madrid, null, sunday).toISOString()).toBe("2026-10-31T17:00:00.000Z");
    });

    it("takes the day and the time the organiser picked, as a wall clock where the match is", () => {
      expect(playAgainStart({ startsAt: LAST, tz: TZ }, { date: "2026-10-15", time: "19:30" }, NOW).toISOString()).toBe("2026-10-15T12:30:00.000Z");
    });

    it("refuses a time already gone, one too far ahead, and anything that is not a day and a time", () => {
      const src = { startsAt: LAST, tz: TZ };
      expect(() => playAgainStart(src, { date: "2026-10-11", time: "11:59" }, NOW)).toThrow();
      expect(() => playAgainStart(src, { date: "2026-10-11", time: "12:00" }, NOW)).toThrow();
      const last = new Date(NOW.getTime() + PLAY_AGAIN_AHEAD_DAYS * DAY);
      expect(() => playAgainStart(src, { date: "2027-01-31", time: "12:00" }, NOW)).toThrow();
      expect(playAgainStart(src, { date: "2026-10-11", time: "12:01" }, NOW).getTime()).toBeLessThan(last.getTime());
      expect(() => playAgainStart(src, { date: "17/10/2026", time: "18:00" }, NOW)).toThrow();
      expect(() => playAgainStart(src, { date: "2026-10-17", time: "6pm" }, NOW)).toThrow();
    });
  });

  it("carries everything over to the day picked, and the crew's match stays the crew's", async () => {
    const ana = await makePlayer(db, "Ana");
    const crew = await createGroup(db, { name: "Saturday crew", creatorPlayerId: ana.id, tz: TZ });
    const old = await played([ana], { groupId: crew.id, durationMinutes: 120, court: "3", levelMin: 2.5, levelMax: 3.5, cost: "400 THB", category: "mixed", capacity: 4 });
    const startsAt = playAgainStart(old, { date: "2026-10-15", time: "19:30" }, NOW);
    const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt, now: NOW });
    expect(next.startsAt.toISOString()).toBe("2026-10-15T12:30:00.000Z");
    expect(next.groupId).toBe(crew.id);
    expect({ venue: next.venueName, court: next.court, length: next.durationMinutes, min: next.levelMin, max: next.levelMax, cost: next.cost, category: next.category, capacity: next.capacity }).toEqual({ venue: "Warehaus", court: "3", length: 120, min: 2.5, max: 3.5, cost: "400 THB", category: "mixed", capacity: 4 });
    // No pick, no change from before: a week on.
    const plain = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, now: NOW });
    expect(plain.startsAt.toISOString()).toBe("2026-10-17T11:00:00.000Z");
  });

  // Rule 37: "everything else carries over". An americano's named courts did not: the night played
  // again read "Court 1, Court 2" (audit of 11 October 2026).
  it("carries a night's named courts over, as the organiser named them", async () => {
    const ana = await makePlayer(db, "Ana");
    const night = await createEvent(db, { creatorPlayerId: ana.id, type: "tournament", startsAt: LAST, tz: TZ, whenFull: "waitlist", venueName: "Warehaus", capacity: 8, courts: 2 });
    await db.update(events).set({ courtNames: ["Centre", "Glass"] }).where(eq(events.id, night.id));
    const next = await duplicateEvent(db, { sourceEventId: night.id, creatorPlayerId: ana.id, now: NOW });
    expect(next.courtNames).toEqual(["Centre", "Glass"]);
    // A night with no names keeps none, and a match never carries any.
    const plain = await createEvent(db, { creatorPlayerId: ana.id, type: "tournament", startsAt: LAST, tz: TZ, whenFull: "waitlist", capacity: 8, courts: 2 });
    expect((await duplicateEvent(db, { sourceEventId: plain.id, creatorPlayerId: ana.id, now: NOW })).courtNames).toBeNull();
    expect((await createEvent(db, { creatorPlayerId: ana.id, type: "match", startsAt: LAST, tz: TZ, whenFull: "waitlist", courtNames: ["Centre"] })).courtNames).toBeNull();
  });

  it("is heard by each player who sat in the last match, and by nobody else", async () => {
    const ana = await makePlayer(db, "Ana");
    const [ben, cy, dee, eve] = [await makePlayer(db, "Ben"), await makePlayer(db, "Cy"), await makePlayer(db, "Dee"), await makePlayer(db, "Eve")];
    const old = await played([ana, ben, cy, dee]);
    // Eve is on the waiting list; a name the organiser held is nobody's inbox.
    await joinEvent(db, { eventId: old.id, playerId: eve.id, now: new Date(LAST.getTime() - HOUR) });
    const people = await playAgainRecipients(db, old, cy.id);
    // Cy tapped "Play again": Cy is not told. Ana organised and played: Ana is told.
    expect(people.map((p) => p.displayName).sort()).toEqual(["Ana", "Ben", "Dee"]);
  });

  it("leaves out a seat held for a name, and a player who deleted their account", async () => {
    const ana = await makePlayer(db, "Ana");
    const [ben, gone] = [await makePlayer(db, "Ben"), await makePlayer(db, "Gone")];
    const old = await played([ana, ben, gone]);
    await reserveNames(db, { eventId: old.id, actorPlayerId: ana.id, names: ["Held"], now: new Date(LAST.getTime() - HOUR) });
    await anonymizePlayer(db, gone.id, NOW);
    const people = await playAgainRecipients(db, old, ana.id);
    expect(people.map((p) => p.displayName)).toEqual(["Ben"]);
  });

  it("claims one round per old match, whoever taps and however often", async () => {
    const ana = await makePlayer(db, "Ana");
    const ben = await makePlayer(db, "Ben");
    const old = await played([ana, ben]);
    const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, now: NOW });
    const again = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ben.id, now: NOW });
    const taps = await Promise.all([claimPlayAgainRound(db, old, next, ana.id, NOW), claimPlayAgainRound(db, old, again, ben.id, NOW)]);
    expect(taps.filter(Boolean)).toHaveLength(1);
    expect(await claimPlayAgainRound(db, old, next, ana.id, NOW)).toBe(false);
    const rows = await db.select().from(facts).where(and(eq(facts.kind, PLAY_AGAIN_FACT), eq(facts.subjectId, old.id)));
    expect(rows).toHaveLength(1);
  });

  describe("who may send the round", () => {
    it("refuses a latecomer who takes a seat after the start and types the score, and keeps the round for the players", async () => {
      const ana = await makePlayer(db, "Ana");
      const [ben, zed] = [await makePlayer(db, "Ben"), await makePlayer(db, "Zed")];
      const old = await played([ana, ben], {}, { scored: false });
      // Zed opens the link five minutes into the game, takes the free seat, saves 6-0 and taps "Play again".
      await joinEvent(db, { eventId: old.id, playerId: zed.id, now: new Date(LAST.getTime() + 5 * 60_000) });
      await db.insert(scores).values([{ eventId: old.id, setNumber: 1, sideA: 6, sideB: 0 }]);
      const theirs = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: zed.id, now: NOW });
      expect(await claimPlayAgainRound(db, old, theirs, zed.id, NOW)).toBe(false);
      expect(await notifyPlayAgain(db, old, theirs, zed, NOW)).toBe(0);
      expect(await playAgainRoundOf(db, old.id)).toBeNull();
      // Ben sat in it from before the start: his tap sends the one round.
      const real = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ben.id, now: NOW });
      expect(await claimPlayAgainRound(db, old, real, ben.id, NOW)).toBe(true);
    });

    it("lets the organiser send it without a seat, and nobody else without a seat in the line-up", async () => {
      const org = await makePlayer(db, "Org");
      const [a, b, c, d, wait, out] = [await makePlayer(db, "A"), await makePlayer(db, "B"), await makePlayer(db, "C"), await makePlayer(db, "D"), await makePlayer(db, "Wait"), await makePlayer(db, "Out")];
      // Org organised and did not play. Wait was fifth on a match of four. Out never had a place.
      const old = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: LAST, tz: TZ, whenFull: "waitlist", capacity: 4 });
      for (const p of [a, b, c, d, wait]) await joinEvent(db, { eventId: old.id, playerId: p.id, now: new Date(LAST.getTime() - HOUR) });
      await db.insert(scores).values([{ eventId: old.id, setNumber: 1, sideA: 6, sideB: 3 }]);
      const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: org.id, now: NOW });
      expect(await claimPlayAgainRound(db, old, next, out.id, NOW)).toBe(false);
      expect(await claimPlayAgainRound(db, old, next, wait.id, NOW)).toBe(false);
      expect(await claimPlayAgainRound(db, old, next, org.id, NOW)).toBe(true);
    });

    it("refuses a latecomer's move of the start, so a seat taken after it never counts as taken before it", async () => {
      const ana = await makePlayer(db, "Ana");
      const [ben, zed] = [await makePlayer(db, "Ben"), await makePlayer(db, "Zed")];
      const old = await played([ana, ben], {}, { scored: false });
      // Zed takes the free seat five minutes in and types 6-0. Then he moves the start to one minute after his seat.
      await joinEvent(db, { eventId: old.id, playerId: zed.id, now: new Date(LAST.getTime() + 5 * 60_000) });
      await db.insert(scores).values([{ eventId: old.id, setNumber: 1, sideA: 6, sideB: 0 }]);
      const later = new Date(LAST.getTime() + 6 * 60_000);
      await expect(updateEvent(db, old.id, zed.id, { startsAt: later }, NOW)).rejects.toMatchObject({ code: "forbidden", message: "startsAt" });
      // Ben sat from before the start, and the start is the organiser's to move once it is gone.
      await expect(updateEvent(db, old.id, ben.id, { startsAt: later }, NOW)).rejects.toMatchObject({ code: "forbidden" });
      const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: zed.id, now: NOW });
      expect(await claimPlayAgainRound(db, old, next, zed.id, NOW)).toBe(false);
      expect(await playedWithOrganiser(db, ana.id, zed.id, NOW)).toBe(false);
      // The edit form sends the time it shows: the same start with a new note still saves.
      expect((await updateEvent(db, old.id, zed.id, { note: "Court 2", startsAt: LAST }, NOW)).event.note).toBe("Court 2");
      // The organiser may still correct the time of their own match.
      expect((await updateEvent(db, old.id, ana.id, { startsAt: later }, NOW)).event.startsAt.toISOString()).toBe(later.toISOString());
    });

    it("lets the organiser on the manage link move a start already gone, with no player or another one, and still refuses a seated player", async () => {
      const ana = await makePlayer(db, "Ana");
      const [ben, co] = [await makePlayer(db, "Ben"), await makePlayer(db, "Co")];
      const old = await played([ana, ben], {}, { scored: false });
      const later = new Date(LAST.getTime() + 30 * 60_000);
      // Ben sat from before the start, and has no manage link.
      await expect(updateEvent(db, old.id, ben.id, { startsAt: later }, NOW, { asOrganiser: false })).rejects.toMatchObject({ code: "forbidden", message: "startsAt" });
      expect(mayMoveStart(old, { playerId: ben.id, asOrganiser: false }, NOW)).toBe(false);
      // Ana on her second browser: the manage link, and no player in that browser.
      expect((await updateEvent(db, old.id, null, { startsAt: later }, NOW, { asOrganiser: true })).event.startsAt.toISOString()).toBe(later.toISOString());
      // A co-organiser on the manage link: another player, and the organiser's rights.
      const later2 = new Date(LAST.getTime() + 45 * 60_000);
      expect((await updateEvent(db, old.id, co.id, { startsAt: later2 }, NOW, { asOrganiser: true })).event.startsAt.toISOString()).toBe(later2.toISOString());
      // Before the start, anybody who may edit the match may move it; the form asks the same question.
      expect(mayMoveStart({ ...old, startsAt: new Date(NOW.getTime() + HOUR) }, { playerId: ben.id, asOrganiser: false }, NOW)).toBe(true);
      expect(mayMoveStart(old, { playerId: null, asOrganiser: false }, NOW)).toBe(false);
    });

    it("says to the page whether this viewer's tap sends the round", async () => {
      const ana = await makePlayer(db, "Ana");
      const [ben, zed] = [await makePlayer(db, "Ben"), await makePlayer(db, "Zed")];
      const old = await played([ana, ben], {}, { scored: false });
      await joinEvent(db, { eventId: old.id, playerId: zed.id, now: new Date(LAST.getTime() + 5 * 60_000) });
      // Nobody has played it yet: no tap sends.
      expect(await maySendPlayAgainRound(db, old.id, ana.id, NOW)).toBe(false);
      await db.insert(scores).values([{ eventId: old.id, setNumber: 1, sideA: 6, sideB: 0 }]);
      expect(await maySendPlayAgainRound(db, old.id, ana.id, NOW)).toBe(true);
      expect(await maySendPlayAgainRound(db, old.id, ben.id, NOW)).toBe(true);
      expect(await maySendPlayAgainRound(db, old.id, zed.id, NOW)).toBe(false);
    });

    it("tells the organiser on the manage link, with no player in that browser, that the tap sends the round", async () => {
      const ana = await makePlayer(db, "Ana");
      const ben = await makePlayer(db, "Ben");
      const old = await played([ana, ben]);
      // Ana's second browser: the manage link and no player. The tap goes as Ana, so the line must say it sends.
      const onManageLink = playAgainActor({ playerId: null, isCreator: true }, old);
      expect(onManageLink).toBe(ana.id);
      expect(await maySendPlayAgainRound(db, old.id, onManageLink!, NOW)).toBe(true);
      // A player in the browser taps as that player, manage link or not; a visitor with neither is nobody.
      expect(playAgainActor({ playerId: ben.id, isCreator: true }, old)).toBe(ben.id);
      expect(playAgainActor({ playerId: ben.id, isCreator: false }, old)).toBe(ben.id);
      expect(playAgainActor({ playerId: null, isCreator: false }, old)).toBeNull();
    });
  });

  describe("the crew's game already at that hour", () => {
    // The hourly run on Tuesday 13 October made the crew's game for Saturday 17 October 18:00; the tap is on Wednesday.
    const TUESDAY = new Date("2026-10-13T05:00:00.000Z");
    const WEDNESDAY = new Date("2026-10-14T05:00:00.000Z");
    const toldAbout = async (eventId: string) => (await db.select({ playerId: notices.playerId, key: notices.key }).from(notices).where(eq(notices.eventId, eventId))).map((r) => `${r.playerId}:${r.key}`).sort();

    it("lands on the game the weekly slot made, and the round goes only to the players who had not heard (the weekly slot first)", async () => {
      const ana = await makePlayer(db, "Ana");
      const [ben, cy, gus] = [await makePlayer(db, "Ben"), await makePlayer(db, "Cy"), await makePlayer(db, "Gus")];
      const old = await played([ana, ben, cy]);
      const { group } = await weeklyGroupFromEvent(db, { eventId: old.id, actorPlayerId: ana.id, fallbackName: "Crew" });
      // Gus sat in the last game too, but is not in the crew: the slot's notice never reached him.
      await joinEvent(db, { eventId: old.id, playerId: gus.id, now: new Date(LAST.getTime() - HOUR) });
      const [slot] = (await autoCreateGroupMatches(db, TUESDAY)).filter((c) => c.group.id === group.id);
      await notifyGroupMatch(db, slot.group, slot.event, group.creatorPlayerId);
      const [fresh] = await db.select().from(events).where(eq(events.id, old.id));
      const startsAt = playAgainStart(fresh, null, WEDNESDAY);
      expect(startsAt.toISOString()).toBe(slot.event.startsAt.toISOString());
      // Ben taps "Play again" with the default: the crew's game, not a second one beside it.
      expect((await existingNextGame(db, fresh, startsAt))?.code).toBe(slot.event.code);
      expect(await notifyPlayAgain(db, fresh, slot.event, ben, WEDNESDAY)).toBe(1);
      expect(await playAgainRoundOf(db, old.id)).toEqual({ nextCode: slot.event.code });
      // Cy heard from the slot, Gus from the round, Ana holds the seat and Ben tapped: nobody hears twice.
      expect(await toldAbout(slot.event.id)).toEqual([`${cy.id}:noticeItem.crewMatch`, `${ben.id}:noticeItem.crewMatch`, `${gus.id}:noticeItem.playAgain`].sort());
      // The round names the game's organiser.
      const [row] = await db.select().from(notices).where(and(eq(notices.eventId, slot.event.id), eq(notices.playerId, gus.id)));
      expect(row.params).toMatchObject({ name: "Ana" });
      expect(await db.select().from(events).where(and(eq(events.groupId, group.id), eq(events.startsAt, startsAt)))).toHaveLength(1);
    });

    it("finds no game for a match with no crew, another hour, or a game called off", async () => {
      const ana = await makePlayer(db, "Ana");
      const old = await played([ana, await makePlayer(db, "Ben")]);
      const { group } = await weeklyGroupFromEvent(db, { eventId: old.id, actorPlayerId: ana.id, fallbackName: "Crew" });
      const [slot] = (await autoCreateGroupMatches(db, TUESDAY)).filter((c) => c.group.id === group.id);
      const [fresh] = await db.select().from(events).where(eq(events.id, old.id));
      expect(await existingNextGame(db, fresh, new Date(slot.event.startsAt.getTime() + HOUR))).toBeNull();
      expect(await existingNextGame(db, { ...fresh, groupId: null }, slot.event.startsAt)).toBeNull();
      await db.update(events).set({ status: "cancelled" }).where(eq(events.id, slot.event.id));
      expect(await existingNextGame(db, fresh, slot.event.startsAt)).toBeNull();
    });

    it("tells the crew members who were not in the last match once, when \"Play again\" made the slot's game (\"Play again\" first)", async () => {
      const ana = await makePlayer(db, "Ana");
      const [ben, eve] = [await makePlayer(db, "Ben"), await makePlayer(db, "Eve")];
      const old = await played([ana, ben]);
      const { group } = await weeklyGroupFromEvent(db, { eventId: old.id, actorPlayerId: ana.id, fallbackName: "Crew" });
      // Eve is in the crew and sat this one out.
      await db.insert(groupMembers).values({ groupId: group.id, playerId: eve.id, role: "member" });
      const [fresh] = await db.select().from(events).where(eq(events.id, old.id));
      const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt: playAgainStart(fresh, null, NOW), now: NOW });
      await joinEvent(db, { eventId: next.id, playerId: ana.id, now: NOW });
      expect(await notifyPlayAgain(db, fresh, next, ana, NOW)).toBe(1);
      const due = (await autoCreateGroupMatches(db, TUESDAY)).filter((c) => c.group.id === group.id);
      expect(due.map((c) => ({ code: c.event.code, adopted: c.adopted }))).toEqual([{ code: next.code, adopted: true }]);
      await notifyGroupMatch(db, due[0].group, due[0].event, due[0].event.creatorPlayerId, { onlyUntold: true });
      expect(await toldAbout(next.id)).toEqual([`${ben.id}:noticeItem.playAgain`, `${eve.id}:noticeItem.crewMatch`].sort());
      // The next hour does not look at the slot again.
      expect((await autoCreateGroupMatches(db, new Date(TUESDAY.getTime() + HOUR))).filter((c) => c.group.id === group.id)).toHaveLength(0);
    });
  });

  describe("one game per crew hour", () => {
    const TUESDAY = new Date("2026-10-13T05:00:00.000Z");
    const crewWith = async () => {
      const ana = await makePlayer(db, "Ana");
      const ben = await makePlayer(db, "Ben");
      const old = await played([ana, ben]);
      const { group } = await weeklyGroupFromEvent(db, { eventId: old.id, actorPlayerId: ana.id, fallbackName: "Crew" });
      const [fresh] = await db.select().from(events).where(eq(events.id, old.id));
      return { ana, ben, old: fresh, group, startsAt: playAgainStart(fresh, null, NOW) };
    };

    it("always finds the first game made at that hour, whichever row the database reads first", async () => {
      const { ana, old, group, startsAt } = await crewWith();
      // Two games at one hour, as a race before the lock could leave them. Their times are set apart by hand, both ways.
      const g1 = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt, now: NOW });
      const g2 = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt, now: NOW });
      await db.update(events).set({ createdAt: new Date(NOW.getTime() + 60_000) }).where(eq(events.id, g1.id));
      await db.update(events).set({ createdAt: NOW }).where(eq(events.id, g2.id));
      expect((await crewGameAt(db, group.id, startsAt))?.code).toBe(g2.code);
      await db.update(events).set({ createdAt: new Date(NOW.getTime() - 60_000) }).where(eq(events.id, g1.id));
      expect((await crewGameAt(db, group.id, startsAt))?.code).toBe(g1.code);
    });

    it("lands a tap on the crew's game at that hour, and makes one when there is none", async () => {
      const { ana, ben, old, group, startsAt } = await crewWith();
      const first = await nextGameFor(db, old, { creatorPlayerId: ana.id, startsAt, now: NOW });
      expect(first.made).toBe(true);
      const second = await nextGameFor(db, old, { creatorPlayerId: ben.id, startsAt, now: NOW });
      expect(second).toMatchObject({ made: false, event: { code: first.event.code } });
      expect(await db.select().from(events).where(and(eq(events.groupId, group.id), eq(events.startsAt, startsAt)))).toHaveLength(1);
      // The weekly slot finds it too.
      expect((await autoCreateGroupMatches(db, TUESDAY)).filter((c) => c.group.id === group.id).map((c) => c.adopted)).toEqual([true]);
    });

    // A lock is proven by a transaction the test holds open, on real Postgres: PGlite has one connection
    // and queues the second caller, so it would pass with the lock removed.
    it.skipIf(!process.env.TEST_DATABASE_URL)("makes a second tap wait while the first is still making the game, then land on it", async () => {
      const { ana, ben, old, group, startsAt } = await crewWith();
      let second: Promise<{ event: Event; made: boolean }> | null = null;
      let made: Event | null = null;
      await db.transaction(async (tx) => {
        await lockCrewHour(tx, group.id, startsAt);
        made = await duplicateEvent(tx, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt, now: NOW });
        second = nextGameFor(db, old, { creatorPlayerId: ben.id, startsAt, now: NOW });
        await new Promise((r) => setTimeout(r, 300));
      });
      expect(await second!).toMatchObject({ made: false, event: { code: made!.code } });
      expect(await db.select().from(events).where(and(eq(events.groupId, group.id), eq(events.startsAt, startsAt)))).toHaveLength(1);
    });

    it.skipIf(!process.env.TEST_DATABASE_URL)("makes the weekly slot wait while a tap is still making the game, then take it", async () => {
      const { ana, old, group, startsAt } = await crewWith();
      let job: ReturnType<typeof autoCreateGroupMatches> | null = null;
      let made: Event | null = null;
      await db.transaction(async (tx) => {
        await lockCrewHour(tx, group.id, startsAt);
        made = await duplicateEvent(tx, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt, now: NOW });
        job = autoCreateGroupMatches(db, TUESDAY);
        await new Promise((r) => setTimeout(r, 300));
      });
      const mine = (await job!).filter((c) => c.group.id === group.id);
      expect(mine.map((c) => ({ code: c.event.code, adopted: c.adopted }))).toEqual([{ code: made!.code, adopted: true }]);
      expect(await db.select().from(events).where(and(eq(events.groupId, group.id), eq(events.startsAt, startsAt)))).toHaveLength(1);
    });
  });

  // PGlite has one connection, so it queues the second transaction and passes with the lock removed:
  // a pass there proves nothing. The test runs where the race is real, on Postgres (CI, or TEST_DATABASE_URL).
  it.skipIf(!process.env.TEST_DATABASE_URL)("makes a second tap wait while the first is still writing, then send nothing", async () => {
    const ana = await makePlayer(db, "Ana");
    const ben = await makePlayer(db, "Ben");
    const old = await played([ana, ben]);
    const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, now: NOW });
    // The first tap, held open between its write and its commit: the old match locked, its record written.
    // The second tap starts inside that window. A frozen clock and a fast fake hide this race, so the
    // window is made by hand (real Postgres is where it bites: TEST_DATABASE_URL).
    let second: Promise<boolean> | null = null;
    await db.transaction(async (tx) => {
      await tx.select({ id: events.id }).from(events).where(eq(events.id, old.id)).for("update");
      await tx.insert(facts).values({ kind: PLAY_AGAIN_FACT, channel: "web", actorPlayerId: ana.id, subjectType: "match", subjectId: old.id, code: old.code, data: { next: next.code } });
      second = claimPlayAgainRound(db, old, next, ben.id, NOW);
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(await second!).toBe(false);
  });

  it("hands a second tap at the same day and time the game the round already announced", async () => {
    const ana = await makePlayer(db, "Ana");
    const ben = await makePlayer(db, "Ben");
    const old = await played([ana, ben]);
    const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt: playAgainStart(old, null, NOW), now: NOW });
    // No round yet: nothing to hand on, and the help line still promises the message.
    expect(await playAgainRoundOf(db, old.id)).toBeNull();
    expect(await sameNextGame(db, old.id, next.startsAt)).toBeNull();
    expect(await claimPlayAgainRound(db, old, next, ana.id, NOW)).toBe(true);
    expect(await playAgainRoundOf(db, old.id)).toEqual({ nextCode: next.code });
    // Ben taps the default too: he lands on Ana's game, the one his message is about.
    expect(await sameNextGame(db, old.id, next.startsAt)).toBe(next.code);
    // Another day is another game.
    expect(await sameNextGame(db, old.id, new Date(next.startsAt.getTime() + DAY))).toBeNull();
    // A game that was called off is not handed on.
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, next.id));
    expect(await sameNextGame(db, old.id, next.startsAt)).toBeNull();
  });

  describe("the message", () => {
    let calls: { method: string; body: Record<string, unknown> }[] = [];
    beforeEach(() => {
      process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
      calls = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL, init?: RequestInit) => {
          const method = String(url).split("/").pop()!;
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          calls.push({ method, body });
          const result = method === "sendMessage" ? { message_id: 900 + calls.length, chat: { id: body.chat_id } } : true;
          return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
        }),
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });
    const dms = (chatId: number) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId);

    let tg = 7100;
    const round = async () => {
      const ana = await makePlayer(db, "Ana Ortiz");
      const ben = await makePlayer(db, "Ben", { telegramId: ++tg });
      const cy = await makePlayer(db, "Cy", { telegramId: ++tg });
      const dee = await makePlayer(db, "Dee", { telegramId: ++tg });
      const old = await played([ana, ben, cy, dee]);
      const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, now: NOW });
      await joinEvent(db, { eventId: next.id, playerId: ana.id });
      return { ana, ben, cy, dee, old, next };
    };

    it("goes once to each player, through the gate in one insert, with the card's one-tap join and the public link", async () => {
      const { ana, ben, cy, dee, old, next } = await round();
      // Dee switched "Your crew" off: the inbox keeps it, nothing is delivered.
      await saveNoticeSettings(db, dee.id, { kinds: { crew: false }, quietFrom: null, quietTo: null, quietTz: null });
      const insert = vi.spyOn(db, "insert");
      const told = await notifyPlayAgain(db, old, next, ana, NOW);
      const noticeInserts = insert.mock.calls.filter(([table]) => table === notices);
      insert.mockRestore();
      expect(noticeInserts).toHaveLength(1);
      expect(told).toBe(3);

      const [dm] = dms(Number(ben.telegramId));
      const text = String(dm.body.text);
      expect(text).toContain("Ana made the next game: Sat, Oct 17 18:00 at Warehaus. Are you in?");
      expect(text).not.toContain("Ortiz");
      const buttons = (dm.body.reply_markup as { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] }).inline_keyboard.flat();
      expect(buttons).toContainEqual({ text: "✅ I'm in", callback_data: `j:${next.code}` });
      // A forwarded message keeps its buttons: the public link, never a personal one.
      for (const b of buttons) expect(b.url ?? "").not.toContain("/p/");
      expect(dms(Number(cy.telegramId))).toHaveLength(1);
      expect(dms(Number(dee.telegramId))).toHaveLength(0);

      const rows = await db.select().from(notices).where(eq(notices.eventId, next.id));
      expect(rows.map((r) => r.playerId).sort()).toEqual([ben.id, cy.id, dee.id].sort());
      expect(new Set(rows.map((r) => `${r.kind}:${r.key}`))).toEqual(new Set(["crew:noticeItem.playAgain"]));
      expect(rows.find((r) => r.playerId === dee.id)?.deliveredAt).toBeNull();

      // The second tap on the same old match sends nothing and writes nothing.
      calls = [];
      expect(await notifyPlayAgain(db, old, next, ana, NOW)).toBe(0);
      expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
      expect(await db.select().from(notices).where(eq(notices.eventId, next.id))).toHaveLength(3);
    });

    it("sends nothing for a match nobody has played yet, and keeps its round for after the game", async () => {
      // Zed, a stranger, takes the free seat of Ana's match three days ahead and taps "Play again".
      const ana = await makePlayer(db, "Ana");
      const [ben, cy, zed] = [await makePlayer(db, "Ben", { telegramId: ++tg }), await makePlayer(db, "Cy", { telegramId: ++tg }), await makePlayer(db, "Zed")];
      const start = new Date(NOW.getTime() + 3 * DAY);
      const ahead = await played([ana, ben, cy], {}, { scored: false, startsAt: start });
      await joinEvent(db, { eventId: ahead.id, playerId: zed.id, now: NOW });
      const next = await duplicateEvent(db, { sourceEventId: ahead.id, creatorPlayerId: zed.id, now: NOW });
      expect(await notifyPlayAgain(db, ahead, next, zed, NOW)).toBe(0);
      // A score typed in before the start does not make it played.
      await db.insert(scores).values([{ eventId: ahead.id, setNumber: 1, sideA: 6, sideB: 1 }]);
      expect(await notifyPlayAgain(db, ahead, next, zed, NOW)).toBe(0);
      expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
      expect(await playAgainRoundOf(db, ahead.id)).toBeNull();
      // After the game, with its score, Ana's tap still has the one round.
      const after = new Date(start.getTime() + 2 * HOUR);
      const real = await duplicateEvent(db, { sourceEventId: ahead.id, creatorPlayerId: ana.id, now: after });
      expect(await notifyPlayAgain(db, ahead, real, ana, after)).toBe(3);
    });

    // The audit of 11 October 2026: the round was claimed in its own transaction before anything was
    // read, so a read that failed after it spent the one round on nobody, for good.
    it("keeps the round when a read after the claim fails, and the next tap sends it", async () => {
      const { ana, old, next } = await round();
      // The database falls over on the read of the people to tell, wherever that read runs.
      const failing = (h: Db): Db =>
        new Proxy(h, {
          get(t, k, r) {
            if (k === "select")
              return (fields?: Record<string, unknown>) => {
                if (fields && "player" in fields) throw new Error("the database fell over");
                return fields ? t.select(fields as never) : t.select();
              };
            if (k === "transaction") return (cb: (tx: Db) => Promise<unknown>) => t.transaction((tx) => cb(failing(tx as unknown as Db)));
            const v = Reflect.get(t, k, r);
            return typeof v === "function" ? v.bind(t) : v;
          },
        }) as Db;
      await expect(notifyPlayAgain(failing(db), old, next, ana, NOW)).rejects.toThrow("the database fell over");
      expect(await playAgainRoundOf(db, old.id)).toBeNull();
      expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
      expect(await notifyPlayAgain(db, old, next, ana, NOW)).toBe(3);
      expect(await playAgainRoundOf(db, old.id)).toEqual({ nextCode: next.code });
    });

    it("sends nothing for a match that was called off, even with a score", async () => {
      const { ana, old, next } = await round();
      await db.update(events).set({ status: "cancelled" }).where(eq(events.id, old.id));
      expect(await notifyPlayAgain(db, old, next, ana, NOW)).toBe(0);
      expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
    });

    it("by email carries the public match link and no link that binds or signs anybody in", async () => {
      const sinkFile = path.join(mkdtempSync(path.join(tmpdir(), "play-again-")), "mail.jsonl");
      process.env.RESEND_API_KEY = "re_test_only";
      process.env.EMAIL_SINK_FILE = sinkFile;
      process.env.TELEGRAM_BOT_USERNAME = "kicksmash_test_bot";
      const ana = await makePlayer(db, "Ana");
      // Fay has an address and no Telegram: the email is her channel, the one a "get this on Telegram" line would ride on.
      const fay = await makePlayer(db, "Fay", { email: "fay@example.com" });
      const old = await played([ana, fay]);
      const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, now: NOW });
      expect(await notifyPlayAgain(db, old, next, ana, NOW)).toBe(1);
      const [mail] = readFileSync(sinkFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { to: string; subject: string; text: string });
      expect(mail.to).toBe("fay@example.com");
      expect(mail.subject).toContain("Ana made the next game");
      expect(mail.text).toContain(`/${next.code}`);
      // One real line under the heading, never the heading twice (audit of 11 October 2026), and "I'm in"
      // to the public page with the join step open: one tap there, from the browser that knows Fay.
      expect(mail.text.split("Ana made the next game").length - 1).toBe(1);
      expect(mail.text).toContain("Tap “I'm in” and the match page opens at the join step.");
      expect(mail.text).toContain(`I'm in: ${baseUrl()}/${next.code}?join=1`);
      // Forwarded to a friend, it must not hand the friend Fay's account.
      expect(mail.text).not.toContain("start=p_");
      expect(mail.text).not.toContain("t.me/");
      expect(mail.text).not.toContain("/p/");
    });

    it("lets the player in with the one tap", async () => {
      const { ben, next } = await round();
      const { handleTelegramUpdate } = await import("@/lib/telegram/bot");
      const tap = await handleTelegramUpdate(db, { update_id: 1, callback_query: { id: "cb1", from: { id: Number(ben.telegramId), first_name: "Ben", language_code: "en" }, message: { message_id: 901, date: 0, chat: { id: Number(ben.telegramId), type: "private" } }, data: `j:${next.code}` } }, NO_SIDE_EFFECTS);
      expect(tap).toBe("join:joined");
    });
  });

  describe("the level range, for somebody the organiser played with", () => {
    const ranged = (org: Player, over: Partial<CreateEventInput> = {}) => createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 6 * DAY), tz: TZ, whenFull: "waitlist", levelMin: 3, levelMax: 3.5, ...over });
    const join = async (ev: Event, p: Player) => joinWithPolicy(db, (await getEventByCode(db, ev.code))!, p, p.level);

    it("is the pure rule: only the range is waived, never a missing level or the confirmed-levels-only check", () => {
      const range = { levelMin: 3, levelMax: 3.5, levelVerifiedOnly: false };
      const confirmedOnly = { ...range, levelVerifiedOnly: true };
      expect(waivedByPlay(range, { level: 2 }, true)).toBe("ok");
      expect(waivedByPlay(range, { level: 5 }, true)).toBe("ok");
      expect(waivedByPlay(range, { level: null }, true)).toBe("unknown");
      expect(waivedByPlay(range, { level: 2 }, false)).toBe("below");
      expect(waivedByPlay(range, { level: 3.25 }, false)).toBe("ok");
      // A confirmed-levels-only match: the range goes, the confirmation stays.
      expect(waivedByPlay(confirmedOnly, { level: 3.25 }, true)).toBe("unverified");
      expect(waivedByPlay(confirmedOnly, { level: 2 }, true)).toBe("unverified");
      expect(waivedByPlay(confirmedOnly, { level: 2, levelVerifiedLevel: 2 }, true)).toBe("ok");
      expect(waivedByPlay(confirmedOnly, { level: 2, levelVerifiedLevel: 2 }, false)).toBe("below");
    });

    it("lets a player who sat in a finished, scored match with the organiser straight in", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      await played([org, pal]);
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(true);
      const ev = await ranged(org);
      expect(await join(ev, pal)).toMatchObject({ kind: "joined", result: { outcome: "joined" } });
    });

    it("lets them in through the chat's one tap and the API too", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 5 });
      await played([org, pal]);
      const ev = await ranged(org);
      const r = await joinAsPlayer(db, (await getEventByCode(db, ev.code))!, pal, NO_SIDE_EFFECTS);
      expect(r.outcome).toBe("joined");
    });

    it("waives the range of a confirmed-levels-only match, and still asks for a confirmed level", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      // Pal fits the range and declared it; Low is below it and declared; Sure is below it and confirmed.
      const pal = await makePlayer(db, "Pal", { level: 3.25 });
      const low = await makePlayer(db, "Low", { level: 2 });
      const sure = await makePlayer(db, "Sure", { level: 2, levelVerifiedLevel: 2 });
      await played([org, pal, low, sure]);
      const ev = await ranged(org, { levelVerifiedOnly: true });
      expect(await admissionAt(db, ev, pal, NOW)).toBe("unverified");
      expect(await admissionAt(db, ev, low, NOW)).toBe("unverified");
      expect(await admissionAt(db, ev, sure, NOW)).toBe("ok");
      expect(await join(ev, pal)).toEqual({ kind: "requested" });
      expect(await join(ev, sure)).toMatchObject({ kind: "joined" });
    });

    it("lets a past partner's waiting ask in once a coach confirms a level outside the range, and keeps a stranger's waiting", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const coach = await makePlayer(db, "Coach");
      // Low played with Org; Other did not. Both are below the range and ask to join with a declared level.
      const low = await makePlayer(db, "Low", { level: 2 });
      const other = await makePlayer(db, "Other", { level: 2 });
      await played([org, low]);
      const ev = await ranged(org, { levelVerifiedOnly: true });
      expect(await join(ev, low)).toEqual({ kind: "requested" });
      expect(await join(ev, other)).toMatchObject({ kind: "requested" });
      // The coach confirms both at 2, outside the range: only the past game with Org lets Low in.
      const lowSure = await confirmLevel(db, { playerId: low.id, level: 2, byPlayerId: coach.id, source: "coach", now: NOW });
      const admitted = await admitConfirmed(db, lowSure, coach.id, NOW);
      expect(admitted.map((a) => [a.event.id, a.join.outcome])).toEqual([[ev.id, "joined"]]);
      const otherSure = await confirmLevel(db, { playerId: other.id, level: 2, byPlayerId: coach.id, source: "coach", now: NOW });
      expect(await admitConfirmed(db, otherSure, coach.id, NOW)).toEqual([]);
    });

    it("tells the join bar why: a confirmed level, not the range, is what a past partner still needs", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const low = await makePlayer(db, "Low", { level: 2 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      const fits = await makePlayer(db, "Fits", { level: 3.25 });
      const stranger = await makePlayer(db, "Stranger", { level: 2 });
      await played([org, low, pal, fits]);
      const strict = await ranged(org, { levelVerifiedOnly: true });
      const plain = await ranged(org);
      expect(await rangeWaiverAt(db, strict, low, NOW)).toBe("unverified");
      expect(await rangeWaiverAt(db, plain, pal, NOW)).toBe("ok");
      // Nothing waived: a stranger, a level the range lets in, the organiser.
      expect(await rangeWaiverAt(db, strict, stranger, NOW)).toBeNull();
      expect(await rangeWaiverAt(db, strict, fits, NOW)).toBeNull();
      expect(await rangeWaiverAt(db, strict, org, NOW)).toBeNull();
      // The bar: "unverified" asks for a confirmation (the verifier chips), never "outside the range".
      const bar = (waived: "ok" | "unverified" | null, level: number, verified = false) => joinBarLevel({ range: { min: 3, max: 3.5 }, level, verifiedOnly: true, verified, waived });
      expect(bar("unverified", 2)).toEqual({ needsLevel: false, outOfRange: false, unverified: true });
      expect(bar(null, 2)).toEqual({ needsLevel: false, outOfRange: true, unverified: false });
      expect(bar("ok", 2, true)).toEqual({ needsLevel: false, outOfRange: false, unverified: false });
      expect(bar(null, 3.25)).toEqual({ needsLevel: false, outOfRange: false, unverified: true });
      expect(bar(null, 3.25, true)).toEqual({ needsLevel: false, outOfRange: false, unverified: false });
    });

    it("still holds a player who took a seat after the start, and one whose organiser took a seat only after it", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const zed = await makePlayer(db, "Zed", { level: 1 });
      // Zed joins ten minutes into Org's game and types a score.
      const ev = await played([org], {}, { scored: false });
      await joinEvent(db, { eventId: ev.id, playerId: zed.id, now: new Date(LAST.getTime() + 10 * 60_000) });
      await db.insert(scores).values([{ eventId: ev.id, setNumber: 1, sideA: 6, sideB: 0 }]);
      expect(await playedWithOrganiser(db, org.id, zed.id, NOW)).toBe(false);
      expect(await admissionAt(db, await ranged(org), zed, NOW)).toBe("below");
      // The other way round: Pal sat from before the start, Org took a seat only after it.
      const pal = await makePlayer(db, "Pal", { level: 2 });
      const late = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: LAST, tz: TZ, whenFull: "waitlist" });
      await joinEvent(db, { eventId: late.id, playerId: pal.id, now: new Date(LAST.getTime() - HOUR) });
      await joinEvent(db, { eventId: late.id, playerId: org.id, now: new Date(LAST.getTime() + 10 * 60_000) });
      await db.insert(scores).values([{ eventId: late.id, setNumber: 1, sideA: 6, sideB: 2 }]);
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
    });

    it("lets them take the place beside a partner on the organiser's ranged fixed-pairs night", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      const stranger = await makePlayer(db, "Stranger", { level: 2 });
      const blank = await makePlayer(db, "Blank");
      await played([org, pal, blank]);
      const night = await ranged(org, { type: "tournament", capacity: 8, fixedPairs: true });
      expect(await partnerAdmission(db, night, pal, false, NOW)).toBe("ok");
      expect(await partnerAdmission(db, night, stranger, false, NOW)).toBe("forbidden");
      expect(await partnerAdmission(db, night, blank, false, NOW)).toBe("level_required");
      // Somebody already in (the organiser let them in) pairs without a second check.
      expect(await partnerAdmission(db, night, stranger, true, NOW)).toBe("ok");
    });

    it("still holds a player whose match with the organiser has no score", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      await played([org, pal], {}, { scored: false });
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
      expect(await join(await ranged(org), pal)).toEqual({ kind: "requested" });
    });

    it("counts a match scored at the court, before its booked length is over", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      // Started 75 minutes ago and booked for 90: the score is in, so the game is finished in practice,
      // and Pal's "I'm in" on the next game must not turn into a request for the last quarter of an hour.
      await played([org, pal], {}, { startsAt: new Date(NOW.getTime() - 75 * 60_000) });
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(true);
      expect(await join(await ranged(org), pal)).toMatchObject({ kind: "joined" });
    });

    it("does not count a score on a match that has not started", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      await played([org, pal], {}, { startsAt: new Date(NOW.getTime() + HOUR) });
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
    });

    it("still holds a player whose scored match with the organiser was then called off", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      const ev = await played([org, pal]);
      await db.update(events).set({ status: "cancelled" }).where(eq(events.id, ev.id));
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
      expect(await join(await ranged(org), pal)).toEqual({ kind: "requested" });
    });

    it("still holds a player when the organiser only waited on the list, or declined the seat", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      // Org made a full match and sat on its waiting list: Pal held a seat, Org never played with Pal.
      const [x, y, z] = [await makePlayer(db, "X"), await makePlayer(db, "Y"), await makePlayer(db, "Z")];
      const full = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: LAST, tz: TZ, whenFull: "waitlist", capacity: 4 });
      for (const p of [pal, x, y, z, org]) await joinEvent(db, { eventId: full.id, playerId: p.id, now: new Date(LAST.getTime() - HOUR) });
      await db.insert(scores).values([{ eventId: full.id, setNumber: 1, sideA: 6, sideB: 3 }]);
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
      expect(await join(await ranged(org), pal)).toEqual({ kind: "requested" });
      // Org's seat inside the line-up, but declined: not a taken seat either.
      const other = await makePlayer(db, "Pat", { level: 2 });
      const ev = await played([org, other]);
      await db.update(slots).set({ status: "declined" }).where(and(eq(slots.eventId, ev.id), eq(slots.playerId, org.id)));
      expect(await playedWithOrganiser(db, org.id, other.id, NOW)).toBe(false);
    });

    it("counts a scored americano with the organiser, and not one with no score", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      const [x, y] = [await makePlayer(db, "X"), await makePlayer(db, "Y")];
      const night = await played([org, pal, x, y], { type: "tournament", capacity: 4 }, { scored: false });
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
      const [r] = await db.insert(tournamentRounds).values({ eventId: night.id, roundNumber: 1 }).returning();
      await db.insert(tournamentMatches).values({ roundId: r.id, court: 1, a1: org.id, a2: pal.id, b1: x.id, b2: y.id });
      // A round drawn but not scored is not a game played.
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
      await db.update(tournamentMatches).set({ sideA: 16, sideB: 8 }).where(eq(tournamentMatches.roundId, r.id));
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(true);
    });

    it("still holds a player who played with somebody else, or on the organiser's waiting list", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const other = await makePlayer(db, "Other", { level: 3 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      // Organised by Org, but Org did not sit in it: Org never saw Pal play.
      const ev0 = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: LAST, tz: TZ, whenFull: "waitlist" });
      for (const p of [other, pal]) await joinEvent(db, { eventId: ev0.id, playerId: p.id, now: new Date(LAST.getTime() - HOUR) });
      await db.insert(scores).values([{ eventId: ev0.id, setNumber: 1, sideA: 6, sideB: 2 }]);
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
      // A full match where Pal only waited.
      const full = await played([org, other, await makePlayer(db, "X"), await makePlayer(db, "Y")]);
      await joinEvent(db, { eventId: full.id, playerId: pal.id, now: new Date(LAST.getTime() - HOUR) });
      expect(await playedWithOrganiser(db, org.id, pal.id, NOW)).toBe(false);
      expect(await join(await ranged(org), pal)).toEqual({ kind: "requested" });
    });

    it("still asks a player with no level for one: nothing else about levels changes", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const pal = await makePlayer(db, "Pal");
      await played([org, pal]);
      expect(await join(await ranged(org), pal)).toEqual({ kind: "level_required" });
    });

    it("is the organiser's own range only: another organiser's match still holds them", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const host = await makePlayer(db, "Host", { level: 3.25 });
      const pal = await makePlayer(db, "Pal", { level: 2 });
      await played([org, pal]);
      expect(await join(await ranged(host), pal)).toEqual({ kind: "requested" });
    });

    it("reads nothing for a player the range lets in anyway", async () => {
      const org = await makePlayer(db, "Org", { level: 3.25 });
      const fits = await makePlayer(db, "Fits", { level: 3.25 });
      const ev = await ranged(org);
      const select = vi.spyOn(db, "select");
      expect(await admissionAt(db, ev, fits, NOW)).toBe("ok");
      expect(select).not.toHaveBeenCalled();
      select.mockRestore();
    });
  });

  describe("the weekly slot beside it", () => {
    // The hourly run on Tuesday 13 October, inside the slot's five days of lead time before Saturday 17 October.
    const TUESDAY = new Date("2026-10-13T05:00:00.000Z");
    const groupRow = async (id: string) => (await db.select().from(groups).where(eq(groups.id, id)))[0];
    const inSlot = async (groupId: string, at: Date) => db.select().from(events).where(and(eq(events.groupId, groupId), eq(events.startsAt, at)));

    it("never makes a second match for the hour \"Play again\" already took (the weekly slot first)", async () => {
      const ana = await makePlayer(db, "Ana");
      const old = await played([ana, await makePlayer(db, "Ben")]);
      const { group } = await weeklyGroupFromEvent(db, { eventId: old.id, actorPlayerId: ana.id, fallbackName: "Crew" });
      const [fresh] = await db.select().from(events).where(eq(events.id, old.id));
      const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt: playAgainStart(fresh, null, NOW), now: NOW });
      expect(next.groupId).toBe(group.id);
      // The slot takes the game that is there (to tell the members who have not heard), and makes none.
      expect((await autoCreateGroupMatches(db, TUESDAY)).filter((c) => c.group.id === group.id).map((c) => ({ code: c.event.code, adopted: c.adopted }))).toEqual([{ code: next.code, adopted: true }]);
      expect(await inSlot(group.id, next.startsAt)).toHaveLength(1);
      // The slot counts as made, so the next hour does not look at it again.
      expect((await groupRow(group.id)).recurLastCreatedFor?.toISOString()).toBe(next.startsAt.toISOString());
    });

    it("takes the game \"Play again\" made into the crew, so the slot sees it (\"Play again\" first)", async () => {
      const ana = await makePlayer(db, "Ana");
      const old = await played([ana, await makePlayer(db, "Ben")]);
      const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt: playAgainStart(old, null, NOW), now: NOW });
      expect(await claimPlayAgainRound(db, old, next, ana.id, NOW)).toBe(true);
      const { group } = await weeklyGroupFromEvent(db, { eventId: old.id, actorPlayerId: ana.id, fallbackName: "Crew" });
      expect((await getEventByCode(db, next.code))!.event.groupId).toBe(group.id);
      expect((await autoCreateGroupMatches(db, TUESDAY)).filter((c) => c.group.id === group.id && !c.adopted)).toHaveLength(0);
      expect(await inSlot(group.id, next.startsAt)).toHaveLength(1);
    });

    it("takes the game \"Play again\" made into a crew made without a weekly slot, so a slot set later sees it", async () => {
      const ana = await makePlayer(db, "Ana");
      const old = await played([ana, await makePlayer(db, "Ben")]);
      const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt: playAgainStart(old, null, NOW), now: NOW });
      expect(await claimPlayAgainRound(db, old, next, ana.id, NOW)).toBe(true);
      const group = await createGroupFromEvent(db, { eventId: old.id, actorPlayerId: ana.id, fallbackName: "Crew" });
      expect((await getEventByCode(db, next.code))!.event.groupId).toBe(group.id);
      // An admin sets the weekly slot at that hour later, in the group's settings.
      const { dow, time } = timePatternOf(LAST, TZ);
      await db.update(groups).set({ recurDow: dow, recurTime: time }).where(eq(groups.id, group.id));
      expect((await autoCreateGroupMatches(db, TUESDAY)).filter((c) => c.group.id === group.id).map((c) => ({ code: c.event.code, adopted: c.adopted }))).toEqual([{ code: next.code, adopted: true }]);
      expect(await inSlot(group.id, next.startsAt)).toHaveLength(1);
    });

    it("still makes the slot's match when the game at that hour was called off", async () => {
      const ana = await makePlayer(db, "Ana");
      const old = await played([ana, await makePlayer(db, "Ben")]);
      const { group } = await weeklyGroupFromEvent(db, { eventId: old.id, actorPlayerId: ana.id, fallbackName: "Crew" });
      const [fresh] = await db.select().from(events).where(eq(events.id, old.id));
      const next = await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt: playAgainStart(fresh, null, NOW), now: NOW });
      await db.update(events).set({ status: "cancelled" }).where(eq(events.id, next.id));
      expect((await autoCreateGroupMatches(db, TUESDAY)).filter((c) => c.group.id === group.id)).toHaveLength(1);
    });
  });

  it("names the weekly slot as a weekday and a time, with no comma, in a form every language can say", () => {
    expect(formatWeeklyWhen(LAST, TZ, "en")).toBe("Saturday 18:00");
    expect(formatWeeklyWhen(LAST, TZ, "ru")).toBe("суббота 18:00");
    expect(formatWeeklyWhen(LAST, TZ, "es")).toBe("sábado 18:00");
    // "Каждый" agrees with Sunday and not with Saturday or Wednesday: the line has no word that has to agree.
    expect(ruMessages.card.sameTimeDone).not.toMatch(/Кажд(ый|ую|ое)\s*\{when\}/);
    expect(ruMessages.card.sameTimeDone).toContain("{when}");
  });

  it("keeps the old match untouched", async () => {
    const ana = await makePlayer(db, "Ana");
    const old = await played([ana]);
    await duplicateEvent(db, { sourceEventId: old.id, creatorPlayerId: ana.id, startsAt: playAgainStart(old, { date: "2026-10-20", time: "07:00" }, NOW), now: NOW });
    const [row] = await db.select().from(events).where(eq(events.id, old.id));
    expect(row.startsAt.toISOString()).toBe(LAST.toISOString());
  });
});
