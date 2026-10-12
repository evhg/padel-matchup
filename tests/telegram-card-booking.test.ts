import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { clubs } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { setCourtBooked } from "@/lib/domain/courtBooked";
import { createEvent } from "@/lib/domain/events";
import { getEventByCode } from "@/lib/domain/queries";
import { joinEvent } from "@/lib/domain/slots";
import { handleTelegramUpdate, syncTelegram } from "@/lib/telegram/bot";
import { strings } from "@/lib/telegram/card";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer } from "./helpers/db";

/**
 * "Book this court" on the match card in a chat (DECIDING rule 36): the link the match page's button
 * opens (`prepareBooking`), as a URL button, so no link preview; only for a match still to come at a
 * vetted club, with no booking link of its own and no court booked yet.
 */

// Saturday 10 October 2026, noon in Bangkok; the match is on Tuesday the 13th at 19:00.
const NOW = new Date("2026-10-10T05:00:00Z");
freezeClock(NOW);
const TUESDAY_7PM = new Date("2026-10-13T12:00:00Z");

type Call = { method: string; body: Record<string, unknown> };
type Button = { text: string; url?: string; callback_data?: string };

describe("the match card carries \"Book this court\"", () => {
  let db: Db;
  let calls: Call[] = [];
  let messageId = 1;
  beforeAll(async () => {
    ({ db } = await createTestDb());
    // A club the directory lists, on Playtomic; and a club a player typed, whose links nobody vetted.
    await db.insert(clubs).values({ slug: "rawai-padel", name: "Rawai Padel", manageToken: "tok-rawai-card-abcdefghijklmnop", source: "directory", tz: "Asia/Bangkok", bookingUrl: "https://playtomic.com/clubs/rawai-padel", bookingPlatform: "playtomic" });
    await db.insert(clubs).values({ slug: "joes-court", name: "Joes Court", manageToken: "tok-joes-card-abcdefghijklmnop", source: "player", tz: "Asia/Bangkok", bookingUrl: "https://playtomic.com/clubs/joes-court" });
  });
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const method = String(url).split("/").pop()!;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push({ method, body });
        const result = method === "sendMessage" ? { message_id: 7000 + calls.length, chat: { id: body.chat_id } } : true;
        return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const chat = { id: -710001, type: "group" as const, title: "Padel friends" };
  const buttons = (c: Call) => ((c.body.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard ?? []).flat();
  async function cardOf(venueName: string) {
    const org = await makePlayer(db, "Olga");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: TUESDAY_7PM, tz: "Asia/Bangkok", venueName, whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    calls = [];
    await handleTelegramUpdate(db, { update_id: messageId, message: { message_id: messageId++, date: 0, chat, from: { id: 71, first_name: "Ana" }, text: `/match ${ev.code}` } }, NO_SIDE_EFFECTS);
    return { org, ev, card: calls.find((c) => c.method === "sendMessage")! };
  }

  it("at a vetted club: the club's own day page as a button, with no link preview, until a player booked the court", async () => {
    const { org, ev, card } = await cardOf("Rawai Padel");
    expect(ev.venueSlug).toBe("rawai-padel");
    const book = buttons(card).find((b) => b.text === strings("en").bookCourt);
    expect(book?.url).toBe("https://playtomic.com/clubs/rawai-padel?date=2026-10-13&sport=PADEL");
    expect(card.body.link_preview_options).toEqual({ is_disabled: true });
    expect(String(card.body.text)).not.toContain("playtomic");
    // Booked: the card is edited and the button is gone.
    await setCourtBooked(db, (await getEventByCode(db, ev.code))!, org.id, true, NOW);
    calls = [];
    await syncTelegram(db, ev.code, NOW);
    const edited = calls.find((c) => c.method === "editMessageText")!;
    expect(buttons(edited).some((b) => b.text === strings("en").bookCourt)).toBe(false);
  });

  it("never for a club nobody vetted, nor for a court nobody lists", async () => {
    for (const venue of ["Joes Court", "Somewhere New"]) {
      const { card } = await cardOf(venue);
      expect(buttons(card).some((b) => b.text === strings("en").bookCourt), venue).toBe(false);
    }
  });
});
