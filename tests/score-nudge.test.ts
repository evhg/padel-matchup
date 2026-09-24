import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, telegramCards, telegramChats } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { closeScoreNudges, nudgeForScore, scoreLine } from "@/lib/afterMatch";
import { baseUrl } from "@/lib/config";
import { createEvent } from "@/lib/domain/events";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { setEventPhoto } from "@/lib/domain/photos";
import { getEventByCode } from "@/lib/domain/queries";
import { saveMatchScore } from "@/lib/domain/scores";
import { joinEvent } from "@/lib/domain/slots";
import type { TgChat } from "@/lib/telegram/api";
import { handleTelegramUpdate } from "@/lib/telegram/bot";
import { miniAppNext, miniAppStart } from "@/lib/telegram/login";
import { freezeClock } from "./helpers/clock";
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
    // The picture is rendered once before Telegram asks for it, so a cold render cannot outlast the
    // send and leave a text fallback behind a picture Telegram delivered after all.
    const warmed = calls.findIndex((c) => c.method.startsWith("opengraph-image?v="));
    expect(warmed).toBeGreaterThanOrEqual(0);
    expect(warmed).toBeLessThan(calls.indexOf(waiting));
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

/**
 * Erik, 15 September, match 9wjp: three players seated, and every door in Telegram ended in a
 * sentence. The nudge's 🏁 said "the result needs four players in the line-up", and a bare "6-4 6-3"
 * in reply said "tap 🏁 on the card first", which only moves the question, because the chat's "who
 * won?" takes four. The web took the same score from three: in production two of the three scored
 * matches had three players, and both got their score there. Where the chat cannot finish the result
 * itself, the player's own chat now carries one button to that score form, signed in. The button is
 * the Mini App, never a personal link: the nudge is a picture a player may forward to the group, and a
 * forwarded message keeps its buttons. A group never gets it, because Telegram takes a web_app button
 * only in a private chat.
 */
