import { createHash, createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, telegramCards, telegramChats, telegramInlineCards } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { cancelEvent, createEvent, updateEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { setTournamentLock } from "@/lib/domain/tournament";
import { saveMatchScore } from "@/lib/domain/scores";
import { miniAppUrl, telegramBotId, verifyInitData, verifyLoginWidget } from "@/lib/telegram/api";
import { miniAppNext, readAuthResult, returnToFor, telegramAuthUrl } from "@/lib/telegram/login";
import { chatTicket, codesInText, handleTelegramUpdate, linkTelegram, parseSets, postCardForTicket, postTelegramNotice, postTelegramResult, refreshStartedCards, sendTelegramReminders, syncTelegram, telegramCreatorNote, verifyChatTicket } from "@/lib/telegram/bot";
import { renderCard } from "@/lib/telegram/card";
import { renderDiscordCard } from "@/lib/discord/card";
import { matchToPublic } from "@/lib/api/serialize";
import { notifyCreator } from "@/lib/notify";
import { getEventByCode } from "@/lib/domain/queries";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

const TOKEN = "123456:TESTTOKEN";
type Call = { method: string; body: Record<string, unknown> };
let calls: Call[] = [];
let nextMessageId = 100;

// Chat ids the fake Bot API refuses (a user who never pressed Start, or blocked the bot).
let unreachable = new Set<number>();
function stubTelegram() {
  calls = [];
  unreachable = new Set();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      if (unreachable.has(Number(body.chat_id))) return new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" }), { status: 403, headers: { "content-type": "application/json" } });
      const result = method === "sendMessage" || method === "sendPhoto" ? { message_id: nextMessageId++, chat: { id: body.chat_id } } : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}
const sent = (method: string) => calls.filter((c) => c.method === method);

const user = (id: number, first_name: string, language_code = "en") => ({ id, first_name, username: `${first_name.toLowerCase()}_tg`, language_code });
const group = { id: -100123, type: "supergroup" as const, title: "Thursday padel" };

describe("telegram signatures and tickets", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_WEBHOOK_SECRET = "hooksecret";
  });
  it("verifies the Login Widget hash and rejects stale or forged data", () => {
    const now = new Date("2026-09-05T12:00:00Z");
    const fields: Record<string, string> = { id: "42", first_name: "Ana", username: "ana", auth_date: String(Math.floor(now.getTime() / 1000) - 60) };
    const secret = createHash("sha256").update(TOKEN).digest();
    const check = Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join("\n");
    fields.hash = createHmac("sha256", secret).update(check).digest("hex");
    expect(verifyLoginWidget(fields, now)).toBe(true);
    expect(verifyLoginWidget({ ...fields, first_name: "Eve" }, now)).toBe(false);
    expect(verifyLoginWidget(fields, new Date(now.getTime() + 2 * 24 * 3600 * 1000))).toBe(false);
    expect(verifyLoginWidget({ ...fields, hash: "00" }, now)).toBe(false);
  });
  it("the same-tab sign-in: the URL Telegram gets, and the fields it puts in the hash on the way back", () => {
    const url = new URL(telegramAuthUrl("123456", "https://kicksma.sh", "https://kicksma.sh/me", "ru"));
    expect(url.origin + url.pathname).toBe("https://oauth.telegram.org/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({ bot_id: "123456", origin: "https://kicksma.sh", request_access: "write", lang: "ru", return_to: "https://kicksma.sh/me" });
    expect(new URL(telegramAuthUrl("1", "https://kicksma.sh", "https://kicksma.sh/me", "de")).searchParams.get("lang")).toBe("en");
    expect(returnToFor({ origin: "https://kicksma.sh", pathname: "/me" })).toBe("https://kicksma.sh/me");
    expect(telegramBotId()).toBe("123456");
    const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const fields = { id: 7, first_name: "Оля", username: "olya", auth_date: 1757160000, hash: "ab".repeat(32) };
    expect(readAuthResult(`#tgAuthResult=${b64u(JSON.stringify(fields))}`)).toEqual({ id: "7", first_name: "Оля", username: "olya", auth_date: "1757160000", hash: "ab".repeat(32) });
    expect(readAuthResult(`#tgAuthResult=${b64u(JSON.stringify({ id: 7, first_name: "Bo" }))}`)).toBeNull();
    expect(readAuthResult("#tgAuthResult=%%%")).toBeNull();
    expect(readAuthResult("")).toBeNull();
    expect(readAuthResult("#other=1")).toBeNull();
  });
  it("verifies Mini App initData", () => {
    const now = new Date("2026-09-05T12:00:00Z");
    const params = new URLSearchParams({ auth_date: String(Math.floor(now.getTime() / 1000)), query_id: "q1", user: JSON.stringify({ id: 7, first_name: "Bo" }) });
    const check = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
    params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
    const ok = verifyInitData(params.toString(), now);
    expect(ok?.query_id).toBe("q1");
    expect(verifyInitData(params.toString().replace("Bo", "Bob"), now)).toBeNull();
  });
  it("the Mini App: where a start parameter leads, and the direct link on cards once the app exists", async () => {
    expect(miniAppNext(null)).toBe("/me");
    expect(miniAppNext("AbCd")).toBe("/AbCd");
    expect(miniAppNext("r_AbCd")).toBe("/AbCd");
    expect(miniAppNext("../etc")).toBe("/me");
    delete process.env.TELEGRAM_MINIAPP_SLUG;
    expect(miniAppUrl("AbCd")).toBeNull();
    process.env.TELEGRAM_BOT_USERNAME = "kicksmash_bot";
    process.env.TELEGRAM_MINIAPP_SLUG = "app";
    expect(miniAppUrl("AbCd")).toBe("https://t.me/kicksmash_bot/app?startapp=AbCd");
    expect(miniAppUrl()).toBe("https://t.me/kicksmash_bot/app");
    delete process.env.TELEGRAM_MINIAPP_SLUG;
  });

  it("chat tickets are bound to the chat and expire after two days", () => {
    const now = new Date("2026-09-05T12:00:00Z");
    const ticket = chatTicket(-5, now);
    expect(verifyChatTicket(ticket, now)).toBe(-5);
    expect(verifyChatTicket(ticket, new Date(now.getTime() + 20 * 3600 * 1000))).toBe(-5);
    expect(verifyChatTicket(ticket, new Date(now.getTime() + 3 * 24 * 3600 * 1000))).toBeNull();
    expect(verifyChatTicket(ticket.replace("-5.", "-6."), now)).toBeNull();
    expect(verifyChatTicket("garbage", now)).toBeNull();
  });
  it("finds match codes in pasted links", () => {
    expect(codesInText("join us https://kicksma.sh/Ab9Z tonight and http://localhost:3000/Q2wE", "http://localhost:3000")).toEqual(["Ab9Z", "Q2wE"]);
    expect(codesInText("https://example.com/Ab9Z", "http://localhost:3000")).toEqual([]);
    expect(codesInText(undefined)).toEqual([]);
  });
});

