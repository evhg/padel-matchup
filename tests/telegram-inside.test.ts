import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { coaches, competitionPairs, players, telegramChats } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { coachStrings } from "@/lib/coach/strings";
import { bookLesson, createCoach, presetHours, setStudentStatus, updateCoach } from "@/lib/domain/coaching";
import { addCategory, createCompetition } from "@/lib/domain/competitions";
import { createEvent } from "@/lib/domain/events";
import { getEventDetail } from "@/lib/domain/queries";
import { handleTelegramUpdate } from "@/lib/telegram/bot";
import { botLocale, renderCard, strings } from "@/lib/telegram/card";
import { GUIDED_ZONES } from "@/lib/telegram/parse";
import { packId } from "@/lib/telegram/taps";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

/**
 * The inside of the bot after the door: the card in a third language, a map on it, the serious
 * tournament as taps, the coach's setup that goes on to the price and the payment, and what a
 * student owes as the coach's QR in the chat.
 */

const TOKEN = "123456:TESTTOKEN";
const BOT = { id: 123456, is_bot: true, first_name: "Kicksmash" };
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
const last = () => sent("sendMessage").at(-1)!;
const user = (id: number, first_name: string, language_code = "en") => ({ id, first_name, username: `${first_name.toLowerCase()}_tg`, language_code });
const iso = (daysAhead: number) => new Date(Date.now() + daysAhead * 24 * HOUR).toISOString().slice(0, 10);

