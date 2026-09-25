import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, pushSubscriptions, slots, type Event, type Player } from "@/db/schema";
import { REFILL_EMAIL_MAX, REFILL_FANOUT_MAX, REFILL_MIN_NOTICE_MS, REFILL_WINDOW_MS } from "@/lib/config";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { cancelEvent, createEvent, type CreateEventInput } from "@/lib/domain/events";
import { createGroup } from "@/lib/domain/groups";
import { joinEvent, leaveEvent, removeFromSlot } from "@/lib/domain/slots";
import { claimRefillNotice, findRefillsDue, isRefillDue, openRosterSpots, reachesBeyondPartners, refillAudience, refillRecipients, type RefillReach } from "@/lib/domain/refill";
import { notifyRefill } from "@/lib/notify";
import { handleTelegramUpdate } from "@/lib/telegram/bot";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * Somebody drops out the evening before and nobody is waiting. Three players turn up, or none do —
 * while the rest of the crew and the club's regulars are free that night and never hear about it.
 * These are the rules for telling them, and for not turning that into a mailing list.
 */
const NOW = new Date("2026-09-14T09:00:00.000Z");
freezeClock(NOW);
const inHours = (h: number) => new Date(NOW.getTime() + h * HOUR);
/** The channels a deployment has. The first tests predate the others and speak about push alone. */
const PUSH: RefillReach = { telegram: false, email: false, push: true };
const ALL: RefillReach = { telegram: true, email: true, push: true };

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

    const audience = await refillAudience(db, ev, NOW, PUSH);
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
    expect(reachesBeyondPartners(listed)).toBe(true);
    expect((await refillAudience(db, listed, NOW, PUSH)).map((p) => p.displayName)).toEqual(["Club regular"]);

    // The same match, not on the board: a private game does not broadcast itself to forty strangers,
    // even with its organiser in it. The regular never played with them, so is a stranger to it.
    const private_ = await aMatch(org, { venueName: "Thanyapura" });
    await joinEvent(db, { eventId: private_.id, playerId: org.id });
    expect(reachesBeyondPartners(private_)).toBe(false);
    expect(await refillRecipients(db, private_.id, NOW, PUSH)).toBeNull();
  });

  it("leaves out the players the match does not admit", async () => {
    const org = await withPush("Level organiser");
    const inside = await withPush("Inside", { level: 3 });
    const below = await withPush("Below", { level: 1 });
    const unrated = await withPush("Unrated");
    const group = await createGroup(db, { name: "Level crew", creatorPlayerId: org.id, tz: "Asia/Bangkok", memberIds: [inside.id, below.id, unrated.id] });
    const ev = await aMatch(org, { groupId: group.id, levelMin: 2.5, levelMax: 4 });
    expect((await refillAudience(db, ev, NOW, PUSH)).map((p) => p.displayName)).toEqual(["Inside"]);
  });

  it("stops at the cap: filling a court is not running a mailing list", async () => {
    const org = await withPush("Big organiser");
    const ids: string[] = [];
    for (let i = 0; i < REFILL_FANOUT_MAX + 5; i++) ids.push((await withPush(`Member ${i}`)).id);
    const group = await createGroup(db, { name: "Big crew", creatorPlayerId: org.id, tz: "Asia/Bangkok", memberIds: ids });
    const ev = await aMatch(org, { groupId: group.id });
    expect(await refillAudience(db, ev, NOW, PUSH)).toHaveLength(REFILL_FANOUT_MAX);
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
    const told = await refillRecipients(db, empty.id, NOW, PUSH);
    expect(told?.players.map((p) => p.displayName)).toEqual(["Crew mate 2"]);
    // And exactly once: the second drop-out rides the first notice.
    await leaveEvent(db, { eventId: empty.id, playerId: four[2].id });
    expect(await refillRecipients(db, empty.id, NOW, PUSH)).toBeNull();

    // Four in and one waiting: leaving promotes, the match is full again, and nobody is told anything.
    const waitlisted = await aMatch(org, { groupId: group.id });
    for (const p of four) await joinEvent(db, { eventId: waitlisted.id, playerId: p.id });
    await joinEvent(db, { eventId: waitlisted.id, playerId: mate.id });
    const res = await leaveEvent(db, { eventId: waitlisted.id, playerId: four[3].id });
    expect(res.promotion?.playerId).toBe(mate.id);
    expect(await refillRecipients(db, waitlisted.id, NOW, PUSH)).toBeNull();
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
    expect((await refillAudience(db, ev, NOW, PUSH)).map((p) => p.displayName)).toEqual(["Still here"]);
  });

  it("sweeps up the spots that opened by every other path", async () => {
    const org = await withPush("Sweep organiser");
    const mate = await withPush("Sweep mate");
    const group = await createGroup(db, { name: "Sweepers", creatorPlayerId: org.id, tz: "Asia/Bangkok", memberIds: [mate.id] });
    const soon = await aMatch(org, { groupId: group.id });
    const tooFar = await aMatch(org, { groupId: group.id, startsAt: new Date(NOW.getTime() + REFILL_WINDOW_MS + HOUR) });
    const tooClose = await aMatch(org, { groupId: group.id, startsAt: new Date(NOW.getTime() + REFILL_MIN_NOTICE_MS - 60_000) });
    const private_ = await aMatch(org);
    // A private match with somebody in it has an audience now: the people that somebody played with.
    // A private tournament does not: thirty people in one draw are not thirty partners.
    const privateWithPlayer = await aMatch(org);
    await joinEvent(db, { eventId: privateWithPlayer.id, playerId: org.id });
    const privateTournament = await createEvent(db, { creatorPlayerId: org.id, type: "tournament", capacity: 8, startsAt: inHours(6), tz: "Asia/Bangkok", whenFull: "waitlist" });
    await joinEvent(db, { eventId: privateTournament.id, playerId: org.id });

    const due = await findRefillsDue(db, NOW);
    const ids = due.map((e) => e.id);
    expect(ids).toContain(soon.id);
    expect(ids).not.toContain(tooFar.id);
    expect(ids).not.toContain(tooClose.id);
    expect(ids).not.toContain(private_.id);
    expect(ids).toContain(privateWithPlayer.id);
    expect(ids).not.toContain(privateTournament.id);

    // Once told, it never comes back.
    await claimRefillNotice(db, soon.id, NOW);
    expect((await findRefillsDue(db, NOW)).map((e) => e.id)).not.toContain(soon.id);
  });
});

