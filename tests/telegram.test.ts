import { createHash, createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, telegramCards, telegramChats } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { createEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { setTournamentLock } from "@/lib/domain/tournament";
import { saveMatchScore } from "@/lib/domain/scores";
import { verifyInitData, verifyLoginWidget } from "@/lib/telegram/api";
import { chatTicket, codesInText, handleTelegramUpdate, linkTelegram, postCardForTicket, postTelegramResult, sendTelegramReminders, syncTelegram, verifyChatTicket } from "@/lib/telegram/bot";
import { renderCard } from "@/lib/telegram/card";
import { getEventByCode } from "@/lib/domain/queries";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

const TOKEN = "123456:TESTTOKEN";
type Call = { method: string; body: Record<string, unknown> };
let calls: Call[] = [];
let nextMessageId = 100;

function stubTelegram() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
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

  async function match(startsAt = new Date(Date.now() + 3 * HOUR)) {
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
    const now = new Date("2026-09-06T10:00:00Z");
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

  it("does nothing when the bot is not configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { ev } = await match();
    expect(await syncTelegram(db, ev.code)).toBe(0);
    expect(await postTelegramResult(db, ev.code)).toBe(0);
    expect(await sendTelegramReminders(db)).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
