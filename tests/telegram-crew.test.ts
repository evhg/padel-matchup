import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, feedback, metricsDaily, players, telegramCards, telegramChats } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { createEvent } from "@/lib/domain/events";
import { createGroup, crewTelegramInvite } from "@/lib/domain/groups";
import { getEventByCode } from "@/lib/domain/queries";
import { joinEvent } from "@/lib/domain/slots";
import { handleTelegramUpdate, syncTelegram } from "@/lib/telegram/bot";
import { CREW_ADMIN_RIGHTS, crewGroupLink, crewStartPayload, readCrewPayload } from "@/lib/telegram/deepLinks";
import { CREW_NOTICE_VERSION } from "@/lib/telegram/handlers/crew";
import { strings } from "@/lib/telegram/card";
import type { TgMessage, TgUpdate } from "@/lib/telegram/api";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer } from "./helpers/db";

/**
 * A seat by a word, and a crew's own Telegram group run by the bot as an admin (DECIDING rule 30).
 *
 * Every Bot API call is stubbed: the stub answers getChatMember from `members`, makes an invite link,
 * and refuses an ephemeral message when `ephemeralFails` is set. What the bot sends, edits, pins and
 * reacts is read back from `calls`; what it keeps is read back from the tables.
 */

// Saturday 10 October 2026, noon in Bangkok. Matches below are on Tuesday the 13th; Thursday is the 15th.
const NOW = new Date("2026-10-10T05:00:00Z");
freezeClock(NOW);
const TUESDAY_7PM = new Date("2026-10-13T12:00:00Z");
const WEDNESDAY_7PM = new Date("2026-10-14T12:00:00Z");
const THURSDAY_7PM = new Date("2026-10-15T12:00:00Z");

const TOKEN = "123456:TESTTOKEN";
const BOT = { id: 123456, is_bot: true, first_name: "Kicksmash" };
const INVITE = "https://t.me/+crewInviteLink";

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
      if (method === "createChatInviteLink") return reply({ invite_link: INVITE });
      return reply(true);
    }),
  );
}
const sent = (method: string) => calls.filter((c) => c.method === method);
const groupMessages = () => sent("sendMessage").filter((c) => !c.body.ephemeral_message_parameters);

