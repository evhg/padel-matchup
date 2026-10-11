import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, events, metricsDaily, players, slots, telegramCards, telegramChats, venues } from "@/db/schema";
import { dayKey } from "@/lib/domain/metrics";
import { LIMITS } from "@/lib/domain/ratelimit";
import type { OpContext } from "@/lib/api/operations";
import { zonedTimeToUtc } from "@/lib/dates";
import { handleTelegramUpdate } from "@/lib/telegram/bot";
import { strings } from "@/lib/telegram/card";
import { pasteSummary } from "@/lib/telegram/handlers/paste";
import type { TgMessage, TgUpdate } from "@/lib/telegram/api";
import { freezeClock } from "./helpers/clock";
import { createTestDb } from "./helpers/db";

/**
 * "Paste your booking" in the bot's private chat (src/lib/telegram/handlers/paste.ts). Cath booked a
 * court at WAREHAUS.club in The Padel Society's app and pastes what it gave her; the bot answers with
 * what it read and "Create match"; the tap makes the match with Danny and Alberto held and the court
 * booked by her, and turns the answer into the match's link. Every Bot API call is stubbed and read
 * back from `calls`; the platform's link answers with the synthetic Branch page (match 12345, a
 * made-up click id), never a live request.
 *
 * NOW is Sunday 11 October 2026, 05:00 UTC, 12:00 in Phuket. "Mon 12 Oct" is Monday 12 October, 18:00
 * to 19:30 in the club's zone (Asia/Bangkok), which is 11:00 to 12:30 UTC.
 */
const NOW = new Date("2026-10-11T05:00:00Z");
freezeClock(NOW);
const TZ = "Asia/Bangkok";
const LINK = "https://thepadelsociety.app.link/AbCdEf12345";
const OWNER_TEXT = `Warehaus Mon 12 Oct 18:00-19:30 court 3 with Danny, Alberto ${LINK}`;
const BRANCH_PAGE = readFileSync(path.join(import.meta.dirname, "fixtures/paste/branch-preview.html"), "utf8");
const BOT = { id: 123456, is_bot: true, first_name: "Kicksmash" };
const en = strings("en");

type Call = { method: string; body: Record<string, unknown> };
let calls: Call[] = [];
/** Every request that was not the Bot API: the one read of a pasted link, at most. */
let outside: string[] = [];
/** What a platform's link answers: the synthetic Branch page unless a test says otherwise. */
let platformPage = BRANCH_PAGE;
let nextMessageId = 5000;

function stubFetch() {
  calls = [];
  outside = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (!u.startsWith("https://api.telegram.org/")) {
        outside.push(u);
        return new Response(platformPage, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const method = u.split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
      if (method === "sendMessage" || method === "sendPhoto") return reply({ message_id: nextMessageId++, chat: { id: body.chat_id } });
      return reply(true);
    }),
  );
}
const sent = (method: string) => calls.filter((c) => c.method === method);
const buttonsOf = (c: Call | undefined) => ((c?.body.reply_markup as { inline_keyboard?: { text: string; callback_data?: string; url?: string }[][] } | undefined)?.inline_keyboard ?? []).flat();
const user = (id: number, first_name: string) => ({ id, first_name, language_code: "en" });
const cath = user(7001, "Cath");
const nok = user(7002, "Nok");
const dm = (u: { id: number }) => ({ id: u.id, type: "private" as const });

