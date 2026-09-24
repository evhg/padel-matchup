import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, telegramCards, telegramChats } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { closeScoreNudges, nudgeForScore, scoreLine } from "@/lib/afterMatch";
import { createEvent } from "@/lib/domain/events";
import { setEventPhoto } from "@/lib/domain/photos";
import { getEventByCode } from "@/lib/domain/queries";
import { saveMatchScore } from "@/lib/domain/scores";
import { joinEvent } from "@/lib/domain/slots";
import { handleTelegramUpdate } from "@/lib/telegram/bot";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

/**
 * Eriik, 15 September: after the match the bot asked him "how did it go?" with a 🏁 button. Micky had
 * already put the score in on the web an hour before. Tapping the button answered "The result needs
 * four players in the line-up" — which was about the seats, said nothing about the score, and left
 * him with a live button that could never do anything.
 *
 * Two things were wrong and both are here. The nudge was never closed when an answer arrived from
 * another screen, and a tap on it was judged by the line-up before anyone asked whether the question
 * had already been answered.
 */
const TOKEN = "123456:TESTTOKEN";
type Call = { method: string; body: Record<string, unknown> };
let calls: Call[] = [];
let nextMessageId = 500;
/** Methods Telegram refuses in this test, as it refuses a photo URL it cannot fetch. */
let refused = new Set<string>();
const stub = () => {
  calls = [];
  refused = new Set();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      if (refused.has(method)) return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: wrong file identifier/HTTP URL specified" }), { status: 400, headers: { "content-type": "application/json" } });
      const result = method === "sendMessage" || method === "sendPhoto" ? { message_id: nextMessageId++, chat: { id: body.chat_id } } : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
};
const sent = (method: string) => calls.filter((c) => c.method === method);

