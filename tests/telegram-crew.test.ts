import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, feedback, metricsDaily, players, telegramCards, telegramChats } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { createEvent } from "@/lib/domain/events";
import { createGroup, crewTelegramDoors, crewTelegramInvite, handOverGroup, joinGroup } from "@/lib/domain/groups";
import { snapshotMetrics } from "@/lib/domain/metrics";
import { getEventByCode } from "@/lib/domain/queries";
import { joinEvent } from "@/lib/domain/slots";
import { handleTelegramUpdate, syncTelegram } from "@/lib/telegram/bot";
import { CREW_ADMIN_RIGHTS, crewGroupLink, crewPayloadGroup, crewStartPayload, verifyCrewPayload } from "@/lib/telegram/deepLinks";
import { CREW_NOTICE_VERSION } from "@/lib/telegram/handlers/crew";
import { strings } from "@/lib/telegram/card";
import type { TgMessage, TgUpdate } from "@/lib/telegram/api";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer } from "./helpers/db";

/**
 * A seat by a word, and a crew's own Telegram group run by the bot as an admin (DECIDING rule 31).
 *
 * Every Bot API call is stubbed: the stub answers getChatMember from `members`, makes an invite link
 * named after the chat, and refuses an ephemeral message when `ephemeralFails` is set. What the bot
 * sends, edits, pins and reacts is read back from `calls`; what it keeps is read back from the tables.
 */

// Saturday 10 October 2026, noon in Bangkok. Matches below are on Tuesday the 13th; Thursday is the 15th.
const NOW = new Date("2026-10-10T05:00:00Z");
freezeClock(NOW);
const TUESDAY_7PM = new Date("2026-10-13T12:00:00Z");
const WEDNESDAY_7PM = new Date("2026-10-14T12:00:00Z");
const THURSDAY_7PM = new Date("2026-10-15T12:00:00Z");

const TOKEN = "123456:TESTTOKEN";
const BOT = { id: 123456, is_bot: true, first_name: "Kicksmash" };
const inviteOf = (chatId: number) => `https://t.me/+crew${Math.abs(chatId)}`;

type Call = { method: string; body: Record<string, unknown> };
let calls: Call[] = [];
let nextMessageId = 1000;
/** "chatId:userId" → the member Telegram reports. */
let members = new Map<string, Record<string, unknown>>();
let ephemeralFails = false;
let pinFails = false;

function stubTelegram() {
  calls = [];
  members = new Map();
  ephemeralFails = false;
  pinFails = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      const reply = (result: unknown, ok = true) => new Response(JSON.stringify(ok ? { ok: true, result } : { ok: false, error_code: 400, description: String(result) }), { status: ok ? 200 : 400, headers: { "content-type": "application/json" } });
      if (method === "sendMessage" && body.ephemeral_message_parameters && ephemeralFails) return reply("Bad Request: ephemeral message can't be sent", false);
      if (method === "pinChatMessage" && pinFails) return reply("Bad Request: not enough rights to pin a message", false);
      if (method === "sendMessage" || method === "sendPhoto") return reply({ message_id: nextMessageId++, chat: { id: body.chat_id } });
      if (method === "getChatMember") return reply(members.get(`${body.chat_id}:${body.user_id}`) ?? { status: "member" });
      if (method === "createChatInviteLink") return reply({ invite_link: inviteOf(Number(body.chat_id)) });
      return reply(true);
    }),
  );
}
const sent = (method: string) => calls.filter((c) => c.method === method);
const groupMessages = () => sent("sendMessage").filter((c) => !c.body.ephemeral_message_parameters);

const user = (id: number, first_name: string, language_code = "en") => ({ id, first_name, username: `${first_name.toLowerCase()}_tg`, language_code });
const ADMIN_RIGHTS = { status: "administrator", can_pin_messages: true, can_invite_users: true };

