import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, events, groups, telegramCards, telegramChats, type ClubAvailability, type ClubFreeSlot } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { zonedTimeToUtc } from "@/lib/dates";
import { claimClub, decideClub } from "@/lib/domain/clubs";
import { createEvent } from "@/lib/domain/events";
import { createGroup } from "@/lib/domain/groups";
import { handleTelegramUpdate } from "@/lib/telegram/bot";
import { strings } from "@/lib/telegram/card";
import { crewStartPayload } from "@/lib/telegram/deepLinks";
import type { TgMessage, TgUpdate } from "@/lib/telegram/api";
import { freezeClock } from "./helpers/clock";
import { createTestDb, HOUR, makePlayer } from "./helpers/db";

/**
 * "times?": the best times in the chat, only when somebody asks (DECIDING rules 5 and 34). A crew's own
 * group, a private chat, and /times anywhere: one reply with up to three free courts as buttons; a tap
 * makes the match the way "who's in Thursday 7pm Rawai?" does, the card appears, and the answer is
 * taken down. Every Bot API call is stubbed and read back from `calls`.
 *
 * NOW is Saturday 10 October 2026, 05:00 UTC, 12:00 in Bangkok. Rawai Padel Club shows free courts on
 * Saturday at 15:00 and 16:00 and on Thursday the 15th at 19:00 and 20:00; Chalong Padel Club on
 * Sunday at 09:00 and 10:00. The crew plays Thursdays at 19:00 at Rawai.
 */
const NOW = new Date("2026-10-10T05:00:00Z");
freezeClock(NOW);
const TZ = "Asia/Bangkok";
const at = (date: string, time: string) => zonedTimeToUtc(date, time, TZ);
const hour = (date: string, time: string, free = 1): ClubFreeSlot => {
  const start = at(date, time);
  return { start: start.toISOString(), end: new Date(start.getTime() + HOUR).toISOString(), free };
};
const feed = (slots: ClubFreeSlot[]): ClubAvailability => ({ fetchedAt: NOW.toISOString(), day: "2026-10-10", tz: TZ, slots, error: null, source: "ics_bookings" });
const BOT = { id: 123456, is_bot: true, first_name: "Kicksmash" };
const ADMIN_RIGHTS = { status: "administrator", can_pin_messages: true, can_invite_users: true };
const en = strings("en");

type Call = { method: string; body: Record<string, unknown> };
let calls: Call[] = [];
let nextMessageId = 5000;
let members = new Map<string, Record<string, unknown>>();

