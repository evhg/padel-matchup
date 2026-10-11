import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, events, groups, metricsDaily, telegramCards, telegramChats, type ClubAvailability, type ClubFreeSlot } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { zonedTimeToUtc } from "@/lib/dates";
import { bestTimes } from "@/lib/domain/bestTimes";
import { claimClub, decideClub } from "@/lib/domain/clubs";
import { createEvent } from "@/lib/domain/events";
import { createGroup } from "@/lib/domain/groups";
import { handleTelegramUpdate } from "@/lib/telegram/bot";
import { strings } from "@/lib/telegram/card";
import { crewStartPayload } from "@/lib/telegram/deepLinks";
import type { TgMessage, TgUpdate } from "@/lib/telegram/api";
import { postWeeklyTimes, weeklyTimesDue, WEEKLY_TIMES } from "@/lib/telegram/weeklyTimes";
import { freezeClock } from "./helpers/clock";
import { createTestDb, HOUR, makePlayer } from "./helpers/db";

/**
 * The weekly best times in a crew's own Telegram group (the owner's decision of 11 October 2026,
 * "Weekly best times in the group"; DECIDING rules 5 and 36): once a week, 24 hours before the crew's
 * slot, the bot posts the free courts near the slot, unasked, in a group that opted in. Every Bot API
 * call is stubbed and read back from `calls`; no platform is read.
 *
 * NOW is Wednesday 14 October 2026, 12:00 UTC, 19:00 in Bangkok. The crew plays Thursdays at 19:00 at
 * Rawai, so its slot is Thursday the 15th, 12:00 UTC, exactly 24 hours out. Rawai Padel Club shows
 * free courts on Thursday from 18:00 to 21:00 (its own feed). Chalong Padel Club shows Thursday 19:30 to
 * 21:00 and Thursday 10:00 to 11:30, read from Playtomic's public page.
 */
const NOW = new Date("2026-10-14T12:00:00Z");
freezeClock(NOW);
const TZ = "Asia/Bangkok";
const at = (date: string, time: string) => zonedTimeToUtc(date, time, TZ);
const later = (ms: number) => new Date(NOW.getTime() + ms);
const span = (date: string, from: string, to: string, free = 2): ClubFreeSlot => ({ start: at(date, from).toISOString(), end: at(date, to).toISOString(), free });
const feed = (slots: ClubFreeSlot[], o: Partial<ClubAvailability> = {}): ClubAvailability => ({ fetchedAt: NOW.toISOString(), day: "2026-10-14", tz: TZ, slots, error: null, source: "ics_bookings", ...o });
const BOT = { id: 123456, is_bot: true, first_name: "Kicksmash" };
const ADMIN_RIGHTS = { status: "administrator", can_pin_messages: true, can_invite_users: true };
const en = strings("en");

type Call = { method: string; body: Record<string, unknown> };
let calls: Call[] = [];
let nextMessageId = 7000;
let members = new Map<string, Record<string, unknown>>();