describe("a seat by a word, and the crew's own Telegram group", () => {
  let db: Db;
  let updateId = 1;
  let messageId = 1;
  beforeAll(async () => {
    ({ db } = await createTestDb());
  });
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_WEBHOOK_SECRET = "hooksecret";
    process.env.TELEGRAM_BOT_USERNAME = "kicksmash_bot";
    stubTelegram();
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => undefined);

  const update = (u: Omit<TgUpdate, "update_id">) => handleTelegramUpdate(db, { update_id: updateId++, ...u }, NO_SIDE_EFFECTS);
  const say = (chat: TgMessage["chat"], from: ReturnType<typeof user>, text: string, o: { replyTo?: number; replyFrom?: typeof BOT | ReturnType<typeof user> } = {}) => {
    const id = messageId++;
    const message: TgMessage = { message_id: id, date: 0, chat, from, text, ...(o.replyTo ? { reply_to_message: { message_id: o.replyTo, date: 0, chat, from: o.replyFrom ?? BOT } } : {}) };
    return { id, outcome: update({ message }) };
  };
  const promote = (chat: TgMessage["chat"], member: Record<string, unknown>) => update({ my_chat_member: { chat, from: user(1, "Ana"), old_chat_member: { status: "member" }, new_chat_member: member as { status: string } } });
  const chatRow = async (chatId: number) => (await db.select().from(telegramChats).where(eq(telegramChats.chatId, chatId)))[0];
  const metric = async (key: string) => Number((await db.select().from(metricsDaily).where(eq(metricsDaily.key, key)))[0]?.value ?? 0);
  const reactions = () => sent("setMessageReaction").map((c) => ({ message: c.body.message_id, emoji: (c.body.reaction as { emoji: string }[])[0].emoji }));

  /** A match on Tuesday at 19:00 with its card in the chat; the organizer holds the first seat. */
  async function matchWithCard(chat: TgMessage["chat"], startsAt = TUESDAY_7PM, venueName = "Rawai Padel") {
    const org = await makePlayer(db, "Olga");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt, tz: "Asia/Bangkok", venueName, whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    await say(chat, user(1, "Ana"), `/match ${ev.code}`).outcome;
    const [card] = await db.select().from(telegramCards).where(and(eq(telegramCards.eventId, ev.id), eq(telegramCards.chatId, chat.id)));
    return { org, ev, card };
  }

  /** A crew group the bot reads: Ana (the group's creator and the crew's admin) taps the crew page's link, the bot is an admin who may pin. */
  async function listeningCrew(chatId: number) {
    const chat = { id: chatId, type: "supergroup" as const, title: "Thursday crew" };
    const owner = await makePlayer(db, "Ana");
    const crew = await createGroup(db, { name: "Thursday crew", creatorPlayerId: owner.id, tz: "Asia/Bangkok", venueName: "Rawai Padel" });
    members.set(`${chatId}:1`, { status: "creator" });
    members.set(`${chatId}:${BOT.id}`, ADMIN_RIGHTS);
    expect(await say(chat, user(1, "Ana"), `/start@kicksmash_bot ${crewStartPayload(crew.id, owner.id)}`).outcome).toBe("crew_listening");
    calls = [];
    return { chat, crew, owner };
  }

  it("a reply \"+1\" to a card in any group seats the sender, edits the card, reacts 👍 and sends no message", async () => {
    const chat = { id: -200100, type: "supergroup" as const, title: "Padel friends" };
    await update({ my_chat_member: { chat, from: user(1, "Ana"), old_chat_member: { status: "left" }, new_chat_member: { status: "member" } } });
    const { ev, card } = await matchWithCard(chat);
    calls = [];
    const r = say(chat, user(2, "Petr"), "+1 🙋", { replyTo: card.messageId });
    expect(await r.outcome).toBe("word_join:joined");
    expect(sent("sendMessage")).toHaveLength(0);
    expect(sent("editMessageText")).toHaveLength(1);
    expect(String(sent("editMessageText")[0].body.text)).toContain("Players 2/4");
    expect(reactions()).toEqual([{ message: r.id, emoji: "👍" }]);
    // Found or created as the ✅ button does it: by the Telegram account, with the first name.
    const [petr] = await db.select().from(players).where(eq(players.telegramId, 2));
    expect(petr.displayName).toBe("Petr");
    expect((await getEventByCode(db, ev.code))!.roster.some((s) => s.playerId === petr.id)).toBe(true);
    expect(await metric("tg_seat_by_word")).toBe(1);

    // Ordinary chat in reply to the card, and a reply to somebody else's message: nothing at all.
    calls = [];
    expect(await say(chat, user(3, "Sasha"), "I'm in traffic, 5 min", { replyTo: card.messageId }).outcome).toBe("ignored");
    expect(await say(chat, user(3, "Sasha"), "+1", { replyTo: 4242, replyFrom: user(2, "Petr") }).outcome).toBe("ignored");
    expect(calls).toHaveLength(0);

    // A seat a word took and gave back within ten minutes counts as a misread; a tap's does not.
    expect(await say(chat, user(2, "Petr"), "out", { replyTo: card.messageId }).outcome).toBe("word_leave:left");
    expect(reactions().at(-1)!.emoji).toBe("👌");
    expect(await metric("tg_seat_undone_10min")).toBe(1);
    const tap = (data: string, from: ReturnType<typeof user>) => update({ callback_query: { id: `cb${updateId}`, from, message: { message_id: card.messageId, date: 0, chat }, data } });
    expect(await tap(`j:${ev.code}`, user(4, "Dima"))).toBe("join:joined");
    expect(await tap(`l:${ev.code}`, user(4, "Dima"))).toBe("leave:left");
    expect(await metric("tg_seat_undone_10min")).toBe(1);
    expect(await metric("tg_seat_by_tap")).toBe(2);
  });

  it("a reply \"can't make it\" frees the seat, the waitlist moves up, and a word from nobody in it changes nothing", async () => {
    const chat = { id: -200200, type: "group" as const, title: "Tuesday" };
    const { ev, card } = await matchWithCard(chat);
    calls = [];
    expect(await say(chat, user(2, "Petr"), "me", { replyTo: card.messageId }).outcome).toBe("word_join:joined");
    for (const name of ["Bea", "Cal"]) await joinEvent(db, { eventId: ev.id, playerId: (await makePlayer(db, name)).id });
    const waiting = await makePlayer(db, "Dora");
    expect((await joinEvent(db, { eventId: ev.id, playerId: waiting.id })).outcome).toBe("waitlisted");
    await syncTelegram(db, ev.code); // the line-up is complete: the card and its one note
    calls = [];

    const r = say(chat, user(2, "Petr"), "Can’t make it, sorry 😔", { replyTo: card.messageId });
    expect(await r.outcome).toBe("word_leave:left");
    const after = (await getEventByCode(db, ev.code))!;
    expect(after.roster.filter((s) => s.position <= 4 && s.playerId).map((s) => s.player?.displayName).sort()).toEqual(["Bea", "Cal", "Dora", "Olga"]);
    expect(after.waitlist).toHaveLength(0);
    expect(reactions()).toEqual([{ message: r.id, emoji: "👌" }]);
    expect(sent("sendMessage")).toHaveLength(0);
    expect(sent("editMessageText")).toHaveLength(1);

    // Full now: a word that cannot take a seat goes to the waitlist and says so with 🤷, no message.
    const late = say(chat, user(7, "Zhenya"), "I'm in!", { replyTo: card.messageId });
    expect(await late.outcome).toBe("word_join:waitlisted");
    expect(reactions().at(-1)).toEqual({ message: late.id, emoji: "🤷" });
    // "Out" from somebody who was never in: no player row is made for it, and nothing changes.
    const stranger = say(chat, user(8, "Lev"), "не смогу", { replyTo: card.messageId });
    expect(await stranger.outcome).toBe("word_leave:not_in");
    expect(await db.select().from(players).where(eq(players.telegramId, 8))).toHaveLength(0);
    expect(sent("sendMessage")).toHaveLength(0);
  });

  it("a plain \"I'm in\" in a group that never opted in does nothing, even with the bot an admin there", async () => {
    const chat = { id: -200300, type: "supergroup" as const, title: "Not opted in" };
    await promote(chat, ADMIN_RIGHTS);
    const { ev } = await matchWithCard(chat);
    calls = [];
    expect(await say(chat, user(31, "Uma"), "I'm in").outcome).toBe("ignored");
    expect(await say(chat, user(31, "Uma"), "who's in Thursday 7pm Rawai?").outcome).toBe("ignored");
    expect(calls).toHaveLength(0);
    expect((await getEventByCode(db, ev.code))!.roster.filter((s) => s.playerId)).toHaveLength(1);
    expect(await db.select().from(players).where(eq(players.telegramId, 31))).toHaveLength(0);
  });

  it("the crew link ties the group to the right crew, refuses a forged or foreign one, and starts only with the notice pinned", async () => {
    const chat = { id: -200400, type: "supergroup" as const, title: "Crew chat" };
    const owner = await makePlayer(db, "Ana");
    const crew = await createGroup(db, { name: "Thursday crew", creatorPlayerId: owner.id, tz: "Asia/Bangkok", venueName: "Rawai Padel" });
    const other = await createGroup(db, { name: "Somebody else's crew", creatorPlayerId: owner.id, tz: "Asia/Bangkok" });

    // The link the crew page shows its admin: the bot, the payload, the two rights and nothing else.
    const link = crewGroupLink(crew.id, owner.id)!;
    expect(link).toBe(`https://t.me/kicksmash_bot?startgroup=${crewStartPayload(crew.id, owner.id)}&admin=invite_users+pin_messages`);
    expect(CREW_ADMIN_RIGHTS).toEqual(["invite_users", "pin_messages"]);
    expect(crewStartPayload(crew.id, owner.id).length).toBeLessThanOrEqual(64);
    expect(crewStartPayload(crew.id, owner.id)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(crewPayloadGroup(crewStartPayload(crew.id, owner.id))).toBe(crew.id);
    expect(verifyCrewPayload(crewStartPayload(crew.id, owner.id), owner.id)).toBe(true);
    // Two days later the link is dead.
    expect(verifyCrewPayload(crewStartPayload(crew.id, owner.id, new Date(NOW.getTime() - 3 * 24 * 3600 * 1000)), owner.id)).toBe(false);

    // A payload whose crew was swapped for another keeps a signature that no longer fits: refused.
    const forged = crewStartPayload(crew.id, owner.id).replace(crew.id.replace(/-/g, ""), other.id.replace(/-/g, ""));
    expect(crewPayloadGroup(forged)).toBe(other.id);
    expect(verifyCrewPayload(forged, owner.id)).toBe(false);
    members.set(`${chat.id}:1`, { status: "creator" });
    members.set(`${chat.id}:2`, { status: "member" });
    members.set(`${chat.id}:${BOT.id}`, { status: "member" });
    expect(await say(chat, user(1, "Ana"), `/start@kicksmash_bot ${forged}`).outcome).toBe("crew_link_bad");
    expect(String(groupMessages().at(-1)!.body.text)).toContain("too old");
    let row = await chatRow(chat.id);
    expect([row.groupId, row.noticeVersion, row.listeningSince]).toEqual([null, null, null]);

    // A member who is not an admin of the group cannot give the group's consent.
    expect(await say(chat, user(2, "Petr"), `/start@kicksmash_bot ${crewStartPayload(crew.id, owner.id)}`).outcome).toBe("crew_not_admin");
    expect((await chatRow(chat.id)).groupId).toBeNull();

    // The group's creator, while the bot is still a plain member: tied and opted in, not reading.
    calls = [];
    expect(await say(chat, user(1, "Ana"), `/start@kicksmash_bot ${crewStartPayload(crew.id, owner.id)}`).outcome).toBe("crew_needs_admin");
    row = await chatRow(chat.id);
    expect([row.groupId, row.noticeVersion, row.listeningSince, row.tz, row.venueName]).toEqual([crew.id, CREW_NOTICE_VERSION, null, "Asia/Bangkok", "Rawai Padel"]);
    expect(sent("pinChatMessage")).toHaveLength(0);

    // Promoted without the right to pin: no notice, nothing read.
    calls = [];
    expect(await promote(chat, { ...ADMIN_RIGHTS, can_pin_messages: false })).toBe("rejoined");
    expect(sent("sendMessage")).toHaveLength(0);
    expect((await chatRow(chat.id)).listeningSince).toBeNull();
    // The right on paper, but Telegram refuses the pin: a notice nobody pinned is not consent, so still
    // nothing read, and the notice that went out unpinned comes down again rather than linger in the chat.
    pinFails = true;
    calls = [];
    expect(await promote(chat, ADMIN_RIGHTS)).toBe("rejoined");
    expect((await chatRow(chat.id)).listeningSince).toBeNull();
    expect(sent("sendMessage")).toHaveLength(1);
    expect(sent("deleteMessage").map((c) => c.body.message_id)).toEqual([nextMessageId - 1]);
    pinFails = false;

    // The promotion that may pin starts it: the notice is sent and pinned, an invite link is made, and
    // nothing of the group's own (its description) is touched.
    calls = [];
    expect(await promote(chat, ADMIN_RIGHTS)).toBe("crew_listening");
    row = await chatRow(chat.id);
    const notice = groupMessages().find((c) => String(c.body.text).includes("Kicksmash runs matches here"))!;
    expect(notice).toBeDefined();
    expect(String(notice.body.text)).toContain(strings("en").crewNotice);
    expect(sent("pinChatMessage").map((c) => c.body.message_id)).toEqual([row.noticeMessageId]);
    expect(sent("setChatDescription")).toHaveLength(0);
    expect(sent("createChatInviteLink")).toHaveLength(1);
    expect(row.listeningSince?.toISOString()).toBe(NOW.toISOString());
    expect(row.inviteLink).toBe(inviteOf(chat.id));
    expect(await crewTelegramInvite(db, crew.id)).toEqual({ invite: inviteOf(chat.id), listening: true });
    expect(await crewTelegramInvite(db, other.id)).toEqual({ invite: null, listening: false });
    expect(await metric("tg_groups_started")).toBe(1);

    // The other order: promoted first, then the link. The crew link adds the bot as an admin that may
    // pin, and then the notice says what the welcome would: one message from the bot, one pin.
    const chat2 = { id: -200401, type: "supergroup" as const, title: "Crew chat 2" };
    members.set(`${chat2.id}:1`, { status: "administrator" });
    members.set(`${chat2.id}:${BOT.id}`, ADMIN_RIGHTS);
    calls = [];
    expect(await update({ my_chat_member: { chat: chat2, from: user(1, "Ana"), old_chat_member: { status: "left" }, new_chat_member: ADMIN_RIGHTS } })).toBe("joined");
    expect(sent("sendMessage")).toHaveLength(0);
    expect(await say(chat2, user(1, "Ana"), `/start@kicksmash_bot ${crewStartPayload(crew.id, owner.id)}`).outcome).toBe("crew_listening");
    expect(sent("sendMessage")).toHaveLength(1);
    expect(sent("pinChatMessage")).toHaveLength(1);
    expect((await chatRow(chat2.id)).groupId).toBe(crew.id);
    // Telegram's own promotion update arriving after the link changes nothing.
    expect(await promote(chat2, ADMIN_RIGHTS)).toBe("rejoined");
    expect(sent("pinChatMessage")).toHaveLength(1);
    // Two groups now read for the crew: the first one tied stays the crew's group on its page, whether
    // it started reading before the second or, after a demotion and a promotion, again after it.
    const startedAt = async (id: number, at: Date) => db.update(telegramChats).set({ listeningSince: at }).where(eq(telegramChats.chatId, id));
    await startedAt(chat.id, new Date(NOW.getTime() - 3600_000));
    expect(await crewTelegramInvite(db, crew.id)).toEqual({ invite: inviteOf(chat.id), listening: true });
    await startedAt(chat.id, new Date(NOW.getTime() + 3600_000));
    expect(await crewTelegramInvite(db, crew.id)).toEqual({ invite: inviteOf(chat.id), listening: true });
    // A plain member added as an admin by hand still gets the welcome.
    const chat3 = { id: -200402, type: "group" as const, title: "Friends" };
    calls = [];
    expect(await update({ my_chat_member: { chat: chat3, from: user(1, "Ana"), old_chat_member: { status: "left" }, new_chat_member: { status: "member" } } })).toBe("welcome");
    expect(sent("sendMessage")).toHaveLength(1);
  });

  it("in a crew's group a plain \"I'm in\" takes the one open match; with two open it asks that person alone", async () => {
    const { chat } = await listeningCrew(-200500);
    const { ev } = await matchWithCard(chat);
    calls = [];
    const r = say(chat, user(2, "Petr"), "I'M IN 🎾");
    expect(await r.outcome).toBe("word_join:joined");
    expect(reactions()).toEqual([{ message: r.id, emoji: "👍" }]);
    expect(sent("sendMessage")).toHaveLength(0);
    expect(String(sent("editMessageText")[0].body.text)).toContain("Players 2/4");
    // Ordinary chat stays unread.
    calls = [];
    expect(await say(chat, user(3, "Sasha"), "in the car, 5 min").outcome).toBe("ignored");
    expect(await say(chat, user(3, "Sasha"), "great game yesterday").outcome).toBe("ignored");
    expect(calls).toHaveLength(0);

    // A second open match: "in" is a question now, asked of Sasha alone, with the card's own taps.
    const second = await matchWithCard(chat, WEDNESDAY_7PM, "Kata Padel");
    calls = [];
    expect(await say(chat, user(3, "Sasha"), "+1").outcome).toBe("word_join:asked");
    expect(groupMessages()).toHaveLength(0);
    const asked = sent("sendMessage");
    expect(asked).toHaveLength(1);
    expect(asked[0].body.ephemeral_message_parameters).toEqual({ receiver_user_id: 3 });
    const buttons = (asked[0].body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.map((row) => row[0].callback_data);
    expect(buttons).toEqual([`j:${ev.code}`, `j:${second.ev.code}`]);
    expect(reactions()).toEqual([]);
    expect(await metric("tg_word_unsure")).toBe(1);

    // When Telegram will not deliver the question, the group still hears nothing.
    ephemeralFails = true;
    calls = [];
    expect(await say(chat, user(3, "Sasha"), "+1").outcome).toBe("word_join:unasked");
    expect(groupMessages()).toHaveLength(0);
    expect(reactions()).toEqual([]);
    ephemeralFails = false;

    // "Out" with two open means the one Petr is in: no question needed.
    calls = [];
    expect(await say(chat, user(2, "Petr"), "can't make it").outcome).toBe("word_leave:left");
    expect(sent("sendMessage")).toHaveLength(0);
    expect((await getEventByCode(db, ev.code))!.roster.filter((s) => s.playerId)).toHaveLength(1);
  });

  it("\"who's in Thursday 7pm Rawai?\" makes the match and posts its one card as the reply; the same question again makes nothing", async () => {
    const { chat, crew } = await listeningCrew(-200600);
    const ask = say(chat, user(5, "Mika"), "who's in Thursday 7pm Rawai?");
    const outcome = await ask.outcome;
    expect(outcome).toMatch(/^word_ask:created:/);
    const posted = sent("sendMessage");
    expect(posted).toHaveLength(1);
    expect(posted[0].body.reply_parameters).toMatchObject({ message_id: ask.id });
    expect(String(posted[0].body.text)).toContain("Players 1/4");
    const made = (await getEventByCode(db, outcome.split(":")[2]))!;
    expect(made.event.startsAt.toISOString()).toBe(THURSDAY_7PM.toISOString());
    expect(made.event.groupId).toBe(crew.id);
    // "Rawai" is the crew's usual court, which the chat learned from the crew: the known name wins over the typed word.
    expect(made.event.venueName).toBe("Rawai Padel");
    expect(made.roster.find((s) => s.playerId)?.player?.displayName).toBe("Mika");
    expect(await metric("tg_match_by_word")).toBe(1);

    calls = [];
    expect(await say(chat, user(6, "Nora"), "Who’s in Thursday 19:00?").outcome).toBe("word_ask:exists");
    expect(await say(chat, user(6, "Nora"), "who's in?").outcome).toBe("ignored");
    expect(calls).toHaveLength(0);
    expect(await db.select().from(events).where(eq(events.groupId, crew.id))).toHaveLength(1);
  });

  it("/quiet from a group admin, a lost admin right and the bot's removal each stop the reading", async () => {
    const { chat, crew, owner } = await listeningCrew(-200700);
    await matchWithCard(chat);
    const noticeId = (await chatRow(chat.id)).noticeMessageId;
    calls = [];

    // A member who is not an admin cannot switch the group off: a shrug, nothing else.
    members.set(`${chat.id}:9`, { status: "member" });
    const nope = say(chat, user(9, "Ivo"), "/quiet");
    expect(await nope.outcome).toBe("quiet_not_admin");
    expect(reactions()).toEqual([{ message: nope.id, emoji: "🤷" }]);
    expect((await chatRow(chat.id)).listeningSince).not.toBeNull();

    // The hourly count of groups the bot reads drops by this one with /quiet.
    const managed = async () => {
      await snapshotMetrics(db);
      return metric("tg_groups_managed");
    };
    const reading = await managed();
    expect(reading).toBeGreaterThan(0);
    calls = [];
    const quiet = say(chat, user(1, "Ana"), "/quiet@kicksmash_bot");
    expect(await quiet.outcome).toBe("quiet");
    expect(await managed()).toBe(reading - 1);
    let row = await chatRow(chat.id);
    expect([row.listeningSince, row.noticeVersion, row.noticeMessageId]).toEqual([null, null, null]);
    expect(sent("unpinChatMessage").map((c) => c.body.message_id)).toEqual([noticeId]);
    expect(sent("unpinAllChatMessages")).toHaveLength(0);
    // The group's own description is the group's: the bot never writes or clears it.
    expect(sent("setChatDescription")).toHaveLength(0);
    expect(reactions()).toEqual([{ message: quiet.id, emoji: "👌" }]);
    expect(groupMessages()).toHaveLength(0);
    // The group is still the crew's, so its members keep the way in, and the crew's admin may start it again.
    expect(await crewTelegramInvite(db, crew.id)).toEqual({ invite: inviteOf(chat.id), listening: false });
    calls = [];
    expect(await say(chat, user(2, "Petr"), "I'm in").outcome).toBe("ignored");
    expect(calls).toHaveLength(0);
    // A promotion after /quiet does not start it again: the opt-in went with it.
    expect(await promote(chat, ADMIN_RIGHTS)).toBe("rejoined");
    expect((await chatRow(chat.id)).listeningSince).toBeNull();

    // The crew link again (a new opt-in, so a new notice), then the bot is demoted: it stops at once and keeps the opt-in.
    expect(await say(chat, user(1, "Ana"), `/start ${crewStartPayload(crew.id, owner.id)}`).outcome).toBe("crew_listening");
    const repinned = (await chatRow(chat.id)).noticeMessageId;
    expect(await promote(chat, { status: "member" })).toBe("crew_quiet:demoted");
    row = await chatRow(chat.id);
    expect([row.listeningSince, row.noticeVersion]).toEqual([null, CREW_NOTICE_VERSION]);
    calls = [];
    expect(await say(chat, user(2, "Petr"), "I'm in").outcome).toBe("ignored");
    expect(calls).toHaveLength(0);
    // Promoted again by a group admin: back, with the notice already in the group pinned again. Restricted
    // is not an admin either. The whole cycle posts nothing new into the group.
    calls = [];
    expect(await promote(chat, ADMIN_RIGHTS)).toBe("crew_listening");
    expect(await promote(chat, { status: "restricted" })).toBe("ignored");
    expect((await chatRow(chat.id)).listeningSince).toBeNull();
    expect(await promote(chat, ADMIN_RIGHTS)).toBe("crew_listening");
    expect(sent("sendMessage")).toHaveLength(0);
    expect(sent("pinChatMessage").map((c) => c.body.message_id)).toEqual([repinned, repinned]);
    expect((await chatRow(chat.id)).noticeMessageId).toBe(repinned);

    // Removed: nothing read, no opt-in, and the crew page stops offering the way in.
    expect(await update({ my_chat_member: { chat, from: user(1, "Ana"), old_chat_member: { status: "administrator" }, new_chat_member: { status: "kicked" } } })).toBe("left");
    row = await chatRow(chat.id);
    expect([row.listeningSince, row.noticeVersion, row.inviteLink]).toEqual([null, null, null]);
    expect(await crewTelegramInvite(db, crew.id)).toEqual({ invite: null, listening: false });
  });

  it("\"I'm in\" in reply to a /new prompt is not the place of a new match", async () => {
    const chat = { id: -200900, type: "group" as const, title: "Prompted" };
    expect(await say(chat, user(1, "Ana"), "/tz phuket").outcome).toBe("tz");
    const prompt = { message_id: 7777, date: 0, chat, from: BOT, text: "📅 Thu 15 Oct · 19:00\nWhere?\nAnother place: reply to this message with its name.\n/new 15.10 19:00" };
    const before = (await db.select().from(events)).length;
    calls = [];
    expect(await update({ message: { message_id: messageId++, date: 0, chat, from: user(2, "Petr"), text: "I'm in", reply_to_message: prompt } })).toBe("ignored");
    expect((await db.select().from(events)).length).toBe(before);
    expect(calls).toHaveLength(0);
    // The place it asked for still makes the match.
    expect(await update({ message: { message_id: messageId++, date: 0, chat, from: user(2, "Petr"), text: "Kata", reply_to_message: prompt } })).toMatch(/^new_created:/);
  });

  it("ordinary chat that starts like a question never becomes a match; a question takes the day, the hour and the court, nothing else", async () => {
    const { chat, crew } = await listeningCrew(-201000);
    const lines: [string, string][] = [
      // Not about padel: what is left over names no court the chat knows.
      ["who's in for beers at 8?", "no_place"],
      ["anyone for fifa at 9pm tonight?", "no_place"],
      ["who wants to play fifa at 10?", "no_place"],
      ["anyone up for dinner at 7pm?", "no_place"],
      ["кто хочет на ужин в 20:00?", "no_place"],
      ["¿quién viene a cenar a las 21?", "no_place"],
      // A number in ordinary talk is not an hour.
      ["who wants to play this weekend, 8 of us?", "no_time"],
      ["anyone for 18 holes tomorrow?", "no_time"],
      ["who's in Thursday 19 Rawai?", "no_time"],
      // A day the parser cannot place, or a tournament: not a question's to guess.
      ["who's in on the 15th at 7pm?", "unclear"],
      ["who's in Thursday next week 7pm?", "unclear"],
      ["who's in americano Sunday 10:00?", "unclear"],
      // A court nobody here has played yet goes through /new; a city is not a court.
      ["who's in Thursday 7pm Bangtao?", "no_place"],
      ["who's in Thursday 7pm Phuket?", "no_place"],
    ];
    const unsureBefore = await metric("tg_word_unsure");
    for (const [line, why] of lines) expect(await say(chat, user(51, "Lena"), line).outcome, line).toBe(`word_ask:${why}`);
    expect(sent("sendMessage")).toHaveLength(0);
    expect(await db.select().from(events).where(eq(events.groupId, crew.id))).toHaveLength(0);
    expect((await metric("tg_word_unsure")) - unsureBefore).toBe(lines.length);
    expect(await db.select().from(players).where(eq(players.telegramId, 51))).toHaveLength(0);

    // A question with a time and the crew's usual court makes the match, and only the day, the hour and
    // the court come from the chat line: never a listing, a price, a level or a size.
    const made = await say(chat, user(51, "Lena"), "who's in Thursday 7pm public 400฿ level 3-4?").outcome;
    expect(made).toMatch(/^word_ask:created:/);
    const ev = (await getEventByCode(db, made.split(":")[2]))!.event;
    expect([ev.startsAt.toISOString(), ev.venueName, ev.publicListing, ev.cost, ev.levelMin, ev.levelMax, ev.capacity, ev.type]).toEqual([THURSDAY_7PM.toISOString(), "Rawai Padel", false, null, null, null, 4, "match"]);
  });

  it("a question about a card already there makes nothing: twelve hours on, any day when none was typed, and a match still being carded", async () => {
    const { chat, crew } = await listeningCrew(-201100);
    const { org } = await matchWithCard(chat); // Tuesday 19:00
    // Wednesday 19:00 exists for the crew, its card not yet in this chat.
    await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: WEDNESDAY_7PM, tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist", groupId: crew.id });
    const before = (await db.select().from(events)).length;
    calls = [];
    for (const line of ["who's in Tuesday at 7?", "who's in at 7?", "who's in 7:00 Tuesday?", "who's in Wednesday 7pm?"]) expect(await say(chat, user(6, "Nora"), line).outcome, line).toBe("word_ask:exists");
    expect(sent("sendMessage")).toHaveLength(0);
    expect((await db.select().from(events)).length).toBe(before);
  });

  it("forwards, a channel's post, words that answer any question and questions take no seat", async () => {
    const { chat } = await listeningCrew(-201200);
    const { ev } = await matchWithCard(chat);
    calls = [];
    const plain = (text: string, extra: Partial<TgMessage> = {}, from: TgMessage["from"] = user(42, "Pia")) => update({ message: { message_id: messageId++, date: 0, chat, from, text, ...extra } });
    expect(await plain("I'm in", { forward_origin: { type: "user" }, forward_date: 1 })).toBe("ignored");
    expect(await plain("I'm in", { is_automatic_forward: true, sender_chat: { id: -100777, type: "channel", title: "News" } }, { id: 777000, first_name: "Telegram" })).toBe("ignored");
    for (const word of ["me", "Me!", "+", "я", "буду", "voy", "in?", "+1?", "я в деле?"]) expect(await plain(word), word).toBe("ignored");
    expect(calls).toHaveLength(0);
    expect((await getEventByCode(db, ev.code))!.roster.filter((x) => x.playerId)).toHaveLength(1);
    expect(await db.select().from(players).where(eq(players.telegramId, 42))).toHaveLength(0);
  });

  it("a word that cannot take the seat outright tells that person alone why, as the button would", async () => {
    const { chat } = await listeningCrew(-201300);
    const org = await makePlayer(db, "Olga");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: TUESDAY_7PM, tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist", levelMin: 3, levelMax: 4 });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    await say(chat, user(1, "Ana"), `/match ${ev.code}`).outcome;
    calls = [];
    const r = say(chat, user(2, "Petr"), "I'm in");
    expect(await r.outcome).toBe("word_join:error:level_required");
    expect(reactions()).toEqual([{ message: r.id, emoji: "🤷" }]);
    expect(groupMessages()).toHaveLength(0);
    const told = sent("sendMessage");
    expect(told.map((c) => [c.body.ephemeral_message_parameters, c.body.text])).toEqual([[{ receiver_user_id: 2 }, strings("en").toastLevel]]);
  });

  it("an anonymous admin, who posts as the group, may tie it to the crew and quiet it; nothing else from them is read", async () => {
    const chat = { id: -201400, type: "supergroup" as const, title: "Anonymous crew" };
    const owner = await makePlayer(db, "Ana");
    const crew = await createGroup(db, { name: "Anon crew", creatorPlayerId: owner.id, tz: "Asia/Bangkok", venueName: "Rawai Padel" });
    members.set(`${chat.id}:${BOT.id}`, ADMIN_RIGHTS);
    const anon = (text: string) => update({ message: { message_id: messageId++, date: 0, chat, from: { id: 1087968824, is_bot: true, first_name: "Group" }, sender_chat: chat, text } });
    expect(await anon(`/start@kicksmash_bot ${crewStartPayload(crew.id, owner.id)}`)).toBe("crew_listening");
    // The anonymous admin's account is never asked whether it is an admin: it posts as the group.
    expect(sent("getChatMember").map((c) => c.body.user_id)).toEqual([BOT.id]);
    expect(await anon("I'm in")).toBe("ignored");
    expect(await anon("/quiet")).toBe("quiet");
    expect((await chatRow(chat.id)).listeningSince).toBeNull();
  });

  it("the crew link is a crew admin's, and dies when they stop being one", async () => {
    const chat = { id: -201500, type: "supergroup" as const, title: "Handed over" };
    const owner = await makePlayer(db, "Ana");
    const bea = await makePlayer(db, "Bea");
    const crew = await createGroup(db, { name: "Handover crew", creatorPlayerId: owner.id, tz: "Asia/Bangkok" });
    await joinGroup(db, crew.id, bea.id, "self");
    members.set(`${chat.id}:1`, { status: "creator" });
    members.set(`${chat.id}:${BOT.id}`, ADMIN_RIGHTS);
    // A member of the crew is no admin of it: a link signed for her ties nothing.
    expect(await say(chat, user(1, "Ana"), `/start ${crewStartPayload(crew.id, bea.id)}`).outcome).toBe("crew_link_bad");
    const ownersLink = crewStartPayload(crew.id, owner.id);
    await handOverGroup(db, crew.id, owner.id, bea.id);
    // Ana handed the crew to Bea: the link she copied before is dead, Bea's works.
    expect(await say(chat, user(1, "Ana"), `/start ${ownersLink}`).outcome).toBe("crew_link_bad");
    expect((await chatRow(chat.id)).groupId).toBeNull();
    expect(await say(chat, user(1, "Ana"), `/start ${crewStartPayload(crew.id, bea.id)}`).outcome).toBe("crew_listening");
  });

  it("the crew page offers the way in to every member, and the link that makes a group to the crew's admins only, while no group is read", () => {
    const quiet = { invite: inviteOf(-1), listening: false };
    const reading = { invite: inviteOf(-1), listening: true };
    expect(crewTelegramDoors("member", quiet)).toEqual({ join: inviteOf(-1), run: false });
    expect(crewTelegramDoors("admin", quiet)).toEqual({ join: inviteOf(-1), run: true });
    expect(crewTelegramDoors("admin", reading)).toEqual({ join: inviteOf(-1), run: false });
    expect(crewTelegramDoors("admin", { invite: null, listening: false })).toEqual({ join: null, run: true });
    expect(crewTelegramDoors(null, quiet)).toEqual({ join: null, run: false });
    expect(crewTelegramDoors("admin", null)).toEqual({ join: null, run: false });
  });

  it("two updates at once start the group once: one notice, one pin", async () => {
    const chat = { id: -201600, type: "supergroup" as const, title: "Racing" };
    const owner = await makePlayer(db, "Ana");
    const crew = await createGroup(db, { name: "Racing crew", creatorPlayerId: owner.id, tz: "Asia/Bangkok" });
    members.set(`${chat.id}:1`, { status: "creator" });
    expect(await say(chat, user(1, "Ana"), `/start ${crewStartPayload(crew.id, owner.id)}`).outcome).toBe("crew_needs_admin");
    calls = [];
    const outcomes = await Promise.all([promote(chat, ADMIN_RIGHTS), promote(chat, ADMIN_RIGHTS)]);
    expect(outcomes.sort()).toEqual(["crew_listening", "rejoined"]);
    expect(sent("sendMessage")).toHaveLength(1);
    expect(sent("pinChatMessage")).toHaveLength(1);
    expect((await chatRow(chat.id)).listeningSince).not.toBeNull();
  });

  it("an ordinary line in a group the bot reads costs no database read at all", async () => {
    const { chat } = await listeningCrew(-201700);
    await matchWithCard(chat);
    let reads = 0;
    const DB_CALLS = new Set(["select", "selectDistinct", "selectDistinctOn", "insert", "update", "delete", "execute", "transaction", "query", "with", "$count", "batch"]);
    const counted = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop === "string" && DB_CALLS.has(prop)) reads++;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;
    const line = (text: string) => handleTelegramUpdate(counted, { update_id: updateId++, message: { message_id: messageId++, date: 0, chat, from: user(3, "Sasha"), text } }, NO_SIDE_EFFECTS);
    for (const text of ["great game yesterday", "in the car, 5 min", "who's in?", "me", "🎾"]) expect(await line(text), text).toBe("ignored");
    expect(await handleTelegramUpdate(counted, { update_id: updateId++, message: { message_id: messageId++, date: 0, chat, from: user(3, "Sasha"), photo: [{ file_id: "x" }] } }, NO_SIDE_EFFECTS)).toBe("ignored");
    // In a forum topic every message "answers" the topic's first message: still chatter, still no read.
    const topic = { message_id: 77, date: 0, chat, from: user(1, "Ana"), text: "Padel" };
    expect(await handleTelegramUpdate(counted, { update_id: updateId++, message: { message_id: messageId++, date: 0, chat, from: user(3, "Sasha"), text: "great game", message_thread_id: 77, reply_to_message: topic } }, NO_SIDE_EFFECTS)).toBe("ignored");
    expect(reads).toBe(0);
    // A word the bot acts on does read: the counter counts.
    expect(await line("I'm in")).toBe("word_join:joined");
    expect(reads).toBeGreaterThan(0);
  });

  it("a basic group that becomes a supergroup takes its crew, its opt-in and its invite link along", async () => {
    const chat = { id: -201800, type: "group" as const, title: "Basic crew" };
    const owner = await makePlayer(db, "Ana");
    const crew = await createGroup(db, { name: "Basic crew", creatorPlayerId: owner.id, tz: "Asia/Bangkok", venueName: "Rawai Padel" });
    members.set(`${chat.id}:1`, { status: "creator" });
    members.set(`${chat.id}:${BOT.id}`, ADMIN_RIGHTS);
    expect(await say(chat, user(1, "Ana"), `/start ${crewStartPayload(crew.id, owner.id)}`).outcome).toBe("crew_listening");
    const superId = -1001201800;
    expect(await update({ message: { message_id: messageId++, date: 0, chat, from: user(1, "Ana"), migrate_to_chat_id: superId } })).toBe("migrated");
    const old = await chatRow(chat.id);
    expect([old.leftAt != null, old.listeningSince, old.noticeVersion, old.inviteLink]).toEqual([true, null, null, null]);
    const moved = await chatRow(superId);
    expect([moved.type, moved.groupId, moved.noticeVersion, moved.inviteLink, moved.listeningSince, moved.venueName]).toEqual(["supergroup", crew.id, CREW_NOTICE_VERSION, inviteOf(chat.id), null, "Rawai Padel"]);
    expect(await crewTelegramInvite(db, crew.id)).toEqual({ invite: inviteOf(chat.id), listening: false });
    // Telegram reports the bot an admin in the supergroup: it starts there with a fresh notice.
    const supergroup = { id: superId, type: "supergroup" as const, title: "Basic crew" };
    calls = [];
    expect(await promote(supergroup, ADMIN_RIGHTS)).toBe("crew_listening");
    expect(sent("sendMessage")).toHaveLength(1);
  });

  it("no message text is kept anywhere: every table is searched for the words people typed", async () => {
    const MARK = "zqxwvmark";
    const { chat, crew } = await listeningCrew(-200800);
    const { card } = await matchWithCard(chat);
    const noticeId = (await chatRow(chat.id)).noticeMessageId!;
    // Petr told us something here once: a reply to the bot from him would join that note anywhere else.
    await db.insert(feedback).values({ source: "telegram", text: "bigger buttons please", telegramChatId: chat.id, telegramUserId: 2, locale: "en" });
    const crewEvents = async () => (await db.select().from(events).where(eq(events.groupId, crew.id))).length;
    for (const [text, replyTo] of [
      [`${MARK} see you all on court`, undefined],
      [`I'm in ${MARK}`, undefined],
      [`${MARK} what a game`, card.messageId],
      [`${MARK} thanks for the reminder`, noticeId],
      [`who's in ${MARK}?`, undefined],
      // A question with a time whose leftover is the text: no match, and so nothing to keep.
      [`who's in ${MARK} at 7?`, undefined],
      [`anyone for ${MARK} at 9`, undefined],
      [`who's in Thursday 7pm ${MARK}`, undefined],
      [`who's in Thursday 7pm ${MARK}?`, undefined],
    ] as const) {
      await say(chat, user(2, "Petr"), text, { replyTo }).outcome;
    }
    expect(await crewEvents()).toBe(0);
    // A real question with chatter after its "?": the match is made from the question alone.
    expect(await say(chat, user(2, "Petr"), `who's in Wednesday 8pm? ${MARK} bring balls`).outcome).toMatch(/^word_ask:created:/);
    expect(await crewEvents()).toBe(1);
    await say(chat, user(2, "Petr"), "+1").outcome;
    const tables = (await db.execute(sql`select tablename from pg_tables where schemaname = 'public'`)) as unknown as { rows?: { tablename: string }[] } & { tablename: string }[];
    const names = (tables.rows ?? tables).map((t) => t.tablename);
    expect(names.length).toBeGreaterThan(30);
    const holding: string[] = [];
    for (const name of names) {
      const r = (await db.execute(sql`select count(*)::int as n from ${sql.identifier(name)} x where x::text like ${`%${MARK}%`}`)) as unknown as { rows?: { n: number }[] } & { n: number }[];
      if (Number((r.rows ?? r)[0]?.n ?? 0) > 0) holding.push(name);
    }
    expect(holding).toEqual([]);
    expect((await db.select().from(feedback).where(eq(feedback.telegramUserId, 2)))[0].text).toBe("bigger buttons please");
  });
});
