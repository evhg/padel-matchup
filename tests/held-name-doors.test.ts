import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { joinRequests, metricsDaily, players, slots, telegramCards } from "@/db/schema";
import { fail } from "@/lib/api/http";
import { handleMcpPost } from "@/lib/api/mcp";
import { joinMatch, NameHeldError, NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { handleInteraction } from "@/lib/discord/bot";
import { handleLineWebhook } from "@/lib/line/bot";
import type { DcInteraction } from "@/lib/discord/api";
import { createEvent } from "@/lib/domain/events";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { heldNameOf, joinWithPolicy } from "@/lib/domain/joining";
import { getEventByCode } from "@/lib/domain/queries";
import { joinEvent, reserveNames } from "@/lib/domain/slots";
import { handleTelegramUpdate } from "@/lib/telegram/bot";
import { strings } from "@/lib/telegram/card";
import { REACTION } from "@/lib/telegram/handlers/words";
import type { TgMessage } from "@/lib/telegram/api";
import { handleWhatsappMessage } from "@/lib/whatsapp/bot";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

/**
 * A place held for a name, on every door (DECIDING rule 34). The web's join refused a second Danny
 * beside the place held for Danny since 11 October 2026 (`whoJoins`); the Telegram ✅ and "+1", the
 * Discord and LINE buttons, the WhatsApp JOIN and `join_match` in the API and MCP did not, so a
 * namesake there took a seat beside the place, and after that nobody could take it by name. The check
 * now lives in the rule every door asks (`joinWithPolicy`), and each door says it in its own words.
 *
 * The web and the API refuse, because their player reaches the match page signed in and takes the
 * place there. A chat cannot send its player there signed in (its link opens a browser that knows
 * nobody, where the take makes a second record), so a chat's join takes the place for the account's
 * own record (`takeHeld`), and says whose place it was and what a different person of the name does.
 */

// A fixed clock (rule 11): every match starts two days after NOW.
const NOW = new Date(Date.UTC(2026, 9, 12, 4, 0));
freezeClock(NOW);

const TOKEN = "123456:TESTTOKEN";
const BOT = { id: 123456, is_bot: true, first_name: "Kicksmash" };

type Call = { url: string; method: string; body: Record<string, unknown> };
let calls: Call[] = [];
let nextMessageId = 500;

/** One fake for every platform: Telegram's Bot API, Discord's REST and WhatsApp's Cloud API all answer "ok". */
function stubPlatforms() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: u, method: u.split("/").pop()!, body });
      if (u.includes("graph.facebook.com")) return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
      const result = u.endsWith("/sendMessage") || u.endsWith("/sendPhoto") ? { message_id: nextMessageId++, chat: { id: body.chat_id } } : true;
      return new Response(JSON.stringify({ ok: true, result, id: String(nextMessageId++) }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}
const tg = (method: string) => calls.filter((c) => c.method === method && c.url.includes("api.telegram.org"));
const tgUser = (id: number, first_name: string, language_code = "en") => ({ id, first_name, username: `${first_name.toLowerCase()}_${id}`, language_code });

describe("a place held for a name, on every door", () => {
  let db: Db;
  let close: () => Promise<void>;
  let updateId = 1;
  let messageId = 1;
  let n = 0;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_WEBHOOK_SECRET = "hooksecret";
    process.env.TELEGRAM_BOT_USERNAME = "kicksmash_bot";
    process.env.DISCORD_BOT_TOKEN = "discord-token";
    process.env.LINE_CHANNEL_TOKEN = "line-token";
    process.env.LINE_CHANNEL_SECRET = "line-secret";
    process.env.WHATSAPP_TOKEN = "t";
    process.env.WHATSAPP_PHONE_ID = "123";
    process.env.WHATSAPP_NUMBER = "+66 81 234 5678";
    process.env.WHATSAPP_APP_SECRET = "secret";
    stubPlatforms();
  });
  afterEach(() => vi.unstubAllGlobals());

  /** A match the organiser sits in, with "Danny" held by name as "Paste the names" holds it, and the other names given. */
  const match = async (held: string[] = ["Danny"], o: { levelMin?: number; levelMax?: number } = {}) => {
    const org = await makePlayer(db, `Organiser ${++n}`, { email: `org${n}@example.com` });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 2 * DAY), tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Rawai Padel", ...o });
    await joinEvent(db, { eventId: ev.id, playerId: org.id, now: NOW });
    if (held.length) await reserveNames(db, { eventId: ev.id, actorPlayerId: org.id, names: held, now: NOW });
    return { ev, org };
  };
  /** Every place of the match by name: the held one stays "invited", and no second Danny ever appears. */
  const places = async (eventId: string) =>
    (await db.select({ status: slots.status, invitedName: slots.invitedName, name: players.displayName }).from(slots).leftJoin(players, eq(players.id, slots.playerId)).where(eq(slots.eventId, eventId))).filter((s) => s.status !== "empty");
  const dannys = async (eventId: string) => (await places(eventId)).filter((s) => /^danny$/i.test(s.name ?? s.invitedName ?? ""));
  const playerCount = async () => Number((await db.select({ n: sql<number>`count(*)::int` }).from(players))[0].n);
  /** The held place, taken by the record the door knows: one Danny in the match, on the held row, and it is that account's. */
  const takenBy = async (eventId: string, playerId: string | undefined) => {
    expect(await dannys(eventId)).toEqual([{ status: "confirmed", invitedName: "Danny", name: "Danny" }]);
    const [place] = await db.select().from(slots).where(and(eq(slots.eventId, eventId), eq(slots.invitedName, "Danny")));
    expect(place.kind).toBe("reserved");
    expect(place.playerId).toBe(playerId);
  };
  const heldByName = async () => Number((await db.select().from(metricsDaily).where(eq(metricsDaily.key, "held_by_name")))[0]?.value ?? 0);

  describe("the shared rule", () => {
    it("names the held place for a record of the same name, and for nobody else", async () => {
      const { ev, org } = await match();
      const detail = (await getEventByCode(db, ev.code))!;
      expect(heldNameOf(detail, await makePlayer(db, " DANNY "), NOW)).toBe("Danny");
      expect(heldNameOf(detail, await makePlayer(db, "Ana"), NOW)).toBeNull();
      // The organiser is never refused by name, nor a Danny who holds a place in the match already.
      expect(heldNameOf(detail, { ...org, displayName: "Danny" }, NOW)).toBeNull();
      const inAlready = await makePlayer(db, "Danny");
      await joinEvent(db, { eventId: ev.id, playerId: inAlready.id, now: NOW });
      const after = (await getEventByCode(db, ev.code))!;
      // Now a Danny sits in the match: the held place can no longer be taken by name, so nothing is held back.
      expect(heldNameOf(after, inAlready, NOW)).toBeNull();
      expect(heldNameOf(after, await makePlayer(db, "Danny"), NOW)).toBeNull();
    });

    it("refuses before the range, the request or the seat, writes nothing, and lets any other name in", async () => {
      // A ranged match and a Danny with no level: the held name answers first, so no level is asked
      // for and no request opens. A full match too: nobody lands on the waiting list.
      const { ev } = await match(["Danny", "Bo", "Cy"], { levelMin: 2, levelMax: 4 });
      const detail = (await getEventByCode(db, ev.code))!;
      const danny = await makePlayer(db, "Danny");
      expect(await joinWithPolicy(db, detail, danny, null, null, { now: NOW })).toEqual({ kind: "name_held", name: "Danny" });
      expect(await db.select().from(joinRequests).where(eq(joinRequests.playerId, danny.id))).toEqual([]);
      expect(await db.select().from(slots).where(eq(slots.playerId, danny.id))).toEqual([]);
      // The same step takes Eve, with a level inside the range, to the waiting list: the refusal above is the only thing that kept Danny off it.
      const eve = await makePlayer(db, "Eve", { level: 3 });
      const d = await joinWithPolicy(db, detail, eve, 3, null, { now: NOW });
      expect(d.kind === "joined" && d.result.outcome).toBe("waitlisted");
    });

    it("a chat's join takes the held place for the record of the name, before the range, and makes no second Danny", async () => {
      // A ranged match and a Danny with no level: the organiser chose the name, so the range does not ask (as the web's take).
      const { ev } = await match(["Danny"], { levelMin: 2, levelMax: 4 });
      const danny = await makePlayer(db, "Danny");
      const d = await joinWithPolicy(db, (await getEventByCode(db, ev.code))!, danny, null, null, { now: NOW, takeHeld: true });
      expect(d.kind === "joined" && [d.result.outcome, d.took]).toEqual(["joined", "Danny"]);
      await takenBy(ev.id, danny.id);
      expect(await db.select().from(joinRequests).where(eq(joinRequests.playerId, danny.id))).toEqual([]);
    });

    it("a place that changed between the read and the take refuses, and writes nothing", async () => {
      const { ev } = await match();
      const stale = (await getEventByCode(db, ev.code))!;
      // After the read, the organiser gives the place an address: it is that address's now, and the take under the lock must see it.
      await db.update(slots).set({ invitedEmail: "danny@example.com" }).where(and(eq(slots.eventId, ev.id), eq(slots.invitedName, "Danny")));
      const danny = await makePlayer(db, "Danny");
      expect(await joinWithPolicy(db, stale, danny, null, null, { now: NOW, takeHeld: true })).toEqual({ kind: "name_held", name: "Danny" });
      expect(await db.select().from(slots).where(eq(slots.playerId, danny.id))).toEqual([]);
      expect(await dannys(ev.id)).toEqual([{ status: "invited", invitedName: "Danny", name: null }]);
    });

    it("every chat answer about a held place fits Telegram's 200 characters, with the longest name, in three languages", () => {
      const name = "Abcdefghijklmnopqrstuvwxyzabcdefghijklmn"; // 40 characters, the most a held name has
      for (const locale of ["en", "ru", "es"] as const) {
        const s = strings(locale);
        for (const text of [s.toastTookHeld(name, false), s.toastTookHeld(name, true), s.toastHeldChanged(name)]) expect(text.length, `${locale}: ${text}`).toBeLessThanOrEqual(200);
      }
    });
  });

  describe("Telegram", () => {
    const update = (u: object) => handleTelegramUpdate(db, { update_id: updateId++, ...u }, NO_SIDE_EFFECTS);

    const tgPlayer = async (telegramId: number) => (await db.select().from(players).where(eq(players.telegramId, telegramId)))[0]?.id;

    it("the card's ✅ from a Danny takes the place held for Danny: no second Danny, and a box in the player's language says whose place it was", async () => {
      const { ev } = await match();
      const dm = { id: 3101, type: "private" as const };
      const tap = (code: string, from: ReturnType<typeof tgUser>) => update({ callback_query: { id: `cb${updateId}`, from, message: { message_id: 7, date: 0, chat: dm }, data: `j:${code}` } });
      expect(await tap(ev.code, tgUser(3101, "Danny"))).toBe("join:joined");
      const [answer] = tg("answerCallbackQuery");
      expect(answer.body.text).toBe(strings("en").toastTookHeld("Danny", false));
      expect(String(answer.body.text)).toContain("Not Danny? Tap ❌ and tell the organizer.");
      expect(answer.body.show_alert).toBe(true);
      await takenBy(ev.id, await tgPlayer(3101));
      // In Russian too.
      const second = await match();
      calls = [];
      expect(await tap(second.ev.code, tgUser(3102, "Danny", "ru"))).toBe("join:joined");
      expect(String(tg("answerCallbackQuery")[0].body.text)).toBe(strings("ru").toastTookHeld("Danny", false));
      expect(String(tg("answerCallbackQuery")[0].body.text)).toContain("Вы заняли место, которое держали для Danny");
      await takenBy(second.ev.id, await tgPlayer(3102));
      // Anybody else's ✅ seats them as before, in a seat of their own.
      calls = [];
      expect(await tap(ev.code, tgUser(3103, "Petr"))).toBe("join:joined");
      expect(tg("answerCallbackQuery")[0].body.text).toBe(strings("en").toastJoined);
    });

    it("a \"+1\" reply to the card from a Danny takes the held place, 👍, and the words go to that person alone", async () => {
      const { ev } = await match();
      const group = { id: -1003104, type: "supergroup" as const, title: "Thursday padel" };
      await update({ message: { message_id: messageId++, date: 0, chat: group, from: tgUser(3104, "Ana"), text: `/match ${ev.code}` } as TgMessage });
      const [card] = await db.select().from(telegramCards).where(and(eq(telegramCards.eventId, ev.id), eq(telegramCards.chatId, group.id)));
      calls = [];
      const message: TgMessage = { message_id: messageId++, date: 0, chat: group, from: tgUser(3105, "Danny"), text: "+1", reply_to_message: { message_id: card.messageId, date: 0, chat: group, from: BOT } };
      expect(await update({ message })).toBe("word_join:joined");
      expect(tg("setMessageReaction").map((c) => (c.body.reaction as { emoji: string }[])[0].emoji)).toEqual([REACTION.in]);
      const told = tg("sendMessage").filter((c) => (c.body.ephemeral_message_parameters as { receiver_user_id?: number } | undefined)?.receiver_user_id === 3105);
      expect(told.map((c) => c.body.text)).toEqual([strings("en").toastTookHeld("Danny", false)]);
      await takenBy(ev.id, await tgPlayer(3105));
    });
  });

  it("Discord: the join button from a Danny takes the held place and says so privately", async () => {
    const { ev } = await match();
    const button: DcInteraction = {
      id: "1",
      application_id: "app",
      type: 3,
      token: "itoken",
      guild_id: "1545987795863085087",
      channel_id: "1545987795863085090",
      member: { user: { id: "3201", username: "danny", global_name: "Danny" } },
      message: { id: "9", channel_id: "1545987795863085090" },
      data: { custom_id: `j:${ev.code}`, component_type: 2 },
    };
    const r = await handleInteraction(db, button, NO_SIDE_EFFECTS);
    expect(r.outcome).toBe("join:joined");
    expect(r.response.data?.content).toBe(strings("en").toastTookHeld("Danny", false));
    expect(r.response.data?.flags).toBe(64);
    await takenBy(ev.id, (await db.select().from(players).where(eq(players.discordId, "3201")))[0]?.id);
  });

  it("LINE: the join button from the LINE account of a Danny takes the held place and says so on the free reply token", async () => {
    const { ev } = await match();
    // A LINE account with no record is "Player"; a record that carries the account and the name Danny is the case.
    const danny = await makePlayer(db, "Danny", { lineId: "U3301" });
    const out = await handleLineWebhook(db, { events: [{ type: "postback", replyToken: "rt-held", source: { type: "group", groupId: "C3301", userId: "U3301" }, postback: { data: `j:${ev.code}` } }] }, NO_SIDE_EFFECTS);
    expect(out).toBe("line:join");
    const replies = calls.filter((c) => c.url.endsWith("/message/reply"));
    expect(replies.map((c) => (c.body.messages as { text: string }[])[0].text)).toEqual([strings("en").toastTookHeld("Danny", false)]);
    await takenBy(ev.id, danny.id);
  });

  it("WhatsApp: a JOIN from a number whose profile is Danny takes the held place, says whose it was, and counts the take", async () => {
    const { ev } = await match();
    const counted = await heldByName();
    const out = await handleWhatsappMessage(db, { from: "66810003301", id: "wamid.held1", timestamp: "0", type: "text", text: { body: `JOIN-${ev.code}` } }, { profile: { name: "Danny" }, wa_id: "66810003301" });
    expect(out).toBe("wa:took_held");
    const sent = calls.filter((c) => c.url.includes("graph.facebook.com")).map((c) => JSON.stringify(c.body));
    expect(sent.some((t) => t.includes("You are in.") && t.includes("This is the place the organiser held for Danny.") && t.includes("Not Danny? Tap \\\"Can't make it\\\" and tell the organiser."))).toBe(true);
    const [place] = await db.select({ playerId: slots.playerId, phone: players.phone }).from(slots).innerJoin(players, eq(players.id, slots.playerId)).where(and(eq(slots.eventId, ev.id), eq(slots.invitedName, "Danny")));
    expect(place.phone).toContain("66810003301");
    await takenBy(ev.id, place.playerId!);
    expect(await heldByName()).toBe(counted + 1);
  });

  describe("the API and MCP (join_match)", () => {
    it("refuses a typed Danny before any record is made, and a token's Danny too, with 409 name_held", async () => {
      const { ev } = await match();
      const before = await playerCount();
      await expect(joinMatch(db, { code: ev.code, name: " danny " }, NO_SIDE_EFFECTS)).rejects.toMatchObject({ status: 409, code: "name_held", held: "Danny" });
      expect(await playerCount()).toBe(before);
      // Any other name joins; a token's player named Danny is refused too, before the email and the level it gave are saved.
      const eve = await joinMatch(db, { code: ev.code, name: "Eve" }, NO_SIDE_EFFECTS);
      expect(eve.outcome).toBe("joined");
      const tokens = await makePlayer(db, "Danny");
      const token = await getOrCreatePersonalToken(db, tokens.id);
      await expect(joinMatch(db, { code: ev.code, token, email: "danny@example.com", level: 3 }, NO_SIDE_EFFECTS)).rejects.toBeInstanceOf(NameHeldError);
      const [unchanged] = await db.select().from(players).where(eq(players.id, tokens.id));
      expect([unchanged.email, unchanged.level]).toEqual([null, null]);
      expect(await dannys(ev.id)).toEqual([{ status: "invited", invitedName: "Danny", name: null }]);
    });

    it("a place that keeps a past player's record gets its own hint: That's me or the place's link, never the held-place button", async () => {
      const { ev, org } = await match([]);
      // Danny played here before (a seat in another match), and the organiser kept his record on a place, as attachHeldRecord writes it.
      const past = await makePlayer(db, "Danny");
      await joinEvent(db, { eventId: (await match([])).ev.id, playerId: past.id, now: NOW });
      await reserveNames(db, { eventId: ev.id, actorPlayerId: org.id, names: ["Danny"], now: NOW });
      await db.update(slots).set({ playerId: past.id }).where(and(eq(slots.eventId, ev.id), eq(slots.invitedName, "Danny")));
      const before = await playerCount();
      const err = await joinMatch(db, { code: ev.code, name: "Danny" }, NO_SIDE_EFFECTS).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NameHeldError);
      expect(err).toMatchObject({ status: 409, code: "name_held", held: "Danny", kind: "record" });
      expect((err as NameHeldError).hint).toContain(`"That's me"`);
      expect((err as NameHeldError).hint).not.toContain("held place");
      expect(await playerCount()).toBe(before);
      // A place held by name keeps the by-name hint.
      expect(new NameHeldError("Danny").hint).toContain(`"Take Danny's held place"`);
    });

    it("says it as an HTTP body and as an MCP tool error an assistant can act on", async () => {
      const { ev } = await match();
      const res = fail(new NameHeldError("Danny"));
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string; hint: string } };
      expect(body.error.code).toBe("name_held");
      expect(body.error.message).toContain("held for Danny");
      expect(body.error.hint).toContain("last name");
      const r = await handleMcpPost(db, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "join_match", arguments: { code: ev.code, name: "Danny" } } }, NO_SIDE_EFFECTS);
      const result = (r.body as { result: { isError: boolean; content: { text: string }[] } }).result;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("A place in this match is held for Danny");
      expect(await dannys(ev.id)).toEqual([{ status: "invited", invitedName: "Danny", name: null }]);
    });
  });
});
