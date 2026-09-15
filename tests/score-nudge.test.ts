import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, telegramCards, telegramChats } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { closeScoreNudges, nudgeForScore, scoreLine } from "@/lib/afterMatch";
import { createEvent } from "@/lib/domain/events";
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
const stub = () => {
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

  it("edits the nudge in place, says who answered and with what, and takes the button away", async () => {
    const { past, erik, micky } = await played("a", 9001);
    const nudged = await nudgeForScore(db, past);
    expect(nudged.telegram).toBe(1);
    const [row] = await db.select().from(telegramCards).where(eq(telegramCards.eventId, past.id));
    expect(row.kind).toBe("nudge");

    // Nothing to close while the question is unanswered: a quiet bot does not edit for no reason.
    expect(await closeScoreNudges(db, past.code)).toBe(0);

    await saveMatchScore(db, { eventId: past.id, playerId: micky.id, isCreator: false, sets: [{ setNumber: 1, sideA: 6, sideB: 1 }] });
    calls = [];
    expect(await closeScoreNudges(db, past.code)).toBe(1);
    const edit = sent("editMessageText").at(-1)!;
    expect(edit.body.chat_id).toBe(9001);
    expect(edit.body.message_id).toBe(row.messageId);
    expect(String(edit.body.text)).toContain("Micky a");
    expect(String(edit.body.text)).toContain("6-1");
    // The button is what a player taps into a dead end, so it goes.
    expect((edit.body.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([]);
    void erik;
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
