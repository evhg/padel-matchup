import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { players } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { playerForFeedKey } from "@/lib/calendarFeed";
import { createEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { handleTelegramUpdate } from "@/lib/telegram/bot";
import { bindDeepLink, readBindPayload } from "@/lib/telegram/deepLinks";
import { createTestDb, DAY, makePlayer } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * The match page's Telegram choice (the owner, 25 September 2026: capture a channel the moment a player
 * joins, and give something back). One tap opens the bot on the email's own `p_` link with the match's
 * code at the end; the answer to that /start is the match's card and the player's calendar.
 */
const NOW = new Date("2026-09-25T09:00:00.000Z");
freezeClock(NOW);

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
const user = (id: number, first_name: string) => ({ id, is_bot: false, first_name, username: `${first_name.toLowerCase()}_tg`, language_code: "en" });
type UrlButton = { text: string; url: string };

describe("Telegram from the match page", () => {
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

  const start = (id: number, from: ReturnType<typeof user>, payload: string) =>
    handleTelegramUpdate(db, { update_id: id, message: { message_id: id, date: 0, chat: { id: from.id, type: "private" }, from, text: `/start ${payload}` } }, NO_SIDE_EFFECTS);

  // One personal token per Hana: the tests share a database, and a token is unique.
  const tokens = ["Hn4kLm5nPq6r", "Hn4kLm5nPq7s", "Hn4kLm5nPq8t", "Hn4kLm5nPq9u"];
  async function hanaInAMatch() {
    const org = await makePlayer(db, "Org");
    const hana = await makePlayer(db, "Hana", { personalToken: tokens.shift() });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 2 * DAY), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: hana.id });
    return { hana, ev };
  }

  it("carries the match inside the start parameter Telegram allows, and reads both parts back", async () => {
    const { hana, ev } = await hanaInAMatch();
    const payload = new URL(bindDeepLink(hana, ev.code)!).searchParams.get("start")!;
    expect(payload.length).toBeLessThanOrEqual(64);
    expect(payload).toMatch(/^p_[A-Za-z0-9_-]+$/);
    expect(readBindPayload(payload.slice(2))).toEqual({ ticket: expect.stringMatching(/^[0-9a-f]{32}_[0-9a-z]+_[0-9a-f]{16}$/), code: ev.code });
    // The email's link has no code, and reads as it always did.
    const plain = new URL(bindDeepLink(hana)!).searchParams.get("start")!;
    expect(readBindPayload(plain.slice(2))).toEqual({ ticket: plain.slice(2), code: null });
  });

  it("links the web player, answers with that match's card and the calendar, and never sends the personal link", async () => {
    const { hana, ev } = await hanaInAMatch();
    const payload = new URL(bindDeepLink(hana, ev.code)!).searchParams.get("start")!;
    const tg = user(901, "Hana");
    expect(await start(1, tg, payload)).toBe("bind_match");

    const rows = await db.select().from(players).where(eq(players.telegramId, 901));
    expect(rows.map((r) => r.id)).toEqual([hana.id]);
    // The card of this match, in this chat.
    expect(sent("sendMessage").some((c) => String(c.body.text).includes("Rawai Padel"))).toBe(true);
    // One URL button to the calendar's page, whose key opens Hana's feed and nothing else.
    const withButton = sent("sendMessage").filter((c) => JSON.stringify(c.body.reply_markup ?? {}).includes("/calendar"));
    expect(withButton).toHaveLength(1);
    const button = (withButton[0].body.reply_markup as { inline_keyboard: UrlButton[][] }).inline_keyboard[0][0];
    expect(button.text).toBe("📅 Add to calendar");
    const key = /\/p\/([0-9a-f]{52})\/calendar$/.exec(button.url)?.[1];
    expect(key).toBeDefined();
    expect((await playerForFeedKey(db, key!))?.id).toBe(hana.id);
    // A message can be forwarded with its buttons: nothing in this answer is a way to sign in as Hana.
    expect(JSON.stringify(calls)).not.toContain(hana.personalToken!);
  });

  it("answers a second tap from the same account the same way, and refuses any other account", async () => {
    const { hana, ev } = await hanaInAMatch();
    const payload = new URL(bindDeepLink(hana, ev.code)!).searchParams.get("start")!;
    expect(await start(10, user(902, "Hana"), payload)).toBe("bind_match");
    calls = [];
    // Already bound to this account: the answer again, not "this link is too old".
    expect(await start(11, user(902, "Hana"), payload)).toBe("bind_match");
    expect(sent("sendMessage").some((c) => /too old/.test(String(c.body.text)))).toBe(false);
    // Somebody the link was forwarded to cannot take it.
    expect(await start(12, user(903, "Ivo"), payload)).toBe("bind_bad");
    const [still] = await db.select().from(players).where(eq(players.id, hana.id));
    expect(still.telegramId).toBe(902);
  });

  it("offers no feed to a player whose address already brings an invitation per match, so nothing lands twice", async () => {
    process.env.RESEND_API_KEY = "re_test_only";
    const { hana, ev } = await hanaInAMatch();
    await db.update(players).set({ email: "hana@example.com" }).where(eq(players.id, hana.id));
    const payload = new URL(bindDeepLink(hana, ev.code)!).searchParams.get("start")!;
    expect(await start(30, user(905, "Hana"), payload)).toBe("bind_match");
    expect(sent("sendMessage").some((c) => String(c.body.text).includes("Rawai Padel"))).toBe(true);
    expect(sent("sendMessage").filter((c) => JSON.stringify(c.body.reply_markup ?? {}).includes("/calendar"))).toHaveLength(0);
    delete process.env.RESEND_API_KEY;
  });

  it("refuses a forged ticket, whatever match it names", async () => {
    const { hana, ev } = await hanaInAMatch();
    const payload = new URL(bindDeepLink(hana, ev.code)!).searchParams.get("start")!;
    const { ticket } = readBindPayload(payload.slice(2));
    const forged = `p_${ticket.slice(0, -1)}${ticket.at(-1) === "0" ? "1" : "0"}_${ev.code}`;
    expect(await start(20, user(904, "Mallory"), forged)).toBe("bind_bad");
    const [untouched] = await db.select().from(players).where(eq(players.id, hana.id));
    expect(untouched.telegramId).toBeNull();
  });
});