const user = (id: number, first_name: string, language_code = "en") => ({ id, first_name, username: `${first_name.toLowerCase()}_tg`, language_code });
const ADMIN_RIGHTS = { status: "administrator", can_pin_messages: true, can_change_info: true, can_invite_users: true };

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

  /** A crew group the bot reads: Ana (the group's creator) taps the crew page's link, the bot is an admin who may pin. */
  async function listeningCrew(chatId: number) {
    const chat = { id: chatId, type: "supergroup" as const, title: "Thursday crew" };
    const owner = await makePlayer(db, "Ana");
    const crew = await createGroup(db, { name: "Thursday crew", creatorPlayerId: owner.id, tz: "Asia/Bangkok", venueName: "Rawai Padel" });
    members.set(`${chatId}:1`, { status: "creator" });
    members.set(`${chatId}:${BOT.id}`, ADMIN_RIGHTS);
    expect(await say(chat, user(1, "Ana"), `/start@kicksmash_bot ${crewStartPayload(crew.id)}`).outcome).toBe("crew_listening");
    calls = [];
    return { chat, crew };
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

    // The link the crew page shows: the bot, the payload, the three rights and nothing else.
    const link = crewGroupLink(crew.id)!;
    expect(link).toBe(`https://t.me/kicksmash_bot?startgroup=${crewStartPayload(crew.id)}&admin=change_info+invite_users+pin_messages`);
    expect(CREW_ADMIN_RIGHTS).toEqual(["change_info", "invite_users", "pin_messages"]);
    expect(crewStartPayload(crew.id).length).toBeLessThanOrEqual(64);
    expect(crewStartPayload(crew.id)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(readCrewPayload(crewStartPayload(crew.id))).toBe(crew.id);
    // Two days later the link is dead.
    expect(readCrewPayload(crewStartPayload(crew.id, new Date(NOW.getTime() - 3 * 24 * 3600 * 1000)))).toBeNull();

    // A payload whose crew was swapped for another keeps a signature that no longer fits: refused.
    const forged = crewStartPayload(crew.id).replace(crew.id.replace(/-/g, ""), other.id.replace(/-/g, ""));
    expect(readCrewPayload(forged)).toBeNull();
    members.set(`${chat.id}:1`, { status: "creator" });
    members.set(`${chat.id}:2`, { status: "member" });
    members.set(`${chat.id}:${BOT.id}`, { status: "member" });
    expect(await say(chat, user(1, "Ana"), `/start@kicksmash_bot ${forged}`).outcome).toBe("crew_link_bad");
    expect(String(groupMessages().at(-1)!.body.text)).toContain("too old");
    let row = await chatRow(chat.id);
    expect([row.groupId, row.noticeVersion, row.listeningSince]).toEqual([null, null, null]);

    // A member who is not an admin of the group cannot give the group's consent.
    expect(await say(chat, user(2, "Petr"), `/start@kicksmash_bot ${crewStartPayload(crew.id)}`).outcome).toBe("crew_not_admin");
    expect((await chatRow(chat.id)).groupId).toBeNull();

    // The group's creator, while the bot is still a plain member: tied and opted in, not reading.
    calls = [];
    expect(await say(chat, user(1, "Ana"), `/start@kicksmash_bot ${crewStartPayload(crew.id)}`).outcome).toBe("crew_needs_admin");
    row = await chatRow(chat.id);
    expect([row.groupId, row.noticeVersion, row.listeningSince, row.tz, row.venueName]).toEqual([crew.id, CREW_NOTICE_VERSION, null, "Asia/Bangkok", "Rawai Padel"]);
    expect(sent("pinChatMessage")).toHaveLength(0);

    // Promoted without the right to pin: no notice, nothing read.
    calls = [];
    expect(await promote(chat, { ...ADMIN_RIGHTS, can_pin_messages: false })).toBe("rejoined");
    expect(sent("sendMessage")).toHaveLength(0);
    expect((await chatRow(chat.id)).listeningSince).toBeNull();
    // The right on paper, but Telegram refuses the pin: a notice nobody pinned is not consent, so still nothing read.
    pinFails = true;
    expect(await promote(chat, ADMIN_RIGHTS)).toBe("rejoined");
    expect((await chatRow(chat.id)).listeningSince).toBeNull();
    pinFails = false;

    // The promotion that may pin starts it: the notice is sent, pinned, written into the description, and an invite link is made.
    calls = [];
    expect(await promote(chat, ADMIN_RIGHTS)).toBe("crew_listening");
    row = await chatRow(chat.id);
    const notice = groupMessages().find((c) => String(c.body.text).includes("Kicksmash runs matches here"))!;
    expect(notice).toBeDefined();
    expect(String(notice.body.text)).toContain(strings("en").crewNotice);
    expect(sent("pinChatMessage").map((c) => c.body.message_id)).toEqual([row.noticeMessageId]);
    expect(sent("setChatDescription").map((c) => c.body.description)).toEqual([strings("en").crewNotice]);
    expect(sent("createChatInviteLink")).toHaveLength(1);
    expect(row.listeningSince?.toISOString()).toBe(NOW.toISOString());
    expect(row.inviteLink).toBe(INVITE);
    expect(await crewTelegramInvite(db, crew.id)).toBe(INVITE);
    expect(await crewTelegramInvite(db, other.id)).toBeNull();
    expect(await metric("tg_groups_managed")).toBe(1);

    // The other order: promoted first (the welcome), then the link (the notice). One notice, one pin.
    const chat2 = { id: -200401, type: "supergroup" as const, title: "Crew chat 2" };
    members.set(`${chat2.id}:1`, { status: "administrator" });
    members.set(`${chat2.id}:${BOT.id}`, ADMIN_RIGHTS);
    calls = [];
    expect(await update({ my_chat_member: { chat: chat2, from: user(1, "Ana"), old_chat_member: { status: "left" }, new_chat_member: ADMIN_RIGHTS } })).toBe("welcome");
    expect(await say(chat2, user(1, "Ana"), `/start@kicksmash_bot ${crewStartPayload(crew.id)}`).outcome).toBe("crew_listening");
    expect(sent("pinChatMessage")).toHaveLength(1);
    expect((await chatRow(chat2.id)).groupId).toBe(crew.id);
    // Telegram's own promotion update arriving after the link changes nothing.
    expect(await promote(chat2, ADMIN_RIGHTS)).toBe("rejoined");
    expect(sent("pinChatMessage")).toHaveLength(1);
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
    const { chat, crew } = await listeningCrew(-200700);
    await matchWithCard(chat);
    const noticeId = (await chatRow(chat.id)).noticeMessageId;
    calls = [];

    // A member who is not an admin cannot switch the group off: a shrug, nothing else.
    members.set(`${chat.id}:9`, { status: "member" });
    const nope = say(chat, user(9, "Ivo"), "/quiet");
    expect(await nope.outcome).toBe("quiet_not_admin");
    expect(reactions()).toEqual([{ message: nope.id, emoji: "🤷" }]);
    expect((await chatRow(chat.id)).listeningSince).not.toBeNull();

    calls = [];
    const quiet = say(chat, user(1, "Ana"), "/quiet@kicksmash_bot");
    expect(await quiet.outcome).toBe("quiet");
    let row = await chatRow(chat.id);
    expect([row.listeningSince, row.noticeVersion, row.noticeMessageId]).toEqual([null, null, null]);
    expect(sent("unpinChatMessage").map((c) => c.body.message_id)).toEqual([noticeId]);
    expect(sent("unpinAllChatMessages")).toHaveLength(0);
    expect(sent("setChatDescription").map((c) => c.body.description)).toEqual([""]);
    expect(reactions()).toEqual([{ message: quiet.id, emoji: "👌" }]);
    expect(groupMessages()).toHaveLength(0);
    calls = [];
    expect(await say(chat, user(2, "Petr"), "I'm in").outcome).toBe("ignored");
    expect(calls).toHaveLength(0);
    // A promotion after /quiet does not start it again: the opt-in went with it.
    expect(await promote(chat, ADMIN_RIGHTS)).toBe("rejoined");
    expect((await chatRow(chat.id)).listeningSince).toBeNull();

    // The crew link again, then the bot is demoted: it stops at once and keeps the opt-in.
    expect(await say(chat, user(1, "Ana"), `/start ${crewStartPayload(crew.id)}`).outcome).toBe("crew_listening");
    expect(await promote(chat, { status: "member" })).toBe("crew_quiet:demoted");
    row = await chatRow(chat.id);
    expect([row.listeningSince, row.noticeVersion]).toEqual([null, CREW_NOTICE_VERSION]);
    calls = [];
    expect(await say(chat, user(2, "Petr"), "I'm in").outcome).toBe("ignored");
    expect(calls).toHaveLength(0);
    // Promoted again by a group admin: back, with its notice.
    expect(await promote(chat, ADMIN_RIGHTS)).toBe("crew_listening");
    // Restricted is not an admin either.
    expect(await promote(chat, { status: "restricted" })).toBe("ignored");
    expect((await chatRow(chat.id)).listeningSince).toBeNull();
    expect(await promote(chat, ADMIN_RIGHTS)).toBe("crew_listening");

    // Removed: nothing read, no opt-in, and the crew page stops offering the way in.
    expect(await update({ my_chat_member: { chat, from: user(1, "Ana"), old_chat_member: { status: "administrator" }, new_chat_member: { status: "kicked" } } })).toBe("left");
    row = await chatRow(chat.id);
    expect([row.listeningSince, row.noticeVersion, row.inviteLink]).toEqual([null, null, null]);
    expect(await crewTelegramInvite(db, crew.id)).toBeNull();
  });

  it("no message text is kept anywhere: every table is searched for the words people typed", async () => {
    const MARK = "zqxwvmark";
    const { chat } = await listeningCrew(-200800);
    const { card } = await matchWithCard(chat);
    const noticeId = (await chatRow(chat.id)).noticeMessageId!;
    // Petr told us something here once: a reply to the bot from him would join that note anywhere else.
    await db.insert(feedback).values({ source: "telegram", text: "bigger buttons please", telegramChatId: chat.id, telegramUserId: 2, locale: "en" });
    for (const [text, replyTo] of [
      [`${MARK} see you all on court`, undefined],
      [`I'm in ${MARK}`, undefined],
      [`${MARK} what a game`, card.messageId],
      [`${MARK} thanks for the reminder`, noticeId],
      [`who's in ${MARK}?`, undefined],
    ] as const) {
      await say(chat, user(2, "Petr"), text, { replyTo }).outcome;
    }
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