function stubTelegram() {
  calls = [];
  members = new Map();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
      if (method === "sendMessage" || method === "sendPhoto") return reply({ message_id: nextMessageId++, chat: { id: body.chat_id } });
      if (method === "getChatMember") return reply(members.get(`${body.chat_id}:${body.user_id}`) ?? { status: "member" });
      if (method === "createChatInviteLink") return reply({ invite_link: `https://t.me/+crew${Math.abs(Number(body.chat_id))}` });
      return reply(true);
    }),
  );
}
const sent = (method: string) => calls.filter((c) => c.method === method);
const buttonsOf = (c: Call | undefined) => ((c?.body.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard ?? []).flat();
const user = (id: number, first_name: string) => ({ id, first_name, username: `${first_name.toLowerCase()}_tg`, language_code: "en" });

describe("the weekly best times in a crew's group", () => {
  let db: Db;
  let updateId = 1;
  let messageId = 1;
  let rawai = "";
  let chalong = "";
  beforeAll(async () => {
    ({ db } = await createTestDb());
  });
  beforeEach(async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
    process.env.TELEGRAM_WEBHOOK_SECRET = "hooksecret";
    process.env.TELEGRAM_BOT_USERNAME = "kicksmash_bot";
    stubTelegram();
    await db.delete(telegramCards);
    await db.delete(telegramChats);
    await db.delete(events);
    await db.delete(groups);
    await db.delete(clubs);
    await db.delete(metricsDaily);
    for (const [name, availability] of [
      ["Rawai Padel Club", feed([span("2026-10-15", "18:00", "21:00")])],
      ["Chalong Padel Club", feed([span("2026-10-15", "10:00", "11:30", 1), span("2026-10-15", "19:30", "21:00", 1)], { source: "scrape:playtomic", platform: "playtomic", days: ["2026-10-14", "2026-10-15", "2026-10-16"], fullAt: NOW.toISOString() })],
    ] as const) {
      const owner = await makePlayer(db, `Owner of ${name}`);
      const c = await claimClub(db, { name, playerId: owner.id, tz: TZ, courts: 4 });
      await decideClub(db, c.slug, true, NOW);
      const own = availability.source === "ics_bookings" ? { availabilityUrl: `https://${c.slug}.example/bookings.ics`, availabilityKind: "ics_bookings" } : {};
      await db.update(clubs).set({ ...own, availability, availabilityAt: NOW }).where(eq(clubs.slug, c.slug));
      if (name.startsWith("Rawai")) rawai = c.slug;
      else chalong = c.slug;
    }
  });
  afterEach(() => vi.unstubAllGlobals());

  const update = (u: Omit<TgUpdate, "update_id">) => handleTelegramUpdate(db, { update_id: updateId++, ...u }, NO_SIDE_EFFECTS);
  const say = (chat: TgMessage["chat"], from: ReturnType<typeof user>, text: string) => update({ message: { message_id: messageId++, date: 0, chat, from, text } });
  const tap = (chat: TgMessage["chat"], from: ReturnType<typeof user>, data: string, onMessage: number, buttons: string[]) =>
    update({ callback_query: { id: `cb${updateId}`, from, data, chat_instance: "x", message: { message_id: onMessage, date: 0, chat, from: BOT, reply_markup: { inline_keyboard: buttons.map((d) => [{ text: "x", callback_data: d }]) } } } as never });

  /** The crew's own group, read by the bot: Ana ties it with the crew page's link; the crew plays Thursdays at 19:00 at Rawai. */
  async function listeningCrew(chatId: number, o: { slot?: boolean } = {}) {
    const chat = { id: chatId, type: "supergroup" as const, title: "Thursday crew" };
    const anaId = Math.abs(chatId);
    const owner = await makePlayer(db, "Ana", { telegramId: anaId });
    const crew = await createGroup(db, { name: "Thursday crew", creatorPlayerId: owner.id, tz: TZ, venueName: "Rawai Padel Club" });
    if (o.slot !== false) await db.update(groups).set({ recurDow: 4, recurTime: "19:00" }).where(eq(groups.id, crew.id));
    members.set(`${chatId}:${anaId}`, { status: "creator" });
    members.set(`${chatId}:${BOT.id}`, ADMIN_RIGHTS);
    expect(await say(chat, user(anaId, "Ana"), `/start@kicksmash_bot ${crewStartPayload(crew.id, owner.id)}`)).toBe("crew_listening");
    calls = [];
    return { chat, crew, owner, anaId };
  }

  it("is due 24 hours before the slot, and for four hours after that, never closer to the game", () => {
    const g = { recurDow: 4, recurTime: "19:00", tz: TZ, archivedAt: null };
    const slot = at("2026-10-15", "19:00");
    expect(weeklyTimesDue(g, NOW)).toEqual(slot);
    expect(weeklyTimesDue(g, later(3 * HOUR + 59 * 60_000))).toEqual(slot);
    expect(weeklyTimesDue(g, later(4 * HOUR))).toBeNull();
    expect(weeklyTimesDue(g, later(-60_000))).toBeNull();
    expect(weeklyTimesDue({ ...g, archivedAt: NOW }, NOW)).toBeNull();
    expect(weeklyTimesDue({ ...g, recurDow: null }, NOW)).toBeNull();
    expect(WEEKLY_TIMES.leadMs).toBe(24 * HOUR);
  });

  it("posts once, unasked and silent: the free courts near the slot as buttons, the crew's club first, and no platform's name", async () => {
    const { chat } = await listeningCrew(-400100);
    expect(await postWeeklyTimes(db, NOW)).toEqual({ posted: 1, none: 0, booked: 0 });
    expect(sent("sendMessage")).toHaveLength(1);
    const post = sent("sendMessage")[0];
    expect(post.body.chat_id).toBe(chat.id);
    expect(post.body.text).toBe(en.weeklyTimes("Thu, Oct 15 19:00"));
    expect(post.body.disable_notification).toBe(true);
    expect(post.body.reply_parameters).toBeUndefined();
    const buttons = buttonsOf(post);
    // The crew's usual club at the slot itself; then the nearest other club. Chalong's morning is too far from the slot.
    expect(buttons.map((b) => b.text)).toEqual(["Thu, Oct 15 19:00 · Rawai Padel Club", "Thu, Oct 15 19:30 · Chalong Padel Club"]);
    expect(buttons[0].callback_data).toBe(`bt:${Math.round(at("2026-10-15", "19:00").getTime() / 60_000).toString(36)}:90:${rawai}`);
    expect(buttons.every((b) => (b.callback_data ?? "").length <= 64)).toBe(true);
    // Chalong's times are Playtomic's read, and the post says nothing of it.
    expect(JSON.stringify(post.body)).not.toMatch(/playtomic/i);
    // At most one a week: the next hourly runs before the slot post nothing more.
    calls = [];
    expect(await postWeeklyTimes(db, later(HOUR))).toEqual({ posted: 0, none: 0, booked: 0 });
    expect(await postWeeklyTimes(db, later(3 * HOUR))).toEqual({ posted: 0, none: 0, booked: 0 });
    expect(calls).toEqual([]);
    expect(Number((await db.select().from(metricsDaily).where(eq(metricsDaily.key, "tg_weekly_times")))[0]?.value ?? 0)).toBe(1);
  });

  it("a week on, the next slot gets its own post", async () => {
    await listeningCrew(-400200);
    expect((await postWeeklyTimes(db, NOW)).posted).toBe(1);
    // The next Thursday: the clubs show that week's courts.
    await db.update(clubs).set({ availability: feed([span("2026-10-22", "18:00", "21:00")], { fetchedAt: later(7 * 24 * HOUR).toISOString(), day: "2026-10-21" }), availabilityAt: later(7 * 24 * HOUR) }).where(eq(clubs.slug, rawai));
    calls = [];
    expect((await postWeeklyTimes(db, later(7 * 24 * HOUR))).posted).toBe(1);
    expect(buttonsOf(sent("sendMessage")[0]).map((b) => b.text)).toEqual(["Thu, Oct 22 19:00 · Rawai Padel Club"]);
  });

  it("posts nothing when no court is free near the slot", async () => {
    await listeningCrew(-400300);
    await db.update(clubs).set({ availability: feed([span("2026-10-15", "08:00", "10:00")]) }).where(eq(clubs.slug, rawai));
    await db.update(clubs).set({ availability: feed([span("2026-10-15", "08:00", "10:00")], { source: "scrape:playtomic", platform: "playtomic", days: ["2026-10-14", "2026-10-15", "2026-10-16"], fullAt: NOW.toISOString() }) }).where(eq(clubs.slug, chalong));
    expect(await postWeeklyTimes(db, NOW)).toEqual({ posted: 0, none: 1, booked: 0 });
    expect(calls).toEqual([]);
  });

  it("/quiet stops it at once, and a group that never opted in or a crew with no slot gets nothing", async () => {
    const { chat, anaId } = await listeningCrew(-400400);
    expect(await say(chat, user(anaId, "Ana"), "/quiet@kicksmash_bot")).toMatch(/quiet/);
    expect((await db.select().from(telegramChats).where(eq(telegramChats.chatId, chat.id)))[0].listeningSince).toBeNull();
    const quiet = await listeningCrew(-400500, { slot: false });
    void quiet;
    // A group tied to a crew by its first card, where nobody opted in: the bot does not listen there.
    const plain = await makePlayer(db, "Bo");
    const other = await createGroup(db, { name: "Friday crew", creatorPlayerId: plain.id, tz: TZ, venueName: "Rawai Padel Club" });
    await db.update(groups).set({ recurDow: 4, recurTime: "19:00" }).where(eq(groups.id, other.id));
    await db.insert(telegramChats).values({ chatId: -400600, type: "supergroup", title: "Friday", groupId: other.id });
    calls = [];
    expect(await postWeeklyTimes(db, NOW)).toEqual({ posted: 0, none: 0, booked: 0 });
    expect(sent("sendMessage")).toEqual([]);
  });

  it("the crew's game at the slot: its time is the card's own join, and a tap there takes the seat", async () => {
    const { chat, crew, owner } = await listeningCrew(-400700);
    const game = await createEvent(db, { creatorPlayerId: owner.id, type: "match", startsAt: at("2026-10-15", "19:00"), tz: TZ, venueName: "Rawai Padel Club", whenFull: "waitlist", groupId: crew.id });
    expect((await postWeeklyTimes(db, NOW)).posted).toBe(1);
    const post = sent("sendMessage")[0];
    const buttons = buttonsOf(post);
    expect(buttons[0]).toEqual({ text: "Thu, Oct 15 19:00 · Rawai Padel Club", callback_data: `j:${game.code}` });
    calls = [];
    expect(await tap(chat, user(9, "Lena"), `j:${game.code}`, 7000, buttons.map((b) => b.callback_data!))).toBe("join:joined");
  });

  it("a time of the post makes the match there, as a \"times?\" button does", async () => {
    const { chat } = await listeningCrew(-400800);
    await postWeeklyTimes(db, NOW);
    const post = sent("sendMessage")[0];
    const data = buttonsOf(post).map((b) => b.callback_data!);
    const chalongTap = data.find((d) => d.endsWith(chalong))!;
    calls = [];
    const outcome = await tap(chat, user(2, "Petr"), chalongTap, Number(post.body.message_id ?? 7000), data);
    expect(outcome).toMatch(/^times_created:/);
    const [made] = await db.select().from(events).where(and(eq(events.venueSlug, chalong), eq(events.startsAt, at("2026-10-15", "19:30"))));
    expect(made?.durationMinutes).toBe(90);
  });

  it("nothing when the slot's game has its court booked already", async () => {
    const { crew, owner } = await listeningCrew(-400900);
    const game = await createEvent(db, { creatorPlayerId: owner.id, type: "match", startsAt: at("2026-10-15", "19:00"), tz: TZ, venueName: "Rawai Padel Club", whenFull: "waitlist", groupId: crew.id });
    await db.update(events).set({ courtBookedAt: NOW, courtBookedBy: owner.id }).where(eq(events.id, game.id));
    expect(await postWeeklyTimes(db, NOW)).toEqual({ posted: 0, none: 0, booked: 1 });
    expect(sent("sendMessage")).toEqual([]);
  });

  it("around a slot, bestTimes keeps the starts near it and ranks the crew's own clubs, then the nearest", () => {
    const f = (slots: ClubFreeSlot[]) => ({ tz: TZ, fetchedAt: NOW.toISOString(), until: at("2026-10-16", "00:00").toISOString(), slots });
    const slot = at("2026-10-15", "19:00");
    const times = bestTimes({
      clubs: [
        { slug: "far", name: "Far", feed: f([span("2026-10-15", "10:00", "23:00")]) },
        { slug: "own", name: "Own", feed: f([span("2026-10-15", "20:00", "23:00")]), usual: true },
      ],
      patterns: [{ dow: 4, time: "19:00" }],
      lengthMinutes: 90,
      now: NOW,
      around: { at: slot, withinMs: 2 * HOUR },
    });
    expect(times.map((t) => `${t.name} ${t.time}`)).toEqual(["Own 20:00", "Far 19:00"]);
    // Without `around`, the soonest of the day: Far's morning, and Own's own time.
    expect(bestTimes({ clubs: [{ slug: "far", name: "Far", feed: f([span("2026-10-15", "10:00", "23:00")]) }], patterns: [], lengthMinutes: 90, now: NOW })[0].time).toBe("10:00");
  });
});