/**
 * The owner, 25 September 2026: "the fourth spot offered to past partners". On 24 September ten of
 * thirteen past matches never got past one or two players, and every match that filled was scored:
 * the match is lost at filling. Most of those were private, with no crew, so the refill reached
 * nobody at all. The people who played with somebody in the match are the ones who would come.
 *
 * Dates: NOW is Monday 14 September 2026, 09:00 UTC; the open match starts at 15:00 UTC, six hours
 * later, inside the window. A past match is `daysAgo` days before NOW, so one day ago has finished
 * (a match lasts two hours) and a negative number is still to come.
 */
describe("a free spot, offered to past partners", () => {
  let db: Db;
  let close: () => Promise<void>;
  type Call = { method: string; body: Record<string, unknown> };
  let calls: Call[] = [];
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const method = String(url).split("/").pop()!;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push({ method, body });
        const result = method === "sendMessage" ? { message_id: 700 + calls.length, chat: { id: body.chat_id } } : true;
        return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const dms = (chatId: number) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId);
  const names = (people: { displayName: string }[]) => people.map((p) => p.displayName).sort();

  /** A match these people played together, `daysAgo` days before NOW, the first of them organising. */
  const played = async (together: Player[], daysAgo: number, over: Partial<CreateEventInput> = {}) => {
    const startsAt = new Date(NOW.getTime() - daysAgo * DAY);
    const ev = await createEvent(db, { creatorPlayerId: together[0].id, type: "match", startsAt, tz: "Asia/Bangkok", whenFull: "waitlist", ...over });
    for (const p of together) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: new Date(startsAt.getTime() - HOUR) });
    return ev;
  };

  /** A private match six hours from NOW — no crew, not on a board — with its organiser in it. */
  const privateMatch = async (org: Player, over: Partial<CreateEventInput> = {}) => {
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: inHours(6), tz: "Asia/Bangkok", whenFull: "waitlist", ...over });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    return ev;
  };

  it("reaches a past partner in their own Telegram chat, with the card's one-tap join, once", async () => {
    const ana = await makePlayer(db, "Ana Ortiz");
    const ben = await makePlayer(db, "Ben", { telegramId: 5001 });
    await played([ana, ben], 10);
    const ev = await privateMatch(ana);
    expect(reachesBeyondPartners(ev)).toBe(false);

    const first = await notifyRefill(db, ev.id, NOW);
    expect(first).toMatchObject({ telegram: 1, told: 1 });
    const [dm] = dms(5001);
    const text = String(dm.body.text);
    expect(text).toContain("A spot is free");
    // Who is already playing, by first name only (rule 7).
    expect(text).toContain("Ana · 3 spots left");
    expect(text).not.toContain("Ortiz");
    const buttons = (dm.body.reply_markup as { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] }).inline_keyboard.flat();
    expect(buttons).toContainEqual({ text: "✅ I'm in", callback_data: `j:${ev.code}` });
    // The public link, never a personal one: a forwarded message keeps its buttons.
    expect(buttons.find((b) => b.url)?.url).not.toContain("/p/");

    // One notice per match, ever: the second run finds it claimed and says nothing.
    calls = [];
    expect(await notifyRefill(db, ev.id, NOW)).toMatchObject({ telegram: 0, emails: 0, pushes: 0, told: 0 });
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);

    // And the button does what the card's ✅ does: Ben is in.
    const tap = await handleTelegramUpdate(db, { update_id: 1, callback_query: { id: "cb1", from: { id: 5001, first_name: "Ben", language_code: "en" }, message: { message_id: 701, date: 0, chat: { id: 5001, type: "private" } }, data: `j:${ev.code}` } }, NO_SIDE_EFFECTS);
    expect(tap).toBe("join:joined");
  });

  it("tells nobody who shares no finished match with the players in it", async () => {
    const lea = await makePlayer(db, "Lea");
    // Each of these has exactly one reason to stay out.
    const cid = await makePlayer(db, "Cid", { telegramId: 5102 });
    const dee = await makePlayer(db, "Dee");
    await played([cid, dee], 5); // played, but with nobody in this match
    const old = await makePlayer(db, "Old", { telegramId: 5103 });
    await played([lea, old], 61); // before the sixty days
    const off = await makePlayer(db, "Off", { telegramId: 5104 });
    const cancelled = await played([lea, off], 5);
    await cancelEvent(db, cancelled.id, lea.id); // never played
    const soon = await makePlayer(db, "Soon", { telegramId: 5105 });
    await played([lea, soon], -1); // tomorrow: not played yet
    const draw = await makePlayer(db, "Draw", { telegramId: 5106 });
    const tournament = await createEvent(db, { creatorPlayerId: lea.id, type: "tournament", capacity: 8, startsAt: new Date(NOW.getTime() - 5 * DAY), tz: "Asia/Bangkok", whenFull: "waitlist" });
    for (const p of [lea, draw]) await joinEvent(db, { eventId: tournament.id, playerId: p.id, now: new Date(tournament.startsAt.getTime() - HOUR) });
    const pal = await makePlayer(db, "Pal", { telegramId: 5107 });
    await played([lea, pal], 59); // inside the sixty days

    const ev = await privateMatch(lea);
    expect(names(await refillAudience(db, ev, NOW, ALL))).toEqual(["Pal"]);
  });

  it("leaves out a past partner the match's level range does not admit", async () => {
    const lia = await makePlayer(db, "Lia", { level: 3 });
    const low = await makePlayer(db, "Low", { telegramId: 5201, level: 1 });
    const fit = await makePlayer(db, "Fit", { telegramId: 5202, level: 3.5 });
    await played([lia, low, fit], 7);
    const ev = await privateMatch(lia, { levelMin: 2.5, levelMax: 4 });
    expect(names(await refillAudience(db, ev, NOW, ALL))).toEqual(["Fit"]);
  });

  it("counts only a channel that reaches the person on this deployment", async () => {
    const org = await makePlayer(db, "Channel organiser");
    const tg = await makePlayer(db, "Tg", { telegramId: 5301 });
    const mail = await makePlayer(db, "Mail", { email: "mail@example.com" });
    const muted = await makePlayer(db, "Muted", { email: "muted@example.com", emailNotifications: false });
    const none = await makePlayer(db, "None");
    await played([org, tg, mail, muted], 4);
    await played([org, none], 3);
    const ev = await privateMatch(org);
    expect(names(await refillAudience(db, ev, NOW, ALL))).toEqual(["Mail", "Tg"]);
    expect(names(await refillAudience(db, ev, NOW, { telegram: false, email: true, push: false }))).toEqual(["Mail"]);
    expect(await refillAudience(db, ev, NOW, PUSH)).toEqual([]);
  });

  it("stops at the cap, and the freshest partners are the ones who hear", async () => {
    const org = await makePlayer(db, "Busy organiser");
    const byDay = new Map<number, string[]>();
    for (let day = 1; day <= 15; day++) {
      const three = [await makePlayer(db, `Partner ${day}a`, { telegramId: 6000 + day * 10 + 1 }), await makePlayer(db, `Partner ${day}b`, { telegramId: 6000 + day * 10 + 2 }), await makePlayer(db, `Partner ${day}c`, { telegramId: 6000 + day * 10 + 3 })];
      byDay.set(day, three.map((p) => p.displayName));
      await played([org, ...three], day);
    }
    const ev = await privateMatch(org);
    const told = (await refillAudience(db, ev, NOW, ALL)).map((p) => p.displayName);
    expect(told).toHaveLength(REFILL_FANOUT_MAX);
    // 45 partners, 40 seats in the notice: the three from fifteen days ago are the ones left out.
    for (const name of byDay.get(15)!) expect(told).not.toContain(name);
    for (const name of byDay.get(1)!) expect(told).toContain(name);
  });

  it("sends at most REFILL_EMAIL_MAX by email, and the bot still reaches everyone it can", async () => {
    // Twelve partners with only an address, the freshest first, and two on the bot from the oldest match.
    const org = await makePlayer(db, "Mail-heavy organiser");
    const mailed: string[] = [];
    for (let day = 1; day <= 4; day++) {
      const three = [];
      for (const x of ["a", "b", "c"]) three.push(await makePlayer(db, `Inbox ${day}${x}`, { email: `inbox-${day}${x}@example.com` }));
      mailed.push(...three.map((p) => p.displayName));
      await played([org, ...three], day);
    }
    const bots = [await makePlayer(db, "Bot 1", { telegramId: 7101 }), await makePlayer(db, "Bot 2", { telegramId: 7102 })];
    await played([org, ...bots], 5);
    const ev = await privateMatch(org);
    const told = (await refillAudience(db, ev, NOW, ALL)).map((p) => p.displayName);
    // The freshest first: all nine from the last three days, and one of the three from four days ago.
    const inbox = told.filter((n) => n.startsWith("Inbox"));
    expect(inbox).toHaveLength(REFILL_EMAIL_MAX);
    for (const n of mailed.slice(0, 9)) expect(inbox).toContain(n);
    expect(told).toEqual(expect.arrayContaining(["Bot 1", "Bot 2"]));
    expect(told).toHaveLength(REFILL_EMAIL_MAX + 2);
  });

  it("emails a past partner who has no bot, with the match link", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const sinkFile = path.join(mkdtempSync(path.join(tmpdir(), "refill-")), "mail.jsonl");
    process.env.RESEND_API_KEY = "re_test_only";
    process.env.EMAIL_SINK_FILE = sinkFile;
    const org = await makePlayer(db, "Mail organiser");
    const eva = await makePlayer(db, "Eva", { email: "eva@example.com" });
    await played([org, eva], 3);
    const ev = await privateMatch(org);

    expect(await notifyRefill(db, ev.id, NOW)).toMatchObject({ telegram: 0, emails: 1, told: 1 });
    expect(existsSync(sinkFile)).toBe(true);
    const [mail] = readFileSync(sinkFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { to: string; subject: string; text: string });
    expect(mail.to).toBe("eva@example.com");
    expect(mail.subject).toContain("A spot opened");
    expect(mail.text).toContain(`/${ev.code}`);
  });
});