describe("telegram bot (db, stubbed Bot API)", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_WEBHOOK_SECRET = "hooksecret";
    process.env.TELEGRAM_BOT_USERNAME = "kicksmash_bot";
    stubTelegram();
  });
  afterEach(() => vi.unstubAllGlobals());

  // A month ahead by default, so events made here can never land in another test's fixed reminder window.
  async function match(startsAt = new Date(Date.now() + 30 * 24 * HOUR)) {
    const org = await makePlayer(db, "Olga");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt, tz: "Asia/Bangkok", venueName: "Rawai Padel Club", court: "2", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    return { org, ev };
  }

  it("welcomes a chat once, posts a card for a pasted link, edits it on join and leave, stays quiet otherwise", async () => {
    const added = await handleTelegramUpdate(db, { update_id: 1, my_chat_member: { chat: group, from: user(1, "Ivan", "ru"), old_chat_member: { status: "left" }, new_chat_member: { status: "member" } } }, NO_SIDE_EFFECTS);
    expect(added).toBe("welcome");
    expect(sent("sendMessage")).toHaveLength(1);
    expect(String(sent("sendMessage")[0].body.text)).toContain("Привет");
    const again = await handleTelegramUpdate(db, { update_id: 2, my_chat_member: { chat: group, from: user(1, "Ivan", "ru"), old_chat_member: { status: "member" }, new_chat_member: { status: "administrator" } } }, NO_SIDE_EFFECTS);
    expect(again).toBe("rejoined");
    expect(sent("sendMessage")).toHaveLength(1);

    const { ev } = await match();
    const posted = await handleTelegramUpdate(db, { update_id: 3, message: { message_id: 10, date: 0, chat: group, from: user(1, "Ivan", "ru"), text: `Кто играет? https://kicksma.sh/${ev.code}` } }, NO_SIDE_EFFECTS);
    expect(posted).toBe("card");
    const card = sent("sendMessage").at(-1)!;
    expect(String(card.body.text)).toContain("Rawai Padel Club · Корт 2");
    expect(String(card.body.text)).toContain("Игроки 1/4");
    expect(JSON.stringify(card.body.reply_markup)).toContain(`j:${ev.code}`);
    const [row] = await db.select().from(telegramCards).where(eq(telegramCards.eventId, ev.id));
    expect(row.chatId).toBe(group.id);

    // Ordinary chatter: nothing.
    expect(await handleTelegramUpdate(db, { update_id: 4, message: { message_id: 11, date: 0, chat: group, from: user(2, "Petr"), text: "see you there" } }, NO_SIDE_EFFECTS)).toBe("ignored");
    const before = calls.length;

    // Two taps: joined, then already in. The card is edited, no new message.
    const tap = (id: number, u: ReturnType<typeof user>, data: string) => handleTelegramUpdate(db, { update_id: id, callback_query: { id: `cb${id}`, from: u, message: { message_id: row.messageId, date: 0, chat: group }, data } }, NO_SIDE_EFFECTS);
    expect(await tap(5, user(2, "Petr"), `j:${ev.code}`)).toBe("join:joined");
    expect(await tap(6, user(2, "Petr"), `j:${ev.code}`)).toBe("join:already_in");
    expect(sent("sendMessage").length).toBe(2);
    expect(sent("editMessageText")).toHaveLength(1);
    expect(String(sent("editMessageText")[0].body.text)).toContain("Игроки 2/4");
    expect(sent("answerCallbackQuery").map((c) => c.body.text)).toEqual(["Вы в игре ✅", "Вы уже записаны."]);
    const petr = await db.select().from(players).where(eq(players.telegramId, 2));
    expect(petr[0].displayName).toBe("Petr");
    expect(await tap(7, user(2, "Petr"), `l:${ev.code}`)).toBe("leave:left");
    expect(await tap(8, user(3, "Sasha"), `l:${ev.code}`)).toBe("leave:not_in");
    expect(String(sent("editMessageText").at(-1)!.body.text)).toContain("Игроки 1/4");
    expect(calls.length - before).toBeGreaterThan(0);

    // Filling the line-up: the card edits, plus exactly one "complete" note.
    for (const u of [user(4, "Dima"), user(5, "Kolya"), user(6, "Misha")]) await tap(20 + u.id, u, `j:${ev.code}`);
    const notes = sent("sendMessage").filter((c) => String(c.body.text).includes("Состав собран"));
    expect(notes).toHaveLength(1);
    expect(notes[0].body.reply_parameters).toMatchObject({ message_id: row.messageId });
    // A late tap goes to the waitlist and the note is not repeated.
    expect(await tap(30, user(7, "Zhenya"), `j:${ev.code}`)).toBe("join:waitlisted");
    expect(sent("sendMessage").filter((c) => String(c.body.text).includes("Состав собран"))).toHaveLength(1);
    expect(String(sent("editMessageText").at(-1)!.body.text)).toContain("Лист ожидания: 1");
  });

  it("/new hands out a ticket that posts the card after creation; /lang and /help answer briefly; private /start gives the personal link", async () => {
    const chat = { id: -100777, type: "group" as const, title: "Padel SG" };
    expect(await handleTelegramUpdate(db, { update_id: 40, message: { message_id: 1, date: 0, chat, from: user(9, "Lee"), text: "/new@kicksmash_bot" } }, NO_SIDE_EFFECTS)).toBe("new");
    const reply = sent("sendMessage").at(-1)!;
    const url = (reply.body.reply_markup as { inline_keyboard: { url: string }[][] }).inline_keyboard[0][0].url;
    const ticket = new URL(url).searchParams.get("tg")!;
    expect(verifyChatTicket(ticket)).toBe(chat.id);
    const { ev } = await match();
    expect(await postCardForTicket(db, ev.code, ticket)).toBe(true);
    expect(await postCardForTicket(db, ev.code, "bad.ticket.x")).toBe(false);
    expect(String(sent("sendMessage").at(-1)!.body.text)).toContain("Players 1/4");
    expect(await handleTelegramUpdate(db, { update_id: 41, message: { message_id: 2, date: 0, chat, from: user(9, "Lee"), text: "/lang ru" } }, NO_SIDE_EFFECTS)).toBe("lang");
    const [row] = await db.select().from(telegramChats).where(eq(telegramChats.chatId, chat.id));
    expect(row.locale).toBe("ru");
    expect(await handleTelegramUpdate(db, { update_id: 42, message: { message_id: 3, date: 0, chat, from: user(9, "Lee"), text: "/help" } }, NO_SIDE_EFFECTS)).toBe("help");
    expect(await handleTelegramUpdate(db, { update_id: 43, message: { message_id: 4, date: 0, chat, from: user(9, "Lee"), text: "/match ZZZZ" } }, NO_SIDE_EFFECTS)).toBe("match_unknown");
    const priv = await handleTelegramUpdate(db, { update_id: 44, message: { message_id: 5, date: 0, chat: { id: 9, type: "private" }, from: user(9, "Lee"), text: "/start" } }, NO_SIDE_EFFECTS);
    expect(priv).toBe("private_start");
    expect(String(sent("sendMessage").at(-1)!.body.text)).toMatch(/\/p\/[A-Za-z0-9]{12}/);
  });

  it("reminds about an hour before, once, and posts the result once the organizer confirms", async () => {
    const chat = { id: -100888, type: "supergroup" as const, title: "Reminders" };
    await handleTelegramUpdate(db, { update_id: 50, my_chat_member: { chat, from: user(11, "Max"), old_chat_member: { status: "left" }, new_chat_member: { status: "member" } } }, NO_SIDE_EFFECTS);
    // A whole hour a week ahead: the fixed windows below never collide with the real clock.
    const now = new Date(Math.ceil(Date.now() / HOUR) * HOUR + 7 * 24 * HOUR);
    const { org, ev } = await match(new Date(now.getTime() + 70 * 60 * 1000));
    await handleTelegramUpdate(db, { update_id: 51, message: { message_id: 1, date: 0, chat, from: user(11, "Max"), text: `/match ${ev.code}` } }, NO_SIDE_EFFECTS);
    expect(await sendTelegramReminders(db, new Date(now.getTime() - 3 * HOUR))).toBe(0);
    expect(await sendTelegramReminders(db, now)).toBe(1);
    expect(String(sent("sendMessage").at(-1)!.body.text)).toContain("⏰");
    expect(await sendTelegramReminders(db, now)).toBe(0);

    // Result: nothing before the organizer confirms, one picture after.
    expect(await postTelegramResult(db, ev.code)).toBe(0);
    for (const name of ["A", "B", "C"]) {
      const p = await makePlayer(db, name);
      await joinEvent(db, { eventId: ev.id, playerId: p.id });
    }
    await db.update(events).set({ startsAt: new Date(now.getTime() - 3 * HOUR) }).where(eq(events.id, ev.id));
    await saveMatchScore(db, { eventId: ev.id, sets: [{ setNumber: 1, sideA: 6, sideB: 3 }], playerId: org.id, isCreator: true, now });
    expect(await postTelegramResult(db, ev.code)).toBe(1);
    expect(sent("sendPhoto")).toHaveLength(1);
    expect(String(sent("sendPhoto")[0].body.caption)).toContain("6-3");
    expect(await postTelegramResult(db, ev.code)).toBe(0);
  });

  it("linking merges the bot-created player into the signed-in one; cards render for tournaments too", async () => {
    const chat = { id: -100999, type: "group" as const, title: "Merge" };
    await handleTelegramUpdate(db, { update_id: 60, my_chat_member: { chat, from: user(21, "Nina"), old_chat_member: { status: "left" }, new_chat_member: { status: "member" } } }, NO_SIDE_EFFECTS);
    const { ev } = await match();
    await handleTelegramUpdate(db, { update_id: 61, message: { message_id: 1, date: 0, chat, from: user(21, "Nina"), text: `/match ${ev.code}` } }, NO_SIDE_EFFECTS);
    const [card] = await db.select().from(telegramCards).where(eq(telegramCards.eventId, ev.id));
    await handleTelegramUpdate(db, { update_id: 62, callback_query: { id: "x", from: user(21, "Nina"), message: { message_id: card.messageId, date: 0, chat }, data: `j:${ev.code}` } }, NO_SIDE_EFFECTS);
    const web = await makePlayer(db, "Nina Web");
    const linked = await linkTelegram(db, web.id, user(21, "Nina"));
    expect(linked.telegramId).toBe(21);
    const detail = (await getEventByCode(db, ev.code))!;
    expect(detail.roster.some((s) => s.playerId === web.id)).toBe(true);
    expect(await db.select().from(players).where(eq(players.telegramId, 21))).toHaveLength(1);

    const org = await makePlayer(db, "Org");
    const t = await createEvent(db, { creatorPlayerId: org.id, type: "tournament", format: "king", capacity: 8, startsAt: new Date(Date.now() + HOUR), tz: "Asia/Bangkok", venueName: null, whenFull: "waitlist" });
    const tdetail = (await getEventByCode(db, t.code))!;
    const r = renderCard(tdetail, "https://kicksma.sh", "en");
    expect(r.text).toContain("King of the court");
    expect(r.text).toContain("Players 0/8");
    expect(r.text).toContain("Court TBD");
    expect(r.complete).toBe(false);
    await setTournamentLock(db, { eventId: t.id, locked: false, actorPlayerId: org.id }).catch(() => undefined);
    const cancelled = renderCard({ ...tdetail, event: { ...tdetail.event, status: "cancelled" } }, "https://kicksma.sh", "ru");
    expect(cancelled.text).toContain("Отменён");
    expect(cancelled.keyboard.inline_keyboard).toHaveLength(1);
  });

  it("the money line: on both cards and the match page's API shape, the pay details never in the public API", async () => {
    const org = await makePlayer(db, "Kai");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + 30 * 24 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel Club", whenFull: "waitlist", cost: "  400 ฿ ", payNote: "PromptPay 081 234 5678" });
    expect(ev.cost).toBe("400 ฿");
    const detail = (await getEventByCode(db, ev.code))!;
    expect(renderCard(detail, "https://kicksma.sh", "en").text).toContain("💸 400 ฿ · PromptPay 081 234 5678");
    process.env.TELEGRAM_MINIAPP_SLUG = "app";
    expect(JSON.stringify(renderCard(detail, "https://kicksma.sh", "en").keyboard)).toContain(`https://t.me/kicksmash_bot/app?startapp=${ev.code}`);
    delete process.env.TELEGRAM_MINIAPP_SLUG;
    expect(JSON.stringify(renderCard(detail, "https://kicksma.sh", "en").keyboard)).toContain(`https://kicksma.sh/${ev.code}`);
    expect(renderDiscordCard(detail, "https://kicksma.sh", "ru").embeds[0].description).toContain("💸 400 ฿ · PromptPay 081 234 5678");
    const pub = matchToPublic(detail, "https://kicksma.sh");
    expect(pub.cost).toBe("400 ฿");
    expect(JSON.stringify(pub)).not.toContain("PromptPay");
    const { event: updated } = await updateEvent(db, ev.id, org.id, { cost: "", payNote: "Revolut @kai" });
    expect(updated.cost).toBeNull();
    expect(updated.payNote).toBe("Revolut @kai");
    expect(renderCard((await getEventByCode(db, ev.code))!, "https://kicksma.sh", "en").text).not.toContain("💸");
  });

  it("a time change or a cancellation reaches the Telegram players: a reply under the card that mentions them, a private message to each who can receive one", async () => {
    const chat = { id: -100555, type: "supergroup" as const, title: "Notices" };
    await handleTelegramUpdate(db, { update_id: 60, my_chat_member: { chat, from: user(41, "Ivan", "ru"), old_chat_member: { status: "left" }, new_chat_member: { status: "member" } } }, NO_SIDE_EFFECTS);
    const { org, ev } = await match();
    await handleTelegramUpdate(db, { update_id: 61, message: { message_id: 1, date: 0, chat, from: user(41, "Ivan", "ru"), text: `https://kicksma.sh/${ev.code}` } }, NO_SIDE_EFFECTS);
    const [card] = await db.select().from(telegramCards).where(eq(telegramCards.eventId, ev.id));
    const tap = (id: number, u: ReturnType<typeof user>) => handleTelegramUpdate(db, { update_id: id, callback_query: { id: `cb${id}`, from: u, message: { message_id: card.messageId, date: 0, chat }, data: `j:${ev.code}` } }, NO_SIDE_EFFECTS);
    await tap(62, user(41, "Ivan", "ru"));
    await tap(63, { id: 42, first_name: "Оля", language_code: "ru" } as ReturnType<typeof user>);
    // A web player without Telegram is in too: nothing goes to them from here.
    const web = await makePlayer(db, "Web");
    await joinEvent(db, { eventId: ev.id, playerId: web.id });
    calls = [];
    unreachable.add(42); // Olya never pressed Start.

    const moved = await updateEvent(db, ev.id, org.id, { startsAt: new Date(ev.startsAt.getTime() + 2 * HOUR) });
    expect(moved.calendarChanged).toBe(true);
    const upd = await postTelegramNotice(db, ev.code, "updated");
    expect(upd).toEqual({ notes: 1, dms: 1 });
    const note = sent("sendMessage").find((c) => c.body.chat_id === chat.id)!;
    expect(String(note.body.text)).toContain("🔁");
    expect(String(note.body.text)).toContain("теперь"); // the chat's language: Ivan added the bot in Russian
    expect(String(note.body.text)).toContain("@ivan_tg");
    expect(String(note.body.text)).toContain('<a href="tg://user?id=42">Оля</a>');
    expect(note.body.reply_parameters).toMatchObject({ message_id: card.messageId });
    const dm = sent("sendMessage").find((c) => c.body.chat_id === 41)!;
    expect(String(dm.body.text)).toContain("теперь");
    expect(JSON.stringify(dm.body.reply_markup)).toMatch(/\/p\/[A-Za-z0-9]{12}\//);
    expect(sent("sendMessage").filter((c) => c.body.chat_id === 42)).toHaveLength(1); // tried, refused, no retry
    expect(sent("sendMessage").some((c) => c.body.chat_id === org.telegramId)).toBe(false);

    calls = [];
    await cancelEvent(db, ev.id, org.id);
    expect(await postTelegramNotice(db, ev.code, "cancelled")).toEqual({ notes: 1, dms: 1 });
    expect(String(sent("sendMessage")[0].body.text)).toContain("❌");
    // Nothing more once it is cancelled, and nothing at all without the bot.
    expect(await postTelegramNotice(db, ev.code, "updated")).toEqual({ notes: 0, dms: 0 });
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(await postTelegramNotice(db, ev.code, "cancelled")).toEqual({ notes: 0, dms: 0 });
  });

  it("an organizer who linked Telegram hears who joined and left, in their language; nobody else does", async () => {
    const { org, ev } = await match();
    const petr = await makePlayer(db, "Petr");
    await joinEvent(db, { eventId: ev.id, playerId: petr.id });
    // Not linked: no message.
    await notifyCreator(db, ev, "joined", "Petr", petr.id);
    expect(sent("sendMessage")).toHaveLength(0);
    const linked = await linkTelegram(db, org.id, { id: 31, first_name: "Olga", username: "olga_tg", language_code: "ru" });
    await db.update(players).set({ locale: "ru" }).where(eq(players.id, org.id));
    const detail = (await getEventByCode(db, ev.code))!;
    expect(await telegramCreatorNote(db, detail, { ...linked, locale: "ru" }, "joined", "Petr")).toBe(true);
    const dm = sent("sendMessage").at(-1)!;
    expect(dm.body.chat_id).toBe(31);
    expect(String(dm.body.text)).toContain("✅ Petr играет · 2/4");
    expect(String(dm.body.text)).toContain("Rawai Padel Club");
    await notifyCreator(db, ev, "left", "Petr", petr.id);
    expect(String(sent("sendMessage").at(-1)!.body.text)).toContain("↩️ Petr");
    // The organizer's own actions are not echoed back.
    calls = [];
    await notifyCreator(db, ev, "joined", "Olga", org.id);
    expect(sent("sendMessage")).toHaveLength(0);
  });

  it("/new with words creates the match right there: the zone from the text, the chat learns it, the card is posted", async () => {
    const chat = { id: -100333, type: "supergroup" as const, title: "Rawai crew" };
    const lee = user(51, "Lee");
    const send = (id: number, text: string) => handleTelegramUpdate(db, { update_id: id, message: { message_id: id, date: 0, chat, from: lee, text } }, NO_SIDE_EFFECTS);
    // No zone known and nothing in the text that names a place: ask once, offer the form.
    expect(await send(70, "/new tomorrow 19:00")).toBe("new_need_tz");
    expect(String(sent("sendMessage").at(-1)!.body.text)).toContain("/tz");
    expect(await send(71, "/tz nowhere/nope")).toBe("tz_unknown");
    // A place in the text is enough.
    const out = await send(72, "/new tomorrow 19:00 Rawai Padel Club 400฿ level 3-4");
    expect(out).toMatch(/^new_created:[A-Za-z0-9]{4}$/);
    const code = out.split(":")[1];
    const detail = (await getEventByCode(db, code))!;
    expect(detail.event.tz).toBe("Asia/Bangkok");
    expect(detail.event.venueName).toBe("Rawai Padel Club");
    expect(detail.event.cost).toBe("400฿");
    expect([detail.event.levelMin, detail.event.levelMax]).toEqual([3, 4]);
    expect(detail.creator.telegramId).toBe(51);
    expect(detail.roster.filter((x) => x.playerId === detail.creator.id)).toHaveLength(1);
    const card = sent("sendMessage").at(-1)!;
    expect(String(card.body.text)).toContain("Rawai Padel Club");
    expect(String(card.body.text)).toContain("💸 400฿");
    expect(JSON.stringify(card.body.reply_markup)).toContain(`j:${code}`);
    const [row] = await db.select().from(telegramChats).where(eq(telegramChats.chatId, chat.id));
    expect(row.tz).toBe("Asia/Bangkok");
    expect(row.venueName).toBe("Rawai Padel Club");
    // From now on the chat knows its zone and its court.
    const again = await send(73, "/new сб 10:00 американо 8");
    expect(again).toMatch(/^new_created:/);
    const t = (await getEventByCode(db, again.split(":")[1]))!.event;
    expect([t.type, t.format, t.capacity, t.venueName]).toEqual(["tournament", "americano", 8, "Rawai Padel Club"]);
    expect(await send(74, "/new next week sometime")).toBe("new_how");
    expect(await send(75, "/new 01.01.2020 19:00")).toBe("new_past");
    expect(await send(76, "/tz Москва")).toBe("tz");
    expect((await db.select().from(telegramChats).where(eq(telegramChats.chatId, chat.id)))[0].tz).toBe("Europe/Moscow");
    // Bare /new still hands out the form.
    expect(await send(77, "/new")).toBe("new");
  });

  it("the result from the card: 🏁 asks who won, a player's tap records it, the organizer's tap confirms, /score adds the sets", async () => {
    const chat = { id: -100444, type: "supergroup" as const, title: "Results" };
    const org = user(61, "Olga", "ru");
    const players = [user(62, "Petr"), user(63, "Dima"), user(64, "Kolya")];
    const msg = (id: number, from: ReturnType<typeof user>, text: string, reply?: number) => handleTelegramUpdate(db, { update_id: id, message: { message_id: id, date: 0, chat, from, text, ...(reply ? { reply_to_message: { message_id: reply, date: 0, chat } } : {}) } }, NO_SIDE_EFFECTS);
    const tap = (id: number, from: ReturnType<typeof user>, messageId: number, data: string) => handleTelegramUpdate(db, { update_id: id, callback_query: { id: `cb${id}`, from, message: { message_id: messageId, date: 0, chat }, data } }, NO_SIDE_EFFECTS);
    const out = await msg(80, org, "/new tomorrow 20:00 Kata Padel");
    const code = out.split(":")[1];
    const [card] = await db.select().from(telegramCards).where(eq(telegramCards.chatId, chat.id));
    for (const [i, p] of players.entries()) expect(await tap(81 + i, p, card.messageId, `j:${code}`)).toBe("join:joined");
    // Not started: the button is not on the card and a tap says so.
    expect(JSON.stringify(sent("editMessageText").at(-1)!.body.reply_markup)).not.toContain(`r:${code}`);
    expect(await tap(85, org, card.messageId, `r:${code}`)).toBe("result:not_yet");
    // Time passes.
    const ev = (await getEventByCode(db, code))!.event;
    await db.update(events).set({ startsAt: new Date(Date.now() - 2 * HOUR) }).where(eq(events.id, ev.id));
    calls = [];
    expect(await refreshStartedCards(db)).toBe(1);
    expect(JSON.stringify(sent("editMessageText").at(-1)!.body.reply_markup)).toContain(`r:${code}`);
    expect(await refreshStartedCards(db)).toBe(0); // same render, no second edit
    expect(await tap(86, org, card.messageId, `r:${code}`)).toBe("result:prompt");
    const prompt = sent("sendMessage").at(-1)!;
    const rows = (prompt.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    expect(rows).toHaveLength(3);
    expect(rows.flat().map((b) => b.callback_data)).toEqual([`w:${code}:12`, `w:${code}:34`, `w:${code}:13`, `w:${code}:24`, `w:${code}:14`, `w:${code}:23`]);
    expect(rows[0][0].text).toBe("🏆 Olga & Petr");
    // A stranger cannot record; Petr can, and the organizer is asked to confirm.
    expect(await tap(87, user(99, "Zed"), prompt.body.message_id as number, `w:${code}:13`)).toBe("result:error:not_participant");
    expect(await tap(88, players[0], 500, `w:${code}:13`)).toBe("result:recorded");
    let pub = matchToPublic((await getEventByCode(db, code))!, "https://kicksma.sh");
    expect(pub.result).toMatchObject({ teamA: ["Olga", "Dima"], teamB: ["Petr", "Kolya"], winner: "a", sets: [], confirmed: false });
    const edited = sent("editMessageText").at(-1)!;
    expect(String(edited.body.text)).toContain("🏆 Olga &amp; Dima"); // HTML parse mode: the ampersand is escaped, Telegram shows "&"
    expect(JSON.stringify(edited.body.reply_markup)).toContain(`k:${code}`);
    expect(await tap(89, players[1], 500, `k:${code}`)).toBe("result:not_organizer");
    expect(await tap(90, org, 500, `k:${code}`)).toBe("result:confirmed");
    pub = matchToPublic((await getEventByCode(db, code))!, "https://kicksma.sh");
    expect(pub.result?.confirmed).toBe(true);
    expect(String(sent("editMessageText").at(-1)!.body.text)).toContain("подтверждено");
    // The picture goes out once, naming the winners, with no made-up score.
    calls = [];
    expect(await postTelegramResult(db, code)).toBe(1);
    expect(String(sent("sendPhoto")[0].body.caption)).toContain("🏆 Olga & Dima");
    expect(String(sent("sendPhoto")[0].body.caption)).not.toContain("1-0");
    // Sets afterwards, by replying to the card.
    expect(parseSets("6-3, 6:4 and 10-8")).toEqual([{ setNumber: 1, sideA: 6, sideB: 3 }, { setNumber: 2, sideA: 6, sideB: 4 }, { setNumber: 3, sideA: 10, sideB: 8 }]);
    expect(await msg(91, org, "/score 6-3 6-4", card.messageId)).toBe("score_saved");
    pub = matchToPublic((await getEventByCode(db, code))!, "https://kicksma.sh");
    expect(pub.result?.sets).toEqual([{ a: 6, b: 3 }, { a: 6, b: 4 }]);
    expect(await msg(92, org, `/score ${code} 6-3`)).toBe("score_saved");
    expect(await msg(93, org, "/score what")).toBe("score_how");
    // A locked result stays locked for players.
    expect(await msg(94, players[0], `/score ${code} 0-6`)).toBe("score_error:locked");
    expect(await tap(95, org, card.messageId, `r:${code}`)).toBe("result:locked");
  });

  it("the private chat is a console: /start explains, /new makes a card here with a Share button, a bare code shows a card, /games lists mine and the city's open ones", async () => {
    const me = user(91, "Dasha", "ru");
    const dm = { id: 91, type: "private" as const };
    const send = (id: number, text: string) => handleTelegramUpdate(db, { update_id: id, message: { message_id: id, date: 0, chat: dm, from: me, text } }, NO_SIDE_EFFECTS);
    expect(await send(700, "/start")).toBe("private_start");
    expect(String(sent("sendMessage").at(-1)!.body.text)).toContain("/games");
    // No zone known for a fresh private chat: the bot asks once, then remembers.
    expect(await send(701, "/new завтра 19:00 Sunny Club")).toBe("new_need_tz");
    expect(await send(702, "/tz пхукет")).toBe("tz");
    expect(await send(703, "/new завтра 19:00 Sunny Club 400฿")).toMatch(/^new_created:/);
    const card = sent("sendMessage").at(-1)!;
    expect(card.body.chat_id).toBe(91);
    expect(String(card.body.text)).toContain("Sunny Club");
    expect(String(card.body.text)).toContain("💸 400฿");
    const kb = JSON.stringify(card.body.reply_markup);
    expect(kb).toContain('"switch_inline_query"');
    const [row] = await db.select({ code: events.code, tz: events.tz }).from(events).innerJoin(telegramCards, eq(telegramCards.eventId, events.id)).where(eq(telegramCards.chatId, 91));
    expect(row.tz).toBe("Asia/Bangkok");
    expect(kb).toContain(`"switch_inline_query":"${row.code}"`);
    // A bare code pasted into the private chat: the card again (refreshed in place).
    calls = [];
    expect(await send(704, row.code)).toBe("card");
    // /games: my match at the top; a public match in Phuket from someone else below, with a button that shows its card here.
    const other = await makePlayer(db, "Pavel");
    const pub = await createEvent(db, { creatorPlayerId: other.id, type: "match", startsAt: new Date(Date.now() + 2 * 24 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel Club", whenFull: "waitlist", publicListing: true, cost: "350 ฿" });
    await joinEvent(db, { eventId: pub.id, playerId: other.id });
    calls = [];
    expect(await send(705, "/games")).toBe("games:1+1");
    const list = sent("sendMessage").at(-1)!;
    expect(String(list.body.text)).toContain("Ваши ближайшие матчи");
    expect(String(list.body.text)).toContain("Открытые матчи · Phuket");
    expect(String(list.body.text)).toContain("350 ฿");
    expect(JSON.stringify(list.body.reply_markup)).toContain(`c:${pub.code}`);
    expect(await handleTelegramUpdate(db, { update_id: 706, callback_query: { id: "cbc", from: me, message: { message_id: 5, date: 0, chat: dm }, data: `c:${pub.code}` } }, NO_SIDE_EFFECTS)).toBe("card");
    expect(String(sent("sendMessage").at(-1)!.body.text)).toContain("Rawai Padel Club");
    // Unknown text in private: the help, not silence.
    expect(await send(707, "hello?")).toBe("private_other");
  });

  it("inline mode: @bot lists the city's open matches, an exact code gives that card, a chosen result stays live, taps under it join and edit it in place", async () => {
    const lee = user(92, "Lee");
    const { ev } = await match();
    const pub = await createEvent(db, { creatorPlayerId: (await makePlayer(db, "Nok")).id, type: "match", startsAt: new Date(Date.now() + 3 * 24 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel Club", whenFull: "waitlist", publicListing: true });
    // Lee has no history and names no city: nothing to list, so the picker offers to create one.
    calls = [];
    expect(await handleTelegramUpdate(db, { update_id: 800, inline_query: { id: "iq1", from: lee, query: "", offset: "" } }, NO_SIDE_EFFECTS)).toBe("inline:0");
    expect(sent("answerInlineQuery")[0].body.button).toBeTruthy();
    // With a city: the public match shows.
    expect(await handleTelegramUpdate(db, { update_id: 801, inline_query: { id: "iq2", from: lee, query: "phuket", offset: "" } }, NO_SIDE_EFFECTS)).toMatch(/^inline:[1-9]/);
    const results = sent("answerInlineQuery").at(-1)!.body.results as { id: string; title: string; description: string; input_message_content: { message_text: string }; reply_markup: unknown }[];
    const hit = results.find((r) => r.id === pub.code)!;
    expect(hit).toBeTruthy();
    expect(hit.description).toContain("Rawai Padel Club · 0/4");
    expect(hit.input_message_content.message_text).toContain("Rawai Padel Club");
    expect(JSON.stringify(hit.reply_markup)).toContain(`j:${pub.code}`);
    // An exact code: that match, listed or not.
    expect(await handleTelegramUpdate(db, { update_id: 802, inline_query: { id: "iq3", from: lee, query: ev.code, offset: "" } }, NO_SIDE_EFFECTS)).toBe("inline:1");
    expect((sent("answerInlineQuery").at(-1)!.body.results as { id: string }[])[0].id).toBe(ev.code);
    // Lee sends it into some chat: Telegram tells us the inline message id.
    expect(await handleTelegramUpdate(db, { update_id: 803, chosen_inline_result: { result_id: ev.code, from: lee, query: ev.code, inline_message_id: "AAQinline1" } }, NO_SIDE_EFFECTS)).toBe("inline_chosen");
    const [stored] = await db.select().from(telegramInlineCards).where(eq(telegramInlineCards.inlineMessageId, "AAQinline1"));
    expect(stored.eventId).toBe(ev.id);
    // A tap under that card (no chat, no message: only the inline id): the join goes through and the card is edited by its inline id.
    calls = [];
    expect(await handleTelegramUpdate(db, { update_id: 804, callback_query: { id: "cbi", from: user(93, "Mai"), inline_message_id: "AAQinline1", data: `j:${ev.code}` } }, NO_SIDE_EFFECTS)).toBe("join:joined");
    const edit = calls.find((c) => c.method === "editMessageText" && c.body.inline_message_id === "AAQinline1")!;
    expect(edit).toBeTruthy();
    expect(String(edit.body.text)).toContain("Players 2/4");
    // A tap under a card we never heard about (inline feedback off in BotFather): learned on the spot.
    expect(await handleTelegramUpdate(db, { update_id: 805, callback_query: { id: "cbj", from: user(94, "Ploy"), inline_message_id: "AAQinline2", data: `j:${ev.code}` } }, NO_SIDE_EFFECTS)).toBe("join:joined");
    expect((await db.select().from(telegramInlineCards).where(eq(telegramInlineCards.eventId, ev.id))).length).toBe(2);
    // The result tap under an inline card has no chat to answer in: the question goes to the tapper privately, or through a deep link.
    await db.update(events).set({ startsAt: new Date(Date.now() - HOUR) }).where(eq(events.id, ev.id));
    await joinEvent(db, { eventId: ev.id, playerId: (await makePlayer(db, "Fourth")).id });
    calls = [];
    expect(await handleTelegramUpdate(db, { update_id: 806, callback_query: { id: "cbr", from: user(93, "Mai"), inline_message_id: "AAQinline1", data: `r:${ev.code}` } }, NO_SIDE_EFFECTS)).toBe("result:prompt_dm");
    expect(sent("sendMessage").at(-1)!.body.chat_id).toBe(93);
    unreachable.add(93);
    expect(await handleTelegramUpdate(db, { update_id: 807, callback_query: { id: "cbr2", from: user(93, "Mai"), inline_message_id: "AAQinline1", data: `r:${ev.code}` } }, NO_SIDE_EFFECTS)).toBe("result:prompt_deeplink");
    expect(String(sent("answerCallbackQuery").at(-1)!.body.url)).toContain(`start=r_${ev.code}`);
    // And that deep link, opened in the private chat, asks the question there.
    expect(await handleTelegramUpdate(db, { update_id: 808, message: { message_id: 1, date: 0, chat: { id: 93, type: "private" }, from: user(93, "Mai"), text: `/start r_${ev.code}` } }, NO_SIDE_EFFECTS)).toBe("private_result_prompt");
  });

  it("does nothing when the bot is not configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { ev } = await match();
    expect(await syncTelegram(db, ev.code)).toBe(0);
    expect(await postTelegramResult(db, ev.code)).toBe(0);
    expect(await sendTelegramReminders(db)).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