describe("a booking pasted in the private chat", () => {
  let db: Db;
  let updateId = 1;
  let messageId = 1;
  let emitted: [string, string, Record<string, unknown> | undefined][] = [];
  const ctx: OpContext = { afterwards: () => undefined, emit: (event, code, extra) => void emitted.push([event, code, extra]) };

  beforeAll(async () => {
    ({ db } = await createTestDb());
  });
  beforeEach(async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
    process.env.TELEGRAM_WEBHOOK_SECRET = "hooksecret";
    process.env.TELEGRAM_BOT_USERNAME = "kicksmash_bot";
    process.env.APP_BASE_URL = "https://kicksma.sh";
    stubFetch();
    platformPage = BRANCH_PAGE;
    emitted = [];
    await db.delete(telegramCards);
    await db.delete(telegramChats);
    await db.delete(events);
    // A match made in one test is the organiser's last venue in the next: each test starts with none.
    await db.delete(venues);
    await db.delete(clubs);
    // The directory's row, as the import writes it: no booking link, the club's zone.
    await db.insert(clubs).values({ slug: "warehaus", name: "WAREHAUS.club", manageToken: "tok-warehaus-abcdefghijklmnop", source: "directory", tz: TZ });
  });
  afterEach(() => vi.unstubAllGlobals());

  const update = (u: Omit<TgUpdate, "update_id">) => handleTelegramUpdate(db, { update_id: updateId++, ...u }, ctx);
  const say = async (chat: TgMessage["chat"], from: ReturnType<typeof user>, text: string, extra: Partial<TgMessage> = {}) => {
    const message: TgMessage = { message_id: messageId++, date: 0, chat, from, text, ...extra };
    return { message, outcome: await update({ message }) };
  };
  /**
   * "Create match" on the bot's answer `answerId`, which replies to `pasted`; tapped by `from`. The data is
   * the button's own when the answer had one (`createData`), else what the test gives; `sentAt` is the answer's date.
   */
  const tap = (from: ReturnType<typeof user>, answerId: number, pasted: TgMessage, data = createData ?? "pb:c:0", sentAt = 0) =>
    update({ callback_query: { id: `cb${updateId}`, from, data, message: { message_id: answerId, date: sentAt, chat: pasted.chat, from: BOT, reply_to_message: pasted } } });
  /** The callback data of the last answer's "Create match", when it had one. */
  let createData: string | undefined;
  /** The bot's answer to a paste: the last message it sent, and the id the stub gave it. */
  const lastAnswer = () => {
    const all = sent("sendMessage");
    const call = all[all.length - 1];
    createData = buttonsOf(call).find((b) => b.callback_data)?.callback_data;
    return { call, id: nextMessageId - 1 };
  };
  const minutes36 = (d: Date) => Math.round(d.getTime() / 60_000).toString(36);
  /** Cath's player row: the one a tap made, or a new one. */
  const cathRow = async () => {
    const [found] = await db.select().from(players).where(eq(players.telegramId, cath.id));
    return found ?? (await db.insert(players).values({ displayName: "Cath", telegramId: cath.id }).returning())[0];
  };
  const cathsMatches = async () => {
    const [me] = await db.select().from(players).where(eq(players.telegramId, cath.id));
    return me ? db.select().from(events).where(eq(events.creatorPlayerId, me.id)) : [];
  };

  it("reads the owner's case, answers once with what it read, and the tap makes one match with Danny and Alberto held and the court booked", async () => {
    const pasted = await say(dm(cath), cath, OWNER_TEXT);
    expect(pasted.outcome).toBe("paste_read");
    // One answer, as a reply to the paste, with no link preview, and no read of the link: the words said everything.
    expect(sent("sendMessage")).toHaveLength(1);
    const answer = lastAnswer();
    expect(answer.call.body.text).toBe(`📋 WAREHAUS.club, Mon, Oct 12, 18:00–19:30, court 3, with Danny and Alberto\n${en.pasteReady}`);
    expect(answer.call.body.reply_parameters).toMatchObject({ message_id: pasted.message.message_id });
    expect(answer.call.body.link_preview_options).toEqual({ is_disabled: true });
    expect(outside).toEqual([]);
    const [create, edit] = buttonsOf(answer.call);
    // The button carries the start it shows, in epoch minutes in base 36: 64 bytes hold it.
    expect(create).toEqual({ text: en.pasteCreate, callback_data: `pb:c:${minutes36(zonedTimeToUtc("2026-10-12", "18:00", TZ))}` });
    expect(edit.text).toBe(en.pasteEdit);
    const form = new URL(edit.url!);
    expect(form.origin).toBe("https://kicksma.sh");
    expect(Object.fromEntries([...form.searchParams].filter(([k]) => k !== "tg"))).toEqual({ src: "paste", venue: "WAREHAUS.club", date: "2026-10-12", time: "18:00", tz: TZ, len: "90", court: "3", names: "Danny,Alberto", booked: "1" });
    expect(form.searchParams.get("tg")).toMatch(new RegExp(`^${cath.id}\\.`));
    // Nothing is made, and nobody is created, until the tap.
    expect(await cathsMatches()).toEqual([]);

    calls = [];
    const made = await tap(cath, answer.id, pasted.message);
    expect(made).toMatch(/^paste_created:[A-Za-z0-9]{4}$/);
    const code = made.split(":")[1];
    const [ev] = await cathsMatches();
    expect(ev).toMatchObject({ code, venueName: "WAREHAUS.club", court: "3", tz: TZ, durationMinutes: 90, publicListing: false, type: "match", capacity: 4 });
    expect(ev.startsAt.toISOString()).toBe(zonedTimeToUtc("2026-10-12", "18:00", TZ).toISOString());
    const [me] = await db.select().from(players).where(eq(players.telegramId, cath.id));
    expect(ev.courtBookedBy).toBe(me.id);
    expect(ev.courtBookedAt).not.toBeNull();
    const seats = await db.select({ status: slots.status, playerId: slots.playerId, name: slots.invitedName }).from(slots).where(eq(slots.eventId, ev.id)).orderBy(asc(slots.position));
    expect(seats.filter((s) => s.status === "joined").map((s) => s.playerId)).toEqual([me.id]);
    expect(seats.filter((s) => s.status === "invited").map((s) => s.name)).toEqual(["Danny", "Alberto"]);
    // One event for the new match, carrying the booked court, as the web's create sends it.
    expect(emitted).toEqual([["match.created", code, { courtBooked: true }]]);
    // The card goes up as a reply to the booking, already saying the court is booked.
    const card = calls.find((c) => (c.method === "sendMessage" || c.method === "sendPhoto") && String(c.body.text ?? c.body.caption ?? "").includes(en.courtBooked("Cath")));
    expect(card?.body.reply_parameters).toMatchObject({ message_id: pasted.message.message_id });
    // The answer becomes the match's link, with that one link's preview on, ready for the WhatsApp group.
    const link = `https://kicksma.sh/${code}`;
    const turned = sent("editMessageText");
    expect(turned).toHaveLength(1);
    expect(turned[0].body).toMatchObject({ message_id: answer.id, text: `${en.pasteMade(1)}\n${link}`, link_preview_options: { url: link, prefer_small_media: true }, reply_markup: { inline_keyboard: [] } });
    expect(outside).toEqual([]);

    // A second tap on the same answer: the same match, and its link again.
    calls = [];
    expect(await tap(cath, answer.id, pasted.message)).toBe(`paste_exists:${code}`);
    expect(sent("answerCallbackQuery")[0].body.text).toBe(en.timesExists);
    expect(sent("editMessageText")[0].body.text).toBe(`${en.pasteExists}\n${link}`);
    // The same booking pasted again, and its button tapped: still the one match.
    const again = await say(dm(cath), cath, OWNER_TEXT);
    expect(again.outcome).toBe("paste_read");
    expect(await tap(cath, lastAnswer().id, again.message)).toBe(`paste_exists:${code}`);
    expect(await cathsMatches()).toHaveLength(1);
    expect(outside).toEqual([]);
  });

  it("refuses somebody else's tap on Create match and does nothing", async () => {
    const pasted = await say(dm(cath), cath, OWNER_TEXT);
    expect(pasted.outcome).toBe("paste_read");
    calls = [];
    // Nok taps a button under Cath's booking (a forwarded answer): the booking is Cath's.
    expect(await tap(nok, lastAnswer().id, pasted.message)).toBe("paste_not_yours");
    expect(sent("answerCallbackQuery")[0].body).toMatchObject({ text: en.pasteNotYours, show_alert: true });
    expect(sent("editMessageText")).toEqual([]);
    expect(await db.select().from(events)).toEqual([]);
    expect(await db.select().from(players).where(eq(players.telegramId, nok.id))).toEqual([]);
  });

  it("leaves a group untouched: a line with a booking link is dropped before any database read", async () => {
    const group = { id: -100777001, type: "supergroup" as const, title: "Phuket padel" };
    const heard = await say(group, cath, OWNER_TEXT);
    expect(heard.outcome).toBe("ignored");
    // No chat row was written (the first read a message makes), nothing was sent, the link was not opened.
    expect(await db.select().from(telegramChats).where(eq(telegramChats.chatId, group.id))).toEqual([]);
    expect(calls).toEqual([]);
    expect(outside).toEqual([]);
  });

  it("leaves a plain private message as it was: the private help", async () => {
    for (const text of ["hello, anyone around?", "tomorrow 18:00 works for me"]) {
      calls = [];
      expect((await say(dm(cath), cath, text)).outcome).toBe("private_other");
      expect(sent("sendMessage").map((c) => c.body.text)).toEqual([en.privateHelp]);
    }
    expect(outside).toEqual([]);
  });

  it("reads a Padel Society link alone once, names what it does not give, and offers Edit first only", async () => {
    const pasted = await say(dm(cath), cath, LINK);
    expect(pasted.outcome).toBe("paste_missing:club,date,time");
    // One read of the link, as a chat app's preview robot reads it; its preview is generic, so it fills nothing.
    expect(outside).toEqual([LINK]);
    const answer = lastAnswer();
    expect(answer.call.body.text).toBe(`📋 ${en.pasteLinkOf("The Padel Society")}\n${en.pasteMissing("the club, the day or the time")}`);
    const buttons = buttonsOf(answer.call);
    expect(buttons.map((b) => b.text)).toEqual([en.pasteEdit]);
    expect(buttons[0].url).toMatch(/^https:\/\/kicksma\.sh\/\?src=paste&tz=UTC&booked=1&tg=/);

    // The same link behind words (a text_link entity) is read the same way.
    outside = [];
    const hidden = await say(dm(cath), cath, "my booking", { entities: [{ type: "text_link", offset: 0, length: 10, url: LINK }] });
    expect(hidden.outcome).toBe("paste_missing:club,date,time");
    expect(outside).toEqual([LINK]);
    // A tap that comes anyway (an old client) makes nothing, and reads the link no second time.
    expect(await tap(cath, lastAnswer().id, hidden.message, "pb:c:abc")).toBe("paste_incomplete");
    expect(outside).toEqual([LINK]);
    expect(await db.select().from(events)).toEqual([]);
  });

  it("reads the link once: when its preview filled the day and the time, the answer offers Edit first alone, and a tap never opens the link", async () => {
    platformPage = '<html><head><meta property="og:title" content="Padel at WAREHAUS.club" /><meta property="og:description" content="Mon 12 Oct, 18:00 - 19:30" /></head></html>';
    const pasted = await say(dm(cath), cath, `Warehaus court 3 with Danny ${LINK}`);
    expect(pasted.outcome).toBe("paste_check:link");
    expect(outside).toEqual([LINK]);
    const answer = lastAnswer();
    expect(answer.call.body.text).toBe(`📋 WAREHAUS.club, Mon, Oct 12, 18:00–19:30, court 3, with Danny\n${en.pasteCheckLink}`);
    expect(buttonsOf(answer.call).map((b) => b.text)).toEqual([en.pasteEdit]);
    // The form carries what the preview filled; the organiser checks it there.
    expect(new URL(buttonsOf(answer.call)[0].url!).searchParams.get("date")).toBe("2026-10-12");
    // A tap that comes anyway reads the words alone, which lack the day: nothing is made, and the link is not read again.
    expect(await tap(cath, answer.id, pasted.message, `pb:c:${minutes36(zonedTimeToUtc("2026-10-12", "18:00", TZ))}`)).toBe("paste_incomplete");
    expect(outside).toEqual([LINK]);
    expect(await cathsMatches()).toEqual([]);
  });

  it("makes the match on the day the answer showed, not on the day of the tap", async () => {
    // Sunday 11 October, 17:50 in Phuket: "Sunday 18:00" is today. The tap comes at 18:01, when the same words mean next Sunday.
    const answeredAt = new Date("2026-10-11T10:50:00Z");
    vi.setSystemTime(answeredAt);
    try {
      const pasted = await say(dm(cath), cath, "Warehaus Sunday 18:00 with Danny");
      expect(pasted.outcome).toBe("paste_read");
      const answer = lastAnswer();
      expect(String(answer.call.body.text)).toContain("Sun, Oct 11, 18:00");
      vi.setSystemTime(new Date("2026-10-11T11:01:00Z"));
      // A button that names another start than the words give at the answer's time makes nothing.
      expect(await tap(cath, answer.id, pasted.message, `pb:c:${minutes36(zonedTimeToUtc("2026-10-18", "18:00", TZ))}`, answeredAt.getTime() / 1000)).toBe("paste_moved");
      expect(await cathsMatches()).toEqual([]);
      const made = await tap(cath, answer.id, pasted.message, createData, answeredAt.getTime() / 1000);
      expect(made).toMatch(/^paste_created:/);
      const [ev] = await cathsMatches();
      expect(ev.startsAt.toISOString()).toBe(zonedTimeToUtc("2026-10-11", "18:00", TZ).toISOString());
    } finally {
      vi.setSystemTime(NOW);
    }
  });

  it("offers Edit first alone for the organiser's last club and for a weekday that disagrees with the date", async () => {
    const me = await cathRow();
    await db.insert(venues).values({ creatorPlayerId: me.id, name: "WAREHAUS.club", lastUsedAt: new Date(NOW.getTime() - 86_400_000) });
    const guessed = await say(dm(cath), cath, `tomorrow 18:00 with Danny ${LINK}`);
    expect(guessed.outcome).toBe("paste_check:club");
    let answer = lastAnswer();
    expect(answer.call.body.text).toBe(`📋 ${en.pasteLastClub("WAREHAUS.club")}, Mon, Oct 12, 18:00, with Danny\n${en.pasteCheckClub}`);
    expect(buttonsOf(answer.call).map((b) => b.text)).toEqual([en.pasteEdit]);
    expect(new URL(buttonsOf(answer.call)[0].url!).searchParams.get("check")).toBe("venue");
    // 12 October 2026 is a Monday.
    const clash = await say(dm(cath), cath, "Warehaus Sun 12 Oct 18:00 with Danny");
    expect(clash.outcome).toBe("paste_check:day");
    answer = lastAnswer();
    expect(answer.call.body.text).toBe(`📋 WAREHAUS.club, Mon, Oct 12, 18:00, with Danny\n${en.pasteCheckDay}`);
    expect(buttonsOf(answer.call).map((b) => b.text)).toEqual([en.pasteEdit]);
  });

  it("gives the claim back when the create fails, so the next tap tries again", async () => {
    // Cath made twenty matches today: the create refuses a twenty-first, every time, and never as "already on".
    const me = await cathRow();
    await db.insert(metricsDaily).values({ day: dayKey(NOW), key: `rl:create:${me.id}`, value: LIMITS.eventsPerPlayerPerDay }).onConflictDoUpdate({ target: [metricsDaily.day, metricsDaily.key], set: { value: LIMITS.eventsPerPlayerPerDay } });
    const pasted = await say(dm(cath), cath, "Warehaus Wed 14 Oct 18:00 with Danny");
    expect(pasted.outcome).toBe("paste_read");
    const answer = lastAnswer();
    expect(await tap(cath, answer.id, pasted.message)).toBe("paste_too_many");
    expect(await tap(cath, answer.id, pasted.message)).toBe("paste_too_many");
    expect(await cathsMatches()).toEqual([]);
    await db.delete(metricsDaily).where(eq(metricsDaily.key, `rl:create:${me.id}`));
  });

  it("shows the year of a day in another year", () => {
    const read = { platform: null, ref: null, club: null, clubFrom: null, date: "2027-01-03", time: "18:00", tz: TZ, minutes: null, court: null, cost: null, names: [], missing: ["club" as const], dayClash: false };
    expect(pasteSummary(read, "en", { now: NOW })).toContain("Sun, Jan 3, 2027");
    expect(pasteSummary({ ...read, date: "2026-12-03" }, "en", { now: NOW })).toContain("Thu, Dec 3,");
    expect(pasteSummary({ ...read, date: "2026-12-03" }, "en", { now: NOW })).not.toContain("2026");
  });
});