describe("where the chat cannot finish the result, the score form is one tap away", () => {
  // The match starts at 09:00 UTC (16:00 in Bangkok); NOW is three hours later, when the nudge goes.
  const NOW = new Date("2026-09-15T12:00:00Z");
  freezeClock(NOW);
  let db: Db;
  beforeAll(async () => {
    ({ db } = await createTestDb());
  });
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    // The Mini App follows from nothing: off unless a test creates it.
    delete process.env.TELEGRAM_MINIAPP_SLUG;
    stub();
  });

  /** `count` players in a match that started three hours before NOW; the first organises it and is on Telegram as `chatId`. */
  const seated = async (tag: string, chatId: number, count: number) => {
    const people: Awaited<ReturnType<typeof makePlayer>>[] = [];
    for (let i = 0; i < count; i++) people.push(await makePlayer(db, `P${i} ${tag}`));
    const [organiser] = people;
    await db.update(players).set({ telegramId: chatId }).where(eq(players.id, organiser.id));
    await db.insert(telegramChats).values({ chatId, type: "private", locale: "en" }).onConflictDoNothing();
    const ev = await createEvent(db, { creatorPlayerId: organiser.id, type: "match", startsAt: new Date(NOW.getTime() + HOUR), tz: "Asia/Bangkok", whenFull: "closed" });
    for (const p of people) await joinEvent(db, { eventId: ev.id, playerId: p.id });
    const [past] = await db.update(events).set({ startsAt: new Date(NOW.getTime() - 3 * HOUR), status: "past" }).where(eq(events.id, ev.id)).returning();
    return { past, organiser };
  };
  type Button = { text: string; url?: string; callback_data?: string; web_app?: { url: string } };
  const buttonsOf = (c: Call) => (c.body.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard[0];
  /** Without the Mini App in BotFather: a web_app button on the `/tg` shell, which signs in from initData. */
  const formApp = (code: string): Button => ({ text: "\u{1F3C1} Result", web_app: { url: `${baseUrl()}/tg?startapp=r_${code}` } });
  /** A personal link is `/p/<token>`: it signs in whoever holds it, so no button of these may carry one. */
  const PERSONAL_LINK = "/p/";
  const PERSONAL = /\/p\/|#score|startapp/;

  it("three seated: the nudge's 🏁 opens the score form, signed in, instead of the r: tap", async () => {
    const { past } = await seated("a", 9101, 3);
    await nudgeForScore(db, past);
    const buttons = buttonsOf(sent("sendPhoto").at(-1)!);
    expect(buttons[0]).toEqual(formApp(past.code));
    expect(JSON.stringify(buttons)).not.toContain(`r:${past.code}`);
    // The picture is the one a player forwards to the crew's group while it waits for a score, and its
    // buttons go with it: nothing in it signs anybody in as the organiser.
    expect(JSON.stringify(calls)).not.toContain(PERSONAL_LINK);
    // The shell hands the unsigned start parameter on, and the sign-in turns it into the score form.
    expect(miniAppNext(miniAppStart(undefined, new URL(buttons[0].web_app!.url).search))).toBe(`/${past.code}#score`);
    // "We didn't play" is still the organiser's, and still a tap.
    expect(buttons[1]).toEqual({ text: "We didn't play", callback_data: `x:${past.code}` });
  });

  it("with the Mini App created, the button carries no secret and still lands on the score form", async () => {
    process.env.TELEGRAM_BOT_USERNAME = "kicksmash_bot";
    process.env.TELEGRAM_MINIAPP_SLUG = "app";
    const { past, organiser } = await seated("b", 9102, 3);
    await nudgeForScore(db, past);
    const [button] = buttonsOf(sent("sendPhoto").at(-1)!);
    expect(button).toEqual({ text: "\u{1F3C1} Result", url: `https://t.me/kicksmash_bot/app?startapp=r_${past.code}` });
    // A forwarded message takes its buttons with it. This one signs in whoever opens it, from
    // Telegram's own initData, so nothing in it is the organiser's.
    expect(button.url).not.toContain(await getOrCreatePersonalToken(db, organiser.id));
    // The Mini App's sign-in hands that start parameter on to the match page's score form.
    expect(miniAppNext(`r_${past.code}`)).toBe(`/${past.code}#score`);
  });

  it("four seated: the 🏁 stays the chat's own who-won", async () => {
    const { past } = await seated("c", 9103, 4);
    await nudgeForScore(db, past);
    const [button] = buttonsOf(sent("sendPhoto").at(-1)!);
    expect(button).toEqual({ text: "\u{1F3C1} Result", callback_data: `r:${past.code}` });
  });

  it("a bare score in reply to the nudge, with the pairs unknown, answers with the form in the player's own chat", async () => {
    const { past } = await seated("d", 9104, 3);
    await nudgeForScore(db, past);
    const [nudge] = await db.select().from(telegramCards).where(eq(telegramCards.eventId, past.id));
    const chat: TgChat = { id: 9104, type: "private" };
    calls = [];
    const outcome = await handleTelegramUpdate(db, { update_id: 3, message: { message_id: 20, date: 0, chat, from: { id: 9104, first_name: "P0", language_code: "en" }, text: "6-4 6-3", reply_to_message: { message_id: nudge.messageId, date: 0, chat } } }, NO_SIDE_EFFECTS);
    expect(outcome).toBe("score_no_teams");
    const answer = sent("sendMessage").at(-1)!;
    expect(answer.body.chat_id).toBe(9104);
    expect(String(answer.body.text)).toContain("I don't know the pairs yet");
    expect(answer.body.reply_markup).toEqual({ inline_keyboard: [[formApp(past.code)]] });
    expect(JSON.stringify(calls)).not.toContain(PERSONAL_LINK);
  });

  it("the same reply in a group gets the sentence alone, with no personal link", async () => {
    const { past } = await seated("e", 9105, 3);
    const group: TgChat = { id: -1009105, type: "supergroup", title: "Crew" };
    await db.insert(telegramChats).values({ chatId: group.id, type: group.type, title: group.title, locale: "en" });
    await db.insert(telegramCards).values({ eventId: past.id, chatId: group.id, messageId: 70, kind: "card" });
    calls = [];
    const outcome = await handleTelegramUpdate(db, { update_id: 4, message: { message_id: 71, date: 0, chat: group, from: { id: 9105, first_name: "P0", language_code: "en" }, text: "6-4 6-3", reply_to_message: { message_id: 70, date: 0, chat: group } } }, NO_SIDE_EFFECTS);
    expect(outcome).toBe("score_no_teams");
    const answer = sent("sendMessage").at(-1)!;
    expect(answer.body.chat_id).toBe(group.id);
    expect(String(answer.body.text)).toContain("Tap \u{1F3C1} Result on the card first");
    expect(answer.body.reply_markup).toBeUndefined();
    expect(JSON.stringify(calls)).not.toMatch(PERSONAL);
  });

  it("a 🏁 tap the chat cannot answer: the form in the player's own chat, the alert alone in a group", async () => {
    const { past } = await seated("f", 9106, 3);
    const tap = (chat: TgChat) =>
      handleTelegramUpdate(db, { update_id: 5, callback_query: { id: "cb", from: { id: 9106, first_name: "P0", language_code: "en" }, message: { message_id: 30, date: 0, chat }, data: `r:${past.code}` } }, NO_SIDE_EFFECTS);

    calls = [];
    expect(await tap({ id: 9106, type: "private" })).toBe("result:need_four");
    const form = sent("sendMessage").at(-1)!;
    expect(form.body.reply_parameters).toMatchObject({ message_id: 30 });
    expect(String(form.body.text)).toContain("The match page takes any line-up");
    expect(form.body.reply_markup).toEqual({ inline_keyboard: [[formApp(past.code)]] });
    expect(JSON.stringify(calls)).not.toContain(PERSONAL_LINK);
    // The message is the answer; an alert on top of it would be one more thing to dismiss.
    expect(sent("answerCallbackQuery").at(-1)!.body.text).toBeUndefined();

    const group: TgChat = { id: -1009106, type: "supergroup" };
    await db.insert(telegramChats).values({ chatId: group.id, type: group.type, locale: "en" });
    calls = [];
    expect(await tap(group)).toBe("result:need_four");
    expect(sent("sendMessage")).toHaveLength(0);
    expect(String(sent("answerCallbackQuery").at(-1)!.body.text)).toContain("needs four players");
    expect(JSON.stringify(calls)).not.toMatch(PERSONAL);
  });
});