describe("the nudge is closed by whoever answers it", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    stub();
  });

  /** The real shape of match 9wjp: three players seated, the fourth seat empty, a score from the web. */
  const played = async (tag: string, chatId: number) => {
    const erik = await makePlayer(db, `Erik ${tag}`);
    const jakob = await makePlayer(db, `Jakob ${tag}`);
    const micky = await makePlayer(db, `Micky ${tag}`);
    await db.update(players).set({ telegramId: chatId }).where(eq(players.id, erik.id));
    await db.insert(telegramChats).values({ chatId, type: "private", locale: "en" }).onConflictDoNothing();
    const ev = await createEvent(db, { creatorPlayerId: erik.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "Asia/Bangkok", whenFull: "closed" });
    for (const p of [erik, jakob, micky]) await joinEvent(db, { eventId: ev.id, playerId: p.id });
    const [past] = await db.update(events).set({ startsAt: new Date(Date.now() - 3 * HOUR), status: "past" }).where(eq(events.id, ev.id)).returning();
    return { past, erik, micky };
  };

  /**
   * The owner, 24 September: "when one of the players enters the result, the score nudge received by
   * all the other players changes into a result card. Changing is not an additional message." Telegram
   * turns a photo into another photo, never text into a photo, so the nudge is the card still waiting
   * for its score, and the answer swaps its picture.
   */
  it("sends the nudge as the card waiting for its score, and turns that same message into the result", async () => {
    const { past, erik, micky } = await played("a", 9001);
    const nudged = await nudgeForScore(db, past);
    expect(nudged.telegram).toBe(1);
    expect(sent("sendMessage")).toHaveLength(0);
    const waiting = sent("sendPhoto").at(-1)!;
    expect(String(waiting.body.photo)).toContain(`/${past.code}/card/opengraph-image?v=`);
    expect(String(waiting.body.caption)).toContain("how did it go?");
    expect(waiting.body.disable_notification).toBe(true);
    const [row] = await db.select().from(telegramCards).where(eq(telegramCards.eventId, past.id));
    expect(row.kind).toBe("nudge");
    expect(row.rendered).toBeTruthy();

    // Nothing to close while the question is unanswered: a quiet bot does not edit for no reason.
    expect(await closeScoreNudges(db, past.code)).toBe(0);

    await saveMatchScore(db, { eventId: past.id, playerId: micky.id, isCreator: false, sets: [{ setNumber: 1, sideA: 6, sideB: 1 }] });
    calls = [];
    expect(await closeScoreNudges(db, past.code)).toBe(1);
    // An edit of the message the player already has; nothing new arrives in the chat.
    expect(sent("sendMessage").length + sent("sendPhoto").length).toBe(0);
    const edit = sent("editMessageMedia").at(-1)!;
    expect(edit.body.chat_id).toBe(9001);
    expect(edit.body.message_id).toBe(row.messageId);
    const media = edit.body.media as { type: string; media: string; caption: string };
    expect(media.type).toBe("photo");
    expect(media.media).toContain(`/${past.code}/card/opengraph-image?v=`);
    expect(media.media, "the result is a new version of the picture, so no cache serves the waiting one").not.toBe(waiting.body.photo);
    expect(media.caption).toContain("6-1");
    expect(media.caption).toContain("Entered by Micky a");
    // The 🏁 and "We didn't play" buttons are what a player taps into a dead end, so they go; the one
    // left leads to the card's page, where the court photo goes on and the picture goes to WhatsApp.
    expect(edit.body.reply_markup).toEqual({ inline_keyboard: [[{ text: "📸 Photo & share", url: expect.stringContaining(`/${past.code}/card`) }]] });

    // Asked again with nothing changed, it stays quiet.
    calls = [];
    expect(await closeScoreNudges(db, past.code)).toBe(0);
    expect(calls).toHaveLength(0);

    // A court photo is a new picture: the same message takes it.
    await setEventPhoto(db, { eventId: past.id, playerId: erik.id, mime: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGNgYGD4z8DAwAAABAAC/wKzCgAAAABJRU5ErkJggg==" });
    expect(await closeScoreNudges(db, past.code)).toBe(1);
    const withPhoto = sent("editMessageMedia").at(-1)!;
    expect(withPhoto.body.message_id).toBe(row.messageId);
    expect((withPhoto.body.media as { media: string }).media).toMatch(/\?v=[^&]+-p/);
  });

  it("keeps one nudge per chat: the morning's replaces the evening's, and the answer turns that one", async () => {
    const { past, micky } = await played("g", 9007);
    await nudgeForScore(db, past);
    const [first] = await db.select().from(telegramCards).where(eq(telegramCards.eventId, past.id));
    calls = [];
    await nudgeForScore(db, past);
    const rows = await db.select().from(telegramCards).where(eq(telegramCards.eventId, past.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).not.toBe(first.messageId);
    // The evening's question goes, so no live 🏁 is left beside the card that becomes the result.
    expect(sent("deleteMessage").map((c) => c.body)).toEqual([{ chat_id: 9007, message_id: first.messageId }]);
    await saveMatchScore(db, { eventId: past.id, playerId: micky.id, isCreator: false, sets: [{ setNumber: 1, sideA: 6, sideB: 2 }] });
    calls = [];
    expect(await closeScoreNudges(db, past.code)).toBe(1);
    expect(sent("editMessageMedia").at(-1)!.body.message_id).toBe(rows[0].messageId);
  });

  it("falls back to the text nudge when Telegram cannot fetch the picture, and closes it as text", async () => {
    const { past, micky } = await played("h", 9008);
    refused.add("sendPhoto");
    expect((await nudgeForScore(db, past)).telegram).toBe(1);
    expect(String(sent("sendMessage").at(-1)!.body.text)).toContain("how did it go?");
    const [row] = await db.select().from(telegramCards).where(eq(telegramCards.eventId, past.id));
    expect(row.rendered).toBeNull();
    await saveMatchScore(db, { eventId: past.id, playerId: micky.id, isCreator: false, sets: [{ setNumber: 1, sideA: 6, sideB: 1 }] });
    calls = [];
    expect(await closeScoreNudges(db, past.code)).toBe(1);
    expect(sent("editMessageMedia")).toHaveLength(0);
    const edit = sent("editMessageText").at(-1)!;
    expect(edit.body.message_id).toBe(row.messageId);
    expect(String(edit.body.text)).toContain("Micky h");
    expect(String(edit.body.text)).toContain("6-1");
    expect((edit.body.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([]);
  });

  /**
   * Eriik, 22 September: "after the reminder to enter results, add an option to tap Cancelled
   * instead." A match that never happened has no score, so the nudge asks a question nobody can
   * answer. Only the organiser gets the button: cancelling is theirs on every other screen.
   */
  it("offers the organiser a way to say the match never happened, and nobody else", async () => {
    const { past, micky } = await played("e", 9005);
    await db.update(players).set({ telegramId: 9105 }).where(eq(players.id, micky.id));
    await db.insert(telegramChats).values({ chatId: 9105, type: "private", locale: "en" }).onConflictDoNothing();
    calls = [];
    await nudgeForScore(db, past);
    const keys = (chatId: number) => {
      const c = sent("sendPhoto").find((x) => x.body.chat_id === chatId)!;
      return ((c.body.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard[0] ?? []).map((b) => b.text);
    };
    expect(keys(9005)).toEqual(["\u{1F3C1} Result", "We didn't play"]);
    expect(keys(9105)).toEqual(["\u{1F3C1} Result"]);
  });

  it("the organiser's tap cancels the match, and a player's tap is refused", async () => {
    const { past, micky } = await played("f", 9006);
    await db.update(players).set({ telegramId: 9106 }).where(eq(players.id, micky.id));
    await db.insert(telegramChats).values({ chatId: 9106, type: "private", locale: "en" }).onConflictDoNothing();
    // The nudge is a picture, and a picture's words are its caption: editMessageText would be refused.
    const tap = (chatId: number) =>
      handleTelegramUpdate(
        db,
        { update_id: 2, callback_query: { id: "cb", from: { id: chatId, first_name: "X", language_code: "en" }, message: { message_id: 1, date: 0, chat: { id: chatId, type: "private" }, photo: [{ file_id: "card" }], caption: "how did it go?" }, data: `x:${past.code}` } },
        NO_SIDE_EFFECTS,
      );

    calls = [];
    expect(await tap(9106)).toBe("cancel_not_organizer");
    expect(String(sent("answerCallbackQuery").at(-1)!.body.text)).toContain("Only the organizer");
    const [untouched] = await db.select().from(events).where(eq(events.id, past.id));
    expect(untouched.status).toBe("past");

    calls = [];
    expect(await tap(9006)).toBe(`cancelled:${past.code}`);
    const [closed] = await db.select().from(events).where(eq(events.id, past.id));
    expect(closed.status).toBe("cancelled");
    // Eriik, 22 September: "when I clicke We didn't play the button doesn't change it remains there."
    // The toast is gone in two seconds and the message it came from still offered both buttons, so
    // the tap read as if nothing had happened. The nudge itself says what it did, and keeps no button.
    expect(sent("editMessageText")).toHaveLength(0);
    const edited = sent("editMessageCaption").at(-1);
    expect(edited, "the nudge answers on the screen").toBeTruthy();
    expect(edited!.body.message_id).toBe(1);
    expect(String(edited!.body.caption)).toContain("marked as not played");
    expect(edited!.body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("tells a tap what actually happened instead of talking about the line-up", async () => {
    const { past, erik, micky } = await played("b", 9002);
    await saveMatchScore(db, { eventId: past.id, playerId: micky.id, isCreator: false, sets: [{ setNumber: 1, sideA: 6, sideB: 1 }, { setNumber: 2, sideA: 6, sideB: 7 }] });
    calls = [];
    const outcome = await handleTelegramUpdate(
      db,
      { update_id: 1, callback_query: { id: "cb1", from: { id: 9002, first_name: "Erik", language_code: "en" }, message: { message_id: 1, date: 0, chat: { id: 9002, type: "private" } }, data: `r:${past.code}` } },
      NO_SIDE_EFFECTS,
    );
    expect(outcome).toBe("result:already");
    const answered = sent("answerCallbackQuery").at(-1)!;
    const text = String(answered.body.text);
    expect(text).toContain("already added the score");
    expect(text).toContain("6-1 6-7");
    // The sentence he actually got, about a line-up he could do nothing about, is not said any more.
    expect(text).not.toContain("four players");
    void erik;
  });

  it("names the score even when nobody is recorded as having entered it", async () => {
    const { past, micky } = await played("c", 9003);
    await saveMatchScore(db, { eventId: past.id, playerId: micky.id, isCreator: false, sets: [{ setNumber: 1, sideA: 6, sideB: 4 }] });
    const detail = (await getEventByCode(db, past.code))!;
    expect(scoreLine(detail)).toMatchObject({ score: "6-4" });
    expect(scoreLine(detail)?.who).toContain("Micky");
    // A match with no score has no line, so nothing is ever said about one.
    const { past: quiet } = await played("d", 9004);
    expect(scoreLine((await getEventByCode(db, quiet.code))!)).toBeNull();
  });
});
