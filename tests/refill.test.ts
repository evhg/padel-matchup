import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, pushSubscriptions, slots, type Event, type Player } from "@/db/schema";
import { REFILL_FANOUT_MAX, REFILL_MIN_NOTICE_MS, REFILL_WINDOW_MS } from "@/lib/config";
import { createEvent, type CreateEventInput } from "@/lib/domain/events";
import { createGroup } from "@/lib/domain/groups";
import { joinEvent, leaveEvent, removeFromSlot } from "@/lib/domain/slots";
import { claimRefillNotice, findRefillsDue, hasRefillAudience, isRefillDue, openRosterSpots, refillAudience, refillRecipients } from "@/lib/domain/refill";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * Somebody drops out the evening before and nobody is waiting. Three players turn up, or none do —
 * while the rest of the crew and the club's regulars are free that night and never hear about it.
 * These are the rules for telling them, and for not turning that into a mailing list.
 */
const NOW = new Date("2026-09-14T09:00:00.000Z");
freezeClock(NOW);
const inHours = (h: number) => new Date(NOW.getTime() + h * HOUR);

describe("a spot that opens", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const judge = (over: Partial<Pick<Event, "status" | "startsAt" | "refillNoticeAt">> = {}) => ({
    status: "open" as const,
    startsAt: inHours(6),
    refillNoticeAt: null,
    ...over,
  });

  /** A player who turned push on: without one there is no channel, and the notice is not a notice. */
  const withPush = async (name: string, extra: Record<string, unknown> = {}) => {
    const p = await makePlayer(db, name, extra);
    await db.insert(pushSubscriptions).values({ playerId: p.id, endpoint: `https://push.example/${p.id}`, p256dh: "key", auth: "auth" });
    return p;
  };

  const aMatch = async (creator: Player, over: Partial<CreateEventInput> = {}) =>
    createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: inHours(6), tz: "Asia/Bangkok", whenFull: "waitlist", ...over });

  it("is worth telling people about only inside the window, once, and only while the seat is free", () => {
    expect(isRefillDue(judge(), 1, NOW)).toBe(true);
    // Too far out: the crew fills it themselves, and a push two days early is noise.
    expect(isRefillDue(judge({ startsAt: new Date(NOW.getTime() + REFILL_WINDOW_MS + 1) }), 1, NOW)).toBe(false);
    expect(isRefillDue(judge({ startsAt: new Date(NOW.getTime() + REFILL_WINDOW_MS) }), 1, NOW)).toBe(true);
    // Too close: nobody can get to the court, so the notice only makes the phone buzz.
    expect(isRefillDue(judge({ startsAt: new Date(NOW.getTime() + REFILL_MIN_NOTICE_MS - 1) }), 1, NOW)).toBe(false);
    expect(isRefillDue(judge({ startsAt: new Date(NOW.getTime() + REFILL_MIN_NOTICE_MS) }), 1, NOW)).toBe(true);
    // A seat somebody took while we were deciding, a cancelled match, and the second time round.
    expect(isRefillDue(judge(), 0, NOW)).toBe(false);
    expect(isRefillDue(judge({ status: "cancelled" }), 1, NOW)).toBe(false);
    expect(isRefillDue(judge({ status: "full" }), 1, NOW)).toBe(false);
    expect(isRefillDue(judge({ refillNoticeAt: NOW }), 1, NOW)).toBe(false);
  });

  it("belongs to whoever claims it first, and to nobody after that", async () => {
    const org = await makePlayer(db, "Org");
    const ev = await aMatch(org);
    const [first, second] = [await claimRefillNotice(db, ev.id, NOW), await claimRefillNotice(db, ev.id, NOW)];
    expect([first, second]).toEqual([true, false]);
    const [row] = await db.select({ at: events.refillNoticeAt }).from(events).where(eq(events.id, ev.id));
    expect(row.at?.getTime()).toBe(NOW.getTime());
  });

  it("counts the seats nobody holds, and stops counting when they are taken", async () => {
    const org = await makePlayer(db, "Counter");
    const ev = await aMatch(org);
    expect(await openRosterSpots(db, ev)).toBe(4);
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    expect(await openRosterSpots(db, ev)).toBe(3);
  });

  it("goes to the crew, and never to somebody already in the match", async () => {
    const org = await withPush("Crew organiser");
    const [mate, waiting, quiet] = [await withPush("Crew mate"), await withPush("Crew waiting"), await makePlayer(db, "Crew no push")];
    const group = await createGroup(db, { name: "Tuesday crew", creatorPlayerId: org.id, tz: "Asia/Bangkok", memberIds: [mate.id, waiting.id, quiet.id] });
    const ev = await aMatch(org, { groupId: group.id });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    await joinEvent(db, { eventId: ev.id, playerId: waiting.id });

    const audience = await refillAudience(db, ev, NOW);
    const names = audience.map((p) => p.displayName);
    // The mate hears. The organiser and the player already in it do not, and neither does the member
    // who never turned push on — a notice with no channel is not a notice.
    expect(names).toEqual(["Crew mate"]);
  });

  it("goes to the club's regulars when the match is on the board, and to nobody when it is private", async () => {
    const org = await withPush("Club organiser");
    const regular = await withPush("Club regular");
    const past = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: inHours(-24 * 7), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Thanyapura", publicListing: true });
    await joinEvent(db, { eventId: past.id, playerId: regular.id, now: new Date(past.startsAt.getTime() - HOUR) });

    const listed = await aMatch(org, { venueName: "Thanyapura", publicListing: true });
    expect(hasRefillAudience(listed)).toBe(true);
    expect((await refillAudience(db, listed, NOW)).map((p) => p.displayName)).toEqual(["Club regular"]);

    // The same match, not on the board: a private game does not broadcast itself to forty strangers.
    const private_ = await aMatch(org, { venueName: "Thanyapura" });
    expect(hasRefillAudience(private_)).toBe(false);
    expect(await refillRecipients(db, private_.id, NOW)).toBeNull();
  });

  it("leaves out the players the match does not admit", async () => {
    const org = await withPush("Level organiser");
    const inside = await withPush("Inside", { level: 3 });
    const below = await withPush("Below", { level: 1 });
    const unrated = await withPush("Unrated");
    const group = await createGroup(db, { name: "Level crew", creatorPlayerId: org.id, tz: "Asia/Bangkok", memberIds: [inside.id, below.id, unrated.id] });
    const ev = await aMatch(org, { groupId: group.id, levelMin: 2.5, levelMax: 4 });
    expect((await refillAudience(db, ev, NOW)).map((p) => p.displayName)).toEqual(["Inside"]);
  });

  it("stops at the cap: filling a court is not running a mailing list", async () => {
    const org = await withPush("Big organiser");
    const ids: string[] = [];
    for (let i = 0; i < REFILL_FANOUT_MAX + 5; i++) ids.push((await withPush(`Member ${i}`)).id);
    const group = await createGroup(db, { name: "Big crew", creatorPlayerId: org.id, tz: "Asia/Bangkok", memberIds: ids });
    const ev = await aMatch(org, { groupId: group.id });
    expect(await refillAudience(db, ev, NOW)).toHaveLength(REFILL_FANOUT_MAX);
  });

  it("fires when somebody leaves and nobody was waiting, and stays quiet when the waitlist filled the seat", async () => {
    const org = await withPush("Leaver organiser");
    const four = [await withPush("A"), await withPush("B"), await withPush("C"), await withPush("D")];
    const mate = await withPush("Crew mate 2");
    const group = await createGroup(db, { name: "Leavers", creatorPlayerId: org.id, tz: "Asia/Bangkok", memberIds: [...four.map((p) => p.id), mate.id] });

    // Four in, nobody waiting: the seat D frees is a seat nobody takes.
    const empty = await aMatch(org, { groupId: group.id });
    for (const p of four) await joinEvent(db, { eventId: empty.id, playerId: p.id });
    await leaveEvent(db, { eventId: empty.id, playerId: four[3].id });
    const told = await refillRecipients(db, empty.id, NOW);
    expect(told?.players.map((p) => p.displayName)).toEqual(["Crew mate 2"]);
    // And exactly once: the second drop-out rides the first notice.
    await leaveEvent(db, { eventId: empty.id, playerId: four[2].id });
    expect(await refillRecipients(db, empty.id, NOW)).toBeNull();

    // Four in and one waiting: leaving promotes, the match is full again, and nobody is told anything.
    const waitlisted = await aMatch(org, { groupId: group.id });
    for (const p of four) await joinEvent(db, { eventId: waitlisted.id, playerId: p.id });
    await joinEvent(db, { eventId: waitlisted.id, playerId: mate.id });
    const res = await leaveEvent(db, { eventId: waitlisted.id, playerId: four[3].id });
    expect(res.promotion?.playerId).toBe(mate.id);
    expect(await refillRecipients(db, waitlisted.id, NOW)).toBeNull();
  });

  it("never offers a seat back to the person who gave it up", async () => {
    const org = await withPush("Giver organiser");
    const leaver = await withPush("Leaver");
    const pushed = await withPush("Pushed out");
    const mate = await withPush("Still here");
    const group = await createGroup(db, { name: "Givers", creatorPlayerId: org.id, tz: "Asia/Bangkok", memberIds: [leaver.id, pushed.id, mate.id] });
    const ev = await aMatch(org, { groupId: group.id });
    await joinEvent(db, { eventId: ev.id, playerId: leaver.id });
    await joinEvent(db, { eventId: ev.id, playerId: pushed.id });
    await leaveEvent(db, { eventId: ev.id, playerId: leaver.id });
    const [seat] = await db.select().from(slots).where(and(eq(slots.eventId, ev.id), eq(slots.playerId, pushed.id)));
    await removeFromSlot(db, { eventId: ev.id, slotId: seat.id, actorPlayerId: org.id });

    // Both seats are empty again and neither player is on the roster, so only the log remembers them.
    expect(await openRosterSpots(db, ev)).toBe(4);
    expect((await refillAudience(db, ev, NOW)).map((p) => p.displayName)).toEqual(["Still here"]);
  });

  it("sweeps up the spots that opened by every other path", async () => {
    const org = await withPush("Sweep organiser");
    const mate = await withPush("Sweep mate");
    const group = await createGroup(db, { name: "Sweepers", creatorPlayerId: org.id, tz: "Asia/Bangkok", memberIds: [mate.id] });
    const soon = await aMatch(org, { groupId: group.id });
    const tooFar = await aMatch(org, { groupId: group.id, startsAt: new Date(NOW.getTime() + REFILL_WINDOW_MS + HOUR) });
    const tooClose = await aMatch(org, { groupId: group.id, startsAt: new Date(NOW.getTime() + REFILL_MIN_NOTICE_MS - 60_000) });
    const private_ = await aMatch(org);

    const due = await findRefillsDue(db, NOW);
    const ids = due.map((e) => e.id);
    expect(ids).toContain(soon.id);
    expect(ids).not.toContain(tooFar.id);
    expect(ids).not.toContain(tooClose.id);
    expect(ids).not.toContain(private_.id);

    // Once told, it never comes back.
    await claimRefillNotice(db, soon.id, NOW);
    expect((await findRefillsDue(db, NOW)).map((e) => e.id)).not.toContain(soon.id);
  });
});
