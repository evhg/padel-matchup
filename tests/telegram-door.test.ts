import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { competitionPairs, demandSignals, players } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { createCoach, inviteCode, presetHours, studentStatus } from "@/lib/domain/coaching";
import { addCategory, createCompetition, enterPair } from "@/lib/domain/competitions";
import { layout, telegramLine } from "@/lib/email/templates";
import { handleTelegramUpdate } from "@/lib/telegram/bot";
import { bindDeepLink, claimDeepLink, studentDeepLink } from "@/lib/telegram/deepLinks";
import { playerMenuWord } from "@/lib/telegram/player";
import { createTestDb, makePlayer } from "./helpers/db";

/**
 * The player's side of the bot as buttons: the keyboard under the text field, the games list
 * and the want request as taps, and the three deep links that bring people in with one tap.
 */

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
      const result = method === "sendMessage" ? { message_id: nextMessageId++, chat: { id: body.chat_id } } : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}
const sent = (method: string) => calls.filter((c) => c.method === method);
const last = () => sent("sendMessage").at(-1)!;
const user = (id: number, first_name: string, language_code = "en") => ({ id, first_name, username: `${first_name.toLowerCase()}_tg`, language_code });

describe("the player's door", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
    process.env.TELEGRAM_WEBHOOK_SECRET = "hooksecret";
    process.env.TELEGRAM_BOT_USERNAME = "kicksmash_bot";
    stubTelegram();
  });
  afterEach(() => vi.unstubAllGlobals());

  const dmOf = (id: number) => ({ id, type: "private" as const });
  const text = (id: number, from: ReturnType<typeof user>, t: string) => handleTelegramUpdate(db, { update_id: id, message: { message_id: id, date: 0, chat: dmOf(from.id), from, text: t } }, NO_SIDE_EFFECTS);
  const tap = (id: number, from: ReturnType<typeof user>, data: string) => handleTelegramUpdate(db, { update_id: id, callback_query: { id: `cb${id}`, from, message: { message_id: 5, date: 0, chat: dmOf(from.id) }, data } }, NO_SIDE_EFFECTS);

  it("a label in either language is a door; ordinary text is not", () => {
    expect(playerMenuWord("🔎 Find a match")).toBe("find");
    expect(playerMenuWord("Найти матч")).toBe("find");
    expect(playerMenuWord("🕒 When I want to play")).toBe("want");
    expect(playerMenuWord("my matches")).toBe("mine");
    expect(playerMenuWord("hello?")).toBeNull();
    expect(playerMenuWord("")).toBeNull();
  });

  it("/start gives a plain player the keyboard and the commands; the games list asks for the city with buttons, then lists; My matches is only theirs", async () => {
    const ana = user(501, "Ana");
    expect(await text(1, ana, "/start")).toBe("private_start");
    const menu = last();
    expect(JSON.stringify(menu.body.reply_markup)).toContain("Find a match");
    expect(JSON.stringify(menu.body.reply_markup)).toContain("When I want to play");
    expect((sent("setMyCommands").at(-1)!.body.commands as { command: string }[]).map((c) => c.command)).toEqual(["games", "new", "want", "tournaments", "coach", "help"]);
    // No city known for this chat yet: the cities as buttons.
    calls = [];
    expect(await text(2, ana, "🔎 Find a match")).toBe("player:find:city");
    expect(JSON.stringify(last().body.reply_markup)).toContain("pg:phuket");
    calls = [];
    expect(await tap(3, ana, "pg:phuket")).toBe("games:0+0");
    expect(String(last().body.text)).toContain("Phuket");
    expect(sent("answerCallbackQuery")).toHaveLength(1);
    calls = [];
    expect(await text(4, ana, "📅 My matches")).toBe("games:0+0");
    expect(String(last().body.text)).toContain("No upcoming matches");
    // Help repeats the keyboard; the unknown city slug is refused quietly.
    calls = [];
    expect(await text(5, ana, "❓ Help")).toBe("player:help");
    expect(JSON.stringify(last().body.reply_markup)).toContain("Find a match");
    expect(await tap(6, ana, "pg:atlantis")).toBe("player:find:unknown_city");
  });

  it("when I want to play: a day, an hour and a place as taps, and the want is on record", async () => {
    const ben = user(502, "Ben");
    expect(await text(10, ben, "/start")).toBe("private_start");
    calls = [];
    expect(await text(11, ben, "🕒 When I want to play")).toBe("player:want:day");
    expect(JSON.stringify(last().body.reply_markup)).toContain("pw:d:x");
    expect(JSON.stringify(last().body.reply_markup)).toContain("pw:d:2");
    calls = [];
    expect(await tap(12, ben, "pw:d:2")).toBe("player:want:hour");
    expect(JSON.stringify(last().body.reply_markup)).toContain("pw:t:2:15");
    calls = [];
    expect(await tap(13, ben, "pw:t:2:15")).toBe("player:want:place");
    expect(JSON.stringify(last().body.reply_markup)).toContain("pw:p:2:15:c:phuket");
    calls = [];
    expect(await tap(14, ben, "pw:p:2:15:c:phuket")).toBe("player:want:saved");
    expect(String(last().body.text)).toContain("15:00–17:00");
    const [me] = await db.select().from(players).where(eq(players.telegramId, 502));
    const rows = await db.select().from(demandSignals).where(eq(demandSignals.playerId, me.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ weekday: 2, fromTime: "15:00", toTime: "17:00", citySlug: "phuket", venueSlug: null });
    // Any day, any time, is a want too.
    calls = [];
    expect(await tap(15, ben, "pw:p:x:x:c:phuket")).toBe("player:want:saved");
    expect(String(last().body.text)).toContain("Any day");
    expect(await db.select().from(demandSignals).where(eq(demandSignals.playerId, me.id))).toHaveLength(2);
    expect(await tap(16, ben, "pw:p:x:x:c:nowhere")).toBe("player:want:unknown_place");
  });

  it("a coach's student invite as a deep link: one tap and the student is on the list with the student's menu; a stale code is refused", async () => {
    const olga = await makePlayer(db, "Olga");
    const coach = await createCoach(db, { playerId: olga.id, displayName: "Olga", clubNames: "Warehaus", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Bangkok" });
    const code = await inviteCode(db, coach);
    const link = studentDeepLink(code)!;
    expect(link).toBe(`https://t.me/kicksmash_bot?start=s_${code}`);
    const vera = user(503, "Vera");
    expect(await text(20, vera, `/start ${new URL(link).searchParams.get("start")}`)).toBe("student_joined");
    const [me] = await db.select().from(players).where(eq(players.telegramId, 503));
    expect(await studentStatus(db, coach.id, me.id)).toBe("accepted");
    expect(String(sent("sendMessage")[0].body.text)).toContain("Olga");
    expect(JSON.stringify(sent("sendMessage").at(-1)!.body.reply_markup)).toContain("My lessons");
    calls = [];
    expect(await text(21, user(504, "Nick"), "/start s_nosuchcode1")).toBe("student_link_bad");
    expect(String(last().body.text)).toMatch(/not valid/);
  });

  it("a tournament partner's claim as a deep link: the placeholder becomes the tapper; a used link is refused", async () => {
    const org = await makePlayer(db, "Org");
    const c = await createCompetition(db, { organizerPlayerId: org.id, name: "Door Open", tz: "Asia/Bangkok", startsOn: "2026-12-10" });
    const cat = await addCategory(db, { competitionId: c.id, organizerPlayerId: org.id, name: "Mixed", maxPairs: 8 });
    const cal = await makePlayer(db, "Cal");
    const e = await enterPair(db, { categoryId: cat.id, playerId: cal.id, partner: { name: "Dana" }, locale: "en" });
    const link = claimDeepLink(e.claimToken!)!;
    expect(link).toBe(`https://t.me/kicksmash_bot?start=claim_${e.claimToken}`);
    const dana = user(505, "Dana");
    expect(await text(30, dana, `/start claim_${e.claimToken}`)).toBe("claim_done");
    expect(String(sent("sendMessage")[0].body.text)).toContain("Mixed");
    expect(String(sent("sendMessage")[0].body.text)).toContain("Cal");
    expect(JSON.stringify(last().body.reply_markup)).toContain("Find a match");
    const [me] = await db.select().from(players).where(eq(players.telegramId, 505));
    const [pair] = await db.select().from(competitionPairs).where(eq(competitionPairs.id, e.pair.id));
    expect(pair.p2PlayerId).toBe(me.id);
    expect(pair.claimToken).toBeNull();
    calls = [];
    expect(await text(31, user(506, "Eve"), `/start claim_${e.claimToken}`)).toBe("claim_bad");
  });

  it("the email's Telegram line: only for a player without Telegram, only when the bot has a username; the tap binds the account, a forged or stale ticket does not", async () => {
    const finn = await makePlayer(db, "Finn", { email: "finn@example.com" });
    const line = telegramLine("Get this on Telegram", finn)!;
    expect(line.url).toMatch(/^https:\/\/t\.me\/kicksmash_bot\?start=p_/);
    expect(bindDeepLink(finn)).toBe(line.url);
    expect(telegramLine("x", { ...finn, telegramId: 7 })).toBeUndefined();
    expect(telegramLine("x", null)).toBeUndefined();
    const { html, text: plain } = layout({ heading: "H", body: "B", footer: "F", eventUrl: "https://kicksma.sh/x", openLabel: "Open", telegram: line });
    expect(html).toContain(`href="${line.url}"`);
    expect(plain).toContain(`Get this on Telegram: ${line.url}`);
    expect(layout({ heading: "H", body: "B", footer: "F", eventUrl: "https://kicksma.sh/x", openLabel: "Open" }).html).not.toContain("t.me");
    delete process.env.TELEGRAM_BOT_USERNAME;
    expect(telegramLine("x", finn)).toBeUndefined();
    process.env.TELEGRAM_BOT_USERNAME = "kicksmash_bot";
    // The tap: this Telegram account is Finn from now on.
    const payload = new URL(line.url).searchParams.get("start")!;
    const tg = user(507, "Finn");
    expect(await text(40, tg, `/start ${payload}`)).toBe("bind_done");
    const [bound] = await db.select().from(players).where(eq(players.id, finn.id));
    expect(bound.telegramId).toBe(507);
    expect(String(sent("sendMessage")[0].body.text)).toContain("Telegram is on");
    expect(JSON.stringify(last().body.reply_markup)).toContain("Find a match");
    // Bound, the same ticket is stale (it was minted for the unbound player); a second account cannot take it either.
    calls = [];
    expect(await text(41, user(508, "Gus"), `/start ${payload}`)).toBe("bind_bad");
    expect(String(sent("sendMessage")[0].body.text)).toMatch(/too old/);
    expect(await text(42, tg, "/start p_garbage")).toBe("bind_bad");
  });
});