describe("the inside of the bot", () => {
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

  const dmOf = (id: number) => ({ id, type: "private" as const });
  const text = (id: number, from: ReturnType<typeof user>, t: string, replyTo?: { message_id: number; text: string }) =>
    handleTelegramUpdate(db, { update_id: id, message: { message_id: id, date: 0, chat: dmOf(from.id), from, text: t, ...(replyTo ? { reply_to_message: { ...replyTo, date: 0, chat: dmOf(from.id), from: BOT } } : {}) } }, NO_SIDE_EFFECTS);
  const tap = (id: number, from: ReturnType<typeof user>, data: string, extra: Record<string, unknown> = {}) => handleTelegramUpdate(db, { update_id: id, callback_query: { id: `cb${id}`, from, message: { message_id: 5, date: 0, chat: dmOf(from.id), ...extra }, data } }, NO_SIDE_EFFECTS);

  it("Spanish is the card's third language: every key, the locale from the code, /lang es, and the player's keyboard in it", async () => {
    expect(botLocale("es-ES")).toBe("es");
    expect(botLocale("es")).toBe("es");
    expect(botLocale("ru")).toBe("ru");
    expect(botLocale("de")).toBe("en");
    expect(botLocale(null)).toBe("en");
    const en = strings("en") as Record<string, unknown>;
    for (const locale of ["ru", "es"] as const) {
      const other = strings(locale) as Record<string, unknown>;
      for (const k of Object.keys(en)) expect(typeof other[k], `${locale}.${k}`).toBe(typeof en[k]);
      expect(Object.keys(other).sort()).toEqual(Object.keys(en).sort());
    }
    expect(strings("es").match).toBe("Partido de pádel");
    const pablo = user(601, "Pablo", "es");
    expect(await text(1, pablo, "/lang es")).toBe("lang");
    expect(String(last().body.text)).toBe("Idioma: español");
    const [row] = await db.select().from(telegramChats).where(eq(telegramChats.chatId, 601));
    expect(row.locale).toBe("es");
    calls = [];
    expect(await text(2, pablo, "/start")).toBe("private_start");
    expect(JSON.stringify(last().body.reply_markup)).toContain("Buscar partido");
    expect(JSON.stringify(last().body.reply_markup)).toContain("Torneos");
    expect((sent("setMyCommands").at(-1)!.body.commands as { description: string }[]).map((c) => c.description)).toContain("Torneos abiertos");
    // The Spanish label is a door like the English one.
    calls = [];
    expect(await text(3, pablo, "🔎 Buscar partido")).toBe("player:find:city");
    expect(String(last().body.text)).toBe("¿Qué ciudad?");
  });

  it("the card carries a map button when the venue has a map link, in the chat's language", async () => {
    const org = await makePlayer(db, "Olga");
    const withMap = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + 30 * 24 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel Club", venueMapUrl: "https://maps.google.com/?q=Rawai+Padel", whenFull: "waitlist" });
    const card = renderCard(await getEventDetail(db, withMap), "https://kicksma.sh", "es");
    expect(card.text).toContain("Partido de pádel");
    expect(JSON.stringify(card.keyboard)).toContain("📍 Mapa");
    expect(JSON.stringify(card.keyboard)).toContain("https://maps.google.com/?q=Rawai+Padel");
    const without = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + 31 * 24 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel Club", whenFull: "waitlist" });
    expect(JSON.stringify(renderCard(await getEventDetail(db, without), "https://kicksma.sh", "en").keyboard)).not.toContain("Map");
  });

  it("tournaments in the chat: the open ones as buttons, a category's door, the partner by name, and the link for them", async () => {
    const ana = user(602, "Ana");
    expect(await text(10, ana, "/start")).toBe("private_start");
    calls = [];
    expect(await text(11, ana, "🏆 Tournaments")).toBe("player:tournaments:none");
    expect(String(last().body.text)).toContain("/t");
    const org = await makePlayer(db, "Org");
    const c = await createCompetition(db, { organizerPlayerId: org.id, name: "Inside Open", tz: "Asia/Bangkok", startsOn: iso(30), endsOn: iso(31), venueName: "Rawai Padel", entryNote: "1,500 THB per pair" });
    const mixed = await addCategory(db, { competitionId: c.id, organizerPlayerId: org.id, name: "Mixed", maxPairs: 8 });
    await addCategory(db, { competitionId: c.id, organizerPlayerId: org.id, name: "Gold 4.0+", levelMin: 4, maxPairs: 8 });
    calls = [];
    expect(await text(12, ana, "🏆 Tournaments")).toBe("player:tournaments:1");
    expect(JSON.stringify(last().body.reply_markup)).toContain(`pt:${packId(c.id)}`);
    // The card, in place of the list.
    calls = [];
    expect(await tap(13, ana, `pt:${packId(c.id)}`)).toBe("player:tournament:card");
    const card = sent("editMessageText").at(-1)!;
    expect(String(card.body.text)).toContain("Inside Open");
    expect(String(card.body.text)).toContain("1,500 THB per pair");
    expect(String(card.body.text)).toContain("<b>Mixed</b> · 0/8 pairs");
    expect(String(card.body.text)).toMatch(/<b>Gold 4\.0\+<\/b> · [^·]+ · 0\/8 pairs/);
    expect(JSON.stringify(card.body.reply_markup)).toContain(`pe:${packId(mixed.id)}`);
    expect(JSON.stringify(card.body.reply_markup)).toContain(`/t/${c.slug}`);
    // The door: a prompt whose last line carries the category; the reply carries the partner.
    calls = [];
    expect(await tap(14, ana, `pe:${packId(mixed.id)}`)).toBe("player:tournament:partner_ask");
    const prompt = last();
    expect(String(prompt.body.text)).toContain(`↳ tp:${packId(mixed.id)}`);
    expect(JSON.stringify(prompt.body.reply_markup)).toContain("force_reply");
    calls = [];
    expect(await text(15, ana, "Dana", { message_id: 77, text: String(prompt.body.text) })).toBe("player:tournament:entered");
    expect(sent("deleteMessage")).toHaveLength(1);
    expect(String(last().body.text)).toContain("You are in Mixed with Dana");
    expect(String(last().body.text)).toContain("https://t.me/kicksmash_bot?start=claim_");
    const [me] = await db.select().from(players).where(eq(players.telegramId, 602));
    const pairs = await db.select().from(competitionPairs).where(eq(competitionPairs.categoryId, mixed.id));
    expect(pairs).toHaveLength(1);
    expect(pairs[0].p1PlayerId).toBe(me.id);
    expect(pairs[0].claimToken).not.toBeNull();
    // The card again: the entry is listed and Mixed has no door any more; Gold keeps its own.
    calls = [];
    expect(await tap(16, ana, `pt:${packId(c.id)}`)).toBe("player:tournament:card");
    const again = sent("editMessageText").at(-1)!;
    expect(String(again.body.text)).toContain("Your entries");
    expect(String(again.body.text)).toContain("Mixed: Ana &amp; Dana");
    expect(JSON.stringify(again.body.reply_markup)).not.toContain(`pe:${packId(mixed.id)}`);
    // Twice into the same category is refused with the reason, in words.
    calls = [];
    expect(await text(17, ana, "Eve", { message_id: 78, text: String(prompt.body.text) })).toBe("player:tournament:already_in");
    expect(String(last().body.text)).toContain("already in this category");
    // An id nobody has is not an error.
    expect(await tap(18, ana, "pt:AAAAAAAAAAAAAAAAAAAAAA")).toBe("player:tournament:unknown");
    expect(await tap(19, ana, "pe:AAAAAAAAAAAAAAAAAAAAAA")).toBe("player:tournament:unknown");
  });

  it("the setup in the chat goes on to the price and how students pay: keypad, keypad, done", async () => {
    const olga = user(603, "Olga");
    const zone = GUIDED_ZONES[0][0];
    expect(await text(20, olga, "/coach")).toBe("coach:setup:where");
    expect(await tap(21, olga, `cn:z-${zone}`)).toBe("coach:setup:lesson");
    expect(await tap(22, olga, `cn:m-${zone}:60`)).toBe("coach:setup:hours");
    calls = [];
    expect(await tap(23, olga, `cn:h-${zone}-60:both`)).toBe("coach:setup:done");
    // The last message is the price on the keypad, under the menu.
    expect(String(last().body.text)).toContain("What does a lesson cost");
    expect(JSON.stringify(last().body.reply_markup)).toContain("kv:ps:8");
    calls = [];
    expect(await tap(24, olga, "kv:ps:8")).toBe("coach:setup:price");
    expect(String(sent("editMessageText").at(-1)!.body.text)).toContain(": 8");
    calls = [];
    expect(await tap(25, olga, "kv:ps:800:ok")).toBe("coach:setup:pay");
    const pay = sent("editMessageText").at(-1)!;
    expect(String(pay.body.text)).toContain("How do students pay you");
    expect(JSON.stringify(pay.body.reply_markup)).toContain("kv:pq:");
    expect(JSON.stringify(pay.body.reply_markup)).toContain("ke:club:1");
    expect(JSON.stringify(pay.body.reply_markup)).toContain("ke:show");
    const [me] = await db.select().from(players).where(eq(players.telegramId, 603));
    let [coach] = await db.select().from(coaches).where(eq(coaches.playerId, me.id));
    expect(coach.priceSingle).toBe(800);
    // "At the club" is one tap; the settings come up with it marked.
    calls = [];
    expect(await tap(26, olga, "ke:club:1")).toBe("coach:set:club");
    [coach] = await db.select().from(coaches).where(eq(coaches.playerId, me.id));
    expect(coach.payAtClub).toBe(true);
    expect(String(sent("editMessageText").at(-1)!.body.text)).toContain("PromptPay");
    // The PromptPay number from settings keeps working the same way, thirteen digits at most.
    calls = [];
    expect(await tap(27, olga, "kv:pp:0812345678:ok")).toBe("coach:set:pp");
    [coach] = await db.select().from(coaches).where(eq(coaches.playerId, me.id));
    expect(coach.promptpayId).toBe("0812345678");
    // A coach who already said how they are paid is not asked again after the price.
    calls = [];
    expect(await tap(28, olga, "kv:ps:900:ok")).toBe("coach:set:ps");
    expect(String(sent("editMessageText").at(-1)!.body.text)).toContain("PromptPay");
  });

  it("what a student owes comes as the coach's PromptPay QR with the sum in it, and 'I paid' works under the photo", async () => {
    const olga = await makePlayer(db, "Olga");
    const made = await createCoach(db, { playerId: olga.id, displayName: "Olga", clubNames: "Warehaus", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Bangkok" });
    const coach = await updateCoach(db, made.id, { priceSingle: 800, promptpayId: "0812345678" });
    const vera = user(604, "Vera");
    expect(await text(30, vera, "/start")).toBe("private_start");
    const [me] = await db.select().from(players).where(eq(players.telegramId, 604));
    await setStudentStatus(db, coach.id, me.id, "accepted");
    const inThreeDays = new Date(Math.floor((Date.now() + 3 * 24 * HOUR) / HOUR) * HOUR);
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: me.id, startsAt: inThreeDays, byCoach: true, source: "telegram", createdByPlayerId: olga.id });
    calls = [];
    expect(await text(31, vera, coachStrings("en").menuPay)).toBe("student:tap:pay_qr");
    const photo = sent("sendPhoto").at(-1)!;
    expect(String(photo.body.photo)).toContain(`/c/${coach.handle}/pay/owed/${me.id}`);
    expect(String(photo.body.caption)).toContain("800");
    expect(JSON.stringify(photo.body.reply_markup)).toContain(`lp:${lesson.id}`);
    expect(sent("sendMessage")).toHaveLength(0);
    // "I paid" under the photo: the claim goes through, the toast says so, and nothing tries to edit a caption as text.
    calls = [];
    expect(await tap(32, vera, `lp:${lesson.id}`, { photo: [{ file_id: "x" }] })).toBe("student:claim");
    expect(sent("answerCallbackQuery")).toHaveLength(1);
    expect(sent("editMessageText")).toHaveLength(0);
    // Claimed, nothing is due: the plain list, no picture.
    calls = [];
    expect(await text(33, vera, coachStrings("en").menuPay)).toBe("student:tap:pay");
    expect(sent("sendPhoto")).toHaveLength(0);
  });
});