function stubTelegram() {
  calls = [];
  members = new Map();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
      if (method === "sendMessage" || method === "sendPhoto") return reply({ message_id: nextMessageId++, chat: { id: body.chat_id } });
      if (method === "getChatMember") return reply(members.get(`${body.chat_id}:${body.user_id}`) ?? { status: "member" });
      if (method === "createChatInviteLink") return reply({ invite_link: `https://t.me/+crew${Math.abs(Number(body.chat_id))}` });
      return reply(true);
    }),
  );
}
const sent = (method: string) => calls.filter((c) => c.method === method);
const buttonsOf = (c: Call | undefined) => ((c?.body.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard ?? []).flat();
const user = (id: number, first_name: string) => ({ id, first_name, username: `${first_name.toLowerCase()}_tg`, language_code: "en" });

describe("\"times?\" in the chat", () => {
  let db: Db;
  let updateId = 1;
  let messageId = 1;
  let rawai = "";
  beforeAll(async () => {
    ({ db } = await createTestDb());
  });
  beforeEach(async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
    process.env.TELEGRAM_WEBHOOK_SECRET = "hooksecret";
    process.env.TELEGRAM_BOT_USERNAME = "kicksmash_bot";
    stubTelegram();
    await db.delete(telegramCards);
    await db.delete(telegramChats);
    await db.delete(events);
    await db.delete(groups);
    await db.delete(clubs);
    for (const [name, slots] of [
      ["Rawai Padel Club", [hour("2026-10-10", "15:00"), hour("2026-10-10", "16:00"), hour("2026-10-15", "19:00", 2), hour("2026-10-15", "20:00", 2)]],
      ["Chalong Padel Club", [hour("2026-10-11", "09:00"), hour("2026-10-11", "10:00")]],
    ] as const) {
      const owner = await makePlayer(db, `Owner of ${name}`);
      const c = await claimClub(db, { name, playerId: owner.id, tz: TZ, courts: 4 });
      await decideClub(db, c.slug, true, NOW);
      // The club shares a calendar feed of its bookings, read by the hourly job: the cache it wrote.
      await db.update(clubs).set({ availabilityUrl: `https://${c.slug}.example/bookings.ics`, availabilityKind: "ics_bookings", availability: feed([...slots]), availabilityAt: NOW }).where(eq(clubs.slug, c.slug));
      if (name === "Rawai Padel Club") rawai = c.slug;
    }
  });
  afterEach(() => vi.unstubAllGlobals());

  const update = (u: Omit<TgUpdate, "update_id">) => handleTelegramUpdate(db, { update_id: updateId++, ...u }, NO_SIDE_EFFECTS);
  const say = (chat: TgMessage["chat"], from: ReturnType<typeof user>, text: string) => {
    const id = messageId++;
    return { id, outcome: update({ message: { message_id: id, date: 0, chat, from, text } }) };
  };
  const tap = (chat: TgMessage["chat"], from: ReturnType<typeof user>, data: string, onMessage: number) =>
    update({ callback_query: { id: `cb${updateId}`, from, data, chat_instance: "x", message: { message_id: onMessage, date: 0, chat, from: BOT } } as never });

  /** The crew's own group, read by the bot: Ana ties it with the crew page's link; the crew plays Thursdays at 19:00 at Rawai. */
  async function listeningCrew(chatId: number) {
    const chat = { id: chatId, type: "supergroup" as const, title: "Thursday crew" };
    // Ana's Telegram id is the chat's number, so each test's crew has its own admin.
    const anaId = Math.abs(chatId);
    const owner = await makePlayer(db, "Ana", { telegramId: anaId });
    const crew = await createGroup(db, { name: "Thursday crew", creatorPlayerId: owner.id, tz: TZ, venueName: "Rawai Padel Club" });
    await db.update(groups).set({ recurDow: 4, recurTime: "19:00" }).where(eq(groups.id, crew.id));
    members.set(`${chatId}:${anaId}`, { status: "creator" });
    members.set(`${chatId}:${BOT.id}`, ADMIN_RIGHTS);
    expect(await say(chat, user(anaId, "Ana"), `/start@kicksmash_bot ${crewStartPayload(crew.id, owner.id)}`).outcome).toBe("crew_listening");
    calls = [];
    return { chat, crew };
  }

  it("asked in the crew's group, the bot answers once, as a reply, with the best three free courts as buttons", async () => {
    const { chat } = await listeningCrew(-300100);
    const asked = say(chat, user(2, "Petr"), "times?");
    expect(await asked.outcome).toBe("times:3");
    expect(sent("sendMessage")).toHaveLength(1);
    const answer = sent("sendMessage")[0];
    expect(answer.body.text).toBe(en.timesFree);
    expect(answer.body.reply_parameters).toMatchObject({ message_id: asked.id });
    expect(answer.body.link_preview_options).toEqual({ is_disabled: true });
    const buttons = buttonsOf(answer);
    // The crew's usual club at its usual time first, then the soonest.
    expect(buttons.map((b) => b.text)).toEqual(["Thu, Oct 15 19:00 · Rawai Padel Club", "Sat, Oct 10 15:00 · Rawai Padel Club", "Sun, Oct 11 09:00 · Chalong Padel Club"]);
    expect(buttons[0].callback_data).toBe(`bt:${Math.round(at("2026-10-15", "19:00").getTime() / 60_000).toString(36)}:90:${rawai}`);
    expect(buttons.every((b) => (b.callback_data ?? "").length <= 64)).toBe(true);
  });

  it("a tap makes the crew's match at that club and hour, posts its card, and takes the answer down; a second tap makes nothing", async () => {
    const { chat, crew } = await listeningCrew(-300200);
    await say(chat, user(2, "Petr"), "When can we play?").outcome;
    // The tap arrives on the bot's answer; which id Telegram gave it does not matter, only that this one goes.
    const answerId = 9001;
    const first = buttonsOf(sent("sendMessage")[0])[0];
    calls = [];
    const made = await tap(chat, user(2, "Petr"), first.callback_data!, answerId);
    expect(made).toMatch(/^times_created:[A-Za-z0-9]{4}$/);
    const [ev] = await db.select().from(events).where(eq(events.groupId, crew.id));
    expect(ev).toMatchObject({ venueSlug: rawai, venueName: "Rawai Padel Club", startsAt: at("2026-10-15", "19:00"), durationMinutes: 90, publicListing: false, status: "open" });
    // The card is the answer now: posted into the group, and the question's answer is gone.
    expect(sent("sendMessage").some((c) => String(c.body.text).includes("Rawai Padel Club") && String(c.body.text).includes("Players 1/4"))).toBe(true);
    expect(sent("deleteMessage")).toEqual([{ method: "deleteMessage", body: { chat_id: chat.id, message_id: answerId } }]);
    expect((await db.select().from(telegramCards).where(and(eq(telegramCards.eventId, ev.id), eq(telegramCards.chatId, chat.id)))).length).toBe(1);

    calls = [];
    expect(await tap(chat, user(3, "Lena"), first.callback_data!, answerId)).toBe("times_exists");
    expect(sent("answerCallbackQuery")[0].body.text).toBe(en.timesExists);
    expect((await db.select().from(events).where(eq(events.groupId, crew.id))).length).toBe(1);
  });

  it("a button for an hour gone, a club unknown or a payload we never made: nothing is made", async () => {
    const { chat } = await listeningCrew(-300300);
    const past = `bt:${Math.round(at("2026-10-10", "08:00").getTime() / 60_000).toString(36)}:90:${rawai}`;
    expect(await tap(chat, user(2, "Petr"), past, 77)).toBe("times_past");
    const nowhere = `bt:${Math.round(at("2026-10-15", "19:00").getTime() / 60_000).toString(36)}:90:nowhere-club`;
    expect(await tap(chat, user(2, "Petr"), nowhere, 77)).toBe("times_no_club");
    expect(await tap(chat, user(2, "Petr"), `bt:zzzzzz:45:${rawai}`, 77)).toBe("times_bad");
    const farOut = `bt:${Math.round(at("2026-11-30", "19:00").getTime() / 60_000).toString(36)}:90:${rawai}`;
    expect(await tap(chat, user(2, "Petr"), farOut, 77)).toBe("times_bad");
    expect(await db.select().from(events)).toEqual([]);
  });

  it("stays quiet unasked: ordinary chat about times is no question, and finding nothing in a group is a shrug", async () => {
    const { chat } = await listeningCrew(-300400);
    for (const line of ["what times work for you?", "times are hard", "when can we play golf?"]) {
      expect(await say(chat, user(2, "Petr"), line).outcome, line).toBe("ignored");
    }
    expect(calls).toEqual([]);
    await db.update(clubs).set({ availability: null });
    const asked = say(chat, user(2, "Petr"), "times?");
    expect(await asked.outcome).toBe("times:none");
    expect(sent("sendMessage")).toHaveLength(0);
    expect(sent("setMessageReaction").map((c) => (c.body.reaction as { emoji: string }[])[0].emoji)).toEqual(["🤷"]);
    // Asked as a command, the group hears one short line.
    calls = [];
    expect(await say(chat, user(2, "Petr"), "/times").outcome).toBe("times:none");
    expect(sent("sendMessage").map((c) => c.body.text)).toEqual([en.timesNone]);
  });

  it("in a private chat, the player's own clubs and times; in a group nobody tied to a crew, only /times", async () => {
    const nok = await makePlayer(db, "Nok", { telegramId: 42 });
    await createEvent(db, { creatorPlayerId: nok.id, type: "match", startsAt: at("2026-10-01", "19:00"), tz: TZ, venueName: "Rawai Padel Club", whenFull: "waitlist" });
    const dm = { id: 42, type: "private" as const };
    expect(await say(dm, user(42, "Nok"), "free courts?").outcome).toBe("times:3");
    expect(buttonsOf(sent("sendMessage")[0])[0].text).toBe("Thu, Oct 15 19:00 · Rawai Padel Club");

    calls = [];
    const plain = { id: -300500, type: "group" as const, title: "Padel friends" };
    expect(await say(plain, user(42, "Nok"), "times?").outcome).toBe("ignored");
    expect(sent("sendMessage")).toHaveLength(0);
    expect(await say(plain, user(42, "Nok"), "/times").outcome).toBe("times:3");
  });
});
