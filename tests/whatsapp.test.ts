import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { and, eq } from "drizzle-orm";
import { metricsDaily, players, slots } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { getRolodex } from "@/lib/domain/queries";
import { joinEvent, reserveSlot } from "@/lib/domain/slots";
import { bindInText, bindLink, codeInJoinText, codeInMatchUrl, joinLink, verifyBindTicket } from "@/lib/whatsapp/link";
import { LIMITS, readInbound, verifySignature, whatsappEnabled, whatsappLinkable, type WaInboundMessage } from "@/lib/whatsapp/api";
import { handleWhatsappMessage } from "@/lib/whatsapp/bot";
import { findOrCreateWhatsappPlayer } from "@/lib/whatsapp/identity";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * WhatsApp can never hold the card model: its Groups API makes only the business's own groups, capped
 * at eight, invite-link only. What it can hold is one person at a time — and that turns out to carry
 * the whole of a player's loop. These are the rules of that thread.
 */
const NOW = new Date("2026-09-14T09:00:00.000Z");
freezeClock(NOW);

const SECRET = "app-secret-for-tests";
const signed = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;

// Every message its own id, as Meta sends them: the thread answers one id once.
let msgSeq = 0;
const textMessage = (from: string, body: string): WaInboundMessage => ({ from, id: `wamid.t${++msgSeq}`, timestamp: "0", type: "text", text: { body } });
const tap = (from: string, id: string, title: string): WaInboundMessage => ({ from, id: `wamid.b${++msgSeq}`, timestamp: "0", type: "interactive", interactive: { type: "button_reply", button_reply: { id, title } } });

describe("the WhatsApp channel", () => {
  let db: Db;
  let close: () => Promise<void>;
  /** Every outbound call, so a test can read what the player was actually told, and which buttons came with it. */
  let sent: { to: string; type: string; body: string; buttons: { id: string; title: string }[] }[] = [];
  /** Every address fetched: a note to an organiser on Telegram goes out beside the WhatsApp replies. */
  let urls: string[] = [];

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  beforeEach(() => {
    process.env.WHATSAPP_TOKEN = "t";
    process.env.WHATSAPP_PHONE_ID = "123";
    process.env.WHATSAPP_NUMBER = "+66 81 234 5678";
    process.env.WHATSAPP_APP_SECRET = SECRET;
    sent = [];
    urls = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      urls.push(String(_url));
      const b = JSON.parse(init.body) as { to: string; type: string; text?: { body: string }; interactive?: { body: { text: string }; action?: { buttons?: { reply: { id: string; title: string } }[] } } };
      sent.push({ to: b.to, type: b.type, body: b.text?.body ?? b.interactive?.body.text ?? "", buttons: (b.interactive?.action?.buttons ?? []).map((x) => x.reply) });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
    });
  });

  it("is off until it is configured, which is what rule 4 asks of every channel", () => {
    expect(whatsappEnabled()).toBe(true);
    delete process.env.WHATSAPP_TOKEN;
    expect(whatsappEnabled()).toBe(false);
  });

  it("refuses a body that is not signed with the app secret", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifySignature(body, signed(body))).toBe(true);
    expect(verifySignature(`${body} `, signed(body))).toBe(false);
    expect(verifySignature(body, "sha256=deadbeef")).toBe(false);
    expect(verifySignature(body, null)).toBe(false);
    // No secret configured means nothing is trusted, which is the safe direction for an off channel.
    delete process.env.WHATSAPP_APP_SECRET;
    expect(verifySignature(body, signed(body))).toBe(false);
  });

  it("builds the hand-off link a person pastes into their own group, and reads it back", () => {
    expect(joinLink("7KQ2")).toBe("https://wa.me/66812345678?text=JOIN-7KQ2");
    expect(codeInJoinText("JOIN-7KQ2")).toBe("7KQ2");
    // Typed by hand, with a space or with nothing between.
    expect(codeInJoinText("JOIN 7KQ2")).toBe("7KQ2");
    expect(codeInJoinText("please join7KQ2")).toBe("7KQ2");
    // The prefix is ours and matches either way; the code is handed back exactly as typed, because
    // CODE_ALPHABET is mixed case and "7kq2" is not the same match as "7KQ2".
    expect(codeInJoinText("  join-7kq2  ")).toBe("7kq2");
    expect(codeInJoinText("hello there")).toBe(null);
    expect(codeInJoinText("rejoin later")).toBe(null);
    // A JOIN takes a seat, so only a message that is a JOIN and nothing more: these words are valid codes.
    expect(codeInJoinText("Can I join this?")).toBe(null);
    expect(codeInJoinText("I want to join next Saturday")).toBe(null);
    expect(codeInJoinText("join next week")).toBe(null);
    expect(codeInJoinText("join your game")).toBe(null);
    expect(codeInJoinText("please join 7KQ2!")).toBe("7KQ2");
  });

  it("offers the hand-off only where a reply can come back: no page offers a chat nobody answers", () => {
    for (const key of ["WHATSAPP_NUMBER", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_APP_SECRET"]) {
      const was = process.env[key];
      delete process.env[key];
      expect({ key, link: joinLink("7KQ2") }).toEqual({ key, link: null });
      process.env[key] = was;
    }
    expect(joinLink("7KQ2")).not.toBeNull();
  });

  it("reads a match link pasted into the thread, on this deployment's address only", () => {
    expect(codeInMatchUrl("https://kicksma.sh/7KQ2?s=wa", "kicksma.sh")).toBe("7KQ2");
    expect(codeInMatchUrl("look: kicksma.sh/7KQ2.", "kicksma.sh")).toBe("7KQ2");
    expect(codeInMatchUrl("https://www.kicksma.sh/7KQ2/i/abc123", "kicksma.sh")).toBe("7KQ2");
    expect(codeInMatchUrl("https://example.com/7KQ2", "kicksma.sh")).toBe(null);
    expect(codeInMatchUrl("https://kicksma.sh/coaches", "kicksma.sh")).toBe(null);
    expect(codeInMatchUrl("https://kicksma.sh/play", "kicksma.sh")).toBe(null);
  });

  it("hears a tapped button as the id behind it, not the words on it", () => {
    expect(readInbound(textMessage("66810000001", "hello"))).toEqual({ text: "hello", tappedId: null });
    expect(readInbound(tap("66810000001", "wj:7KQ2", "I'm in"))).toEqual({ text: "I'm in", tappedId: "wj:7KQ2" });
  });

  it("keeps a number only once, however Meta spells it", async () => {
    const first = await findOrCreateWhatsappPlayer(db, "66810000009", "Somchai");
    const again = await findOrCreateWhatsappPlayer(db, "+66810000009", "Somchai");
    expect(again.id).toBe(first.id);
    expect(first.displayName).toBe("Somchai");
  });

  it("takes the seat on JOIN at once: two taps, the link and Send, and the reply is the line-up with three buttons", async () => {
    const org = await makePlayer(db, "Organiser");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 24 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });

    expect(await handleWhatsappMessage(db, textMessage("66810000002", `JOIN-${ev.code}`), { wa_id: "66810000002", profile: { name: "Nok" } })).toBe("wa:joined");
    const nok = await findOrCreateWhatsappPlayer(db, "66810000002");
    expect((await db.select().from(slots).where(and(eq(slots.eventId, ev.id), eq(slots.playerId, nok.id)))).length).toBe(1);
    const reply = sent.at(-1)!;
    expect(reply.type).toBe("interactive");
    expect(reply.body).toContain("You are in");
    expect(reply.body).toContain("Rawai Padel");
    expect(reply.body).toContain("In so far: Organiser, Nok. 2 to find.");
    expect(reply.body).toContain(`/${ev.code}`);
    expect(reply.buttons.map((b) => b.id)).toEqual([`wl:${ev.code}`, `ww:${ev.code}`, `wc:${ev.code}`]);
    expect(reply.buttons.map((b) => b.title)).toEqual(["Can't make it", "Who else is in?", "Add to calendar"]);

    // Sent again, typed by hand with a space: the seat is already theirs.
    expect(await handleWhatsappMessage(db, textMessage("66810000002", `JOIN ${ev.code}`))).toBe("wa:already_in");
    expect(sent.at(-1)?.body).toContain("You are already in this one.");
    expect(await handleWhatsappMessage(db, tap("66810000002", `ww:${ev.code}`, "Who else is in?"))).toBe("wa:lineup");
    expect(await handleWhatsappMessage(db, tap("66810000002", `wl:${ev.code}`, "Can't make it"))).toBe("wa:left");
    expect(await handleWhatsappMessage(db, tap("66810000002", `wl:${ev.code}`, "Can't make it"))).toBe("wa:not_in");
    // "I'm in" under a shown match takes the seat the same way.
    expect(await handleWhatsappMessage(db, tap("66810000002", `wj:${ev.code}`, "I'm in"))).toBe("wa:joined");
  });

  it("shows a pasted match link or a bare code without taking a seat: a link is not a yes", async () => {
    process.env.APP_BASE_URL = "https://kicksma.sh";
    const org = await makePlayer(db, "Link organiser");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 24 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    expect(await handleWhatsappMessage(db, textMessage("66810000006", `hey https://kicksma.sh/${ev.code}?s=wa`))).toBe("wa:match");
    expect(sent.at(-1)?.buttons.map((b) => b.id)).toEqual([`wj:${ev.code}`, `wl:${ev.code}`, `ww:${ev.code}`]);
    expect(await handleWhatsappMessage(db, textMessage("66810000006", ev.code))).toBe("wa:match");
    const p = await findOrCreateWhatsappPlayer(db, "66810000006");
    expect((await db.select().from(slots).where(eq(slots.playerId, p.id))).length).toBe(0);
  });

  it("answers the calendar button with the player's own calendar page, never a personal link", async () => {
    const org = await makePlayer(db, "Calendar organiser");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 24 * HOUR), tz: "Asia/Bangkok", whenFull: "waitlist" });
    expect(await handleWhatsappMessage(db, textMessage("66810000007", `JOIN-${ev.code}`))).toBe("wa:joined");
    expect(await handleWhatsappMessage(db, tap("66810000007", `wc:${ev.code}`, "Add to calendar"))).toBe("wa:calendar");
    const reply = sent.at(-1)!;
    expect(reply.body).toMatch(/\/p\/[0-9a-f]{52}\/calendar/);
    const p = await findOrCreateWhatsappPlayer(db, "66810000007");
    const [row] = await db.select().from(players).where(eq(players.id, p.id));
    expect(reply.body).not.toContain(row.personalToken!);
  });

  it("answers what it cannot place with help that says what the bot does, and a cancelled match by saying so", async () => {
    expect(await handleWhatsappMessage(db, textMessage("66810000003", "good morning"))).toBe("wa:help");
    expect(sent.at(-1)?.body).toMatch(/JOIN 7KQ2.*put you in at once.*match link.*Once you are in.*can't make it.*who is in.*calendar/s);
    // "Can I join this?" is a question, not a JOIN: help, never a stranger's match.
    expect(await handleWhatsappMessage(db, textMessage("66810000003", "Can I join this?"))).toBe("wa:help");
    expect(await handleWhatsappMessage(db, textMessage("66810000003", "ZZZZ"))).toBe("wa:gone");
  });

  it("sends a level-ranged match to the organiser rather than round its rules", async () => {
    const org = await makePlayer(db, "Ranged organiser");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 24 * HOUR), tz: "Asia/Bangkok", whenFull: "waitlist", levelMin: 3, levelMax: 4 });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    // A player whose level nobody knows is asked for it, not quietly admitted: buttons from the match's own range, no link out of the chat.
    expect(await handleWhatsappMessage(db, tap("66810000004", `wj:${ev.code}`, "I'm in"))).toBe("wa:level_required");
    const ask = sent.at(-1)!;
    expect(ask.body).toContain("3.0–4.0");
    expect(ask.body).not.toMatch(/https?:/);
    expect(ask.buttons.map((b) => b.id)).toEqual([`wv:${ev.code}:300`, `wv:${ev.code}:350`, `wv:${ev.code}:400`]);
    expect(ask.buttons.map((b) => b.title)).toEqual(["3.0", "3.5", "4.0"]);
    // The tap saves the number tapped as the player's own declaration, and joins.
    expect(await handleWhatsappMessage(db, tap("66810000004", `wv:${ev.code}:350`, "3.5"))).toBe("wa:joined");
    const four = await findOrCreateWhatsappPlayer(db, "66810000004");
    expect(four.level).toBe(3.5);
    expect(four.levelSource).toBe("self");
    // A button that names no level is not a level.
    expect(await handleWhatsappMessage(db, tap("66810000004", `wv:${ev.code}:wizard`, "Wizard"))).toBe("wa:help");
    // And one outside the range becomes a request the organiser answers. This is the whole reason the
    // rules live in the domain: a second copy here would be a way around the first.
    const low = await findOrCreateWhatsappPlayer(db, "66810000005", "Low");
    await db.update(players).set({ level: 1 }).where(eq(players.id, low.id));
    expect(await handleWhatsappMessage(db, tap("66810000005", `wj:${ev.code}`, "I'm in"))).toBe("wa:requested");
  });

  it("offers levels a 4.5–7 match can take, keeps a level set since, and asks the organiser when the match wants confirmed levels", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "1:test";
    const org = await makePlayer(db, "Platinum organiser", { telegramId: 4242 });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 24 * HOUR), tz: "Asia/Bangkok", whenFull: "waitlist", levelMin: 4.5, levelMax: 7 });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    expect(await handleWhatsappMessage(db, tap("66810000030", `wj:${ev.code}`, "I'm in"))).toBe("wa:level_required");
    // A range with no top is stored as "4.5 and up": its bottom and the two half-steps above, every one of them a way in.
    expect(sent.at(-1)!.buttons.map((b) => b.title)).toEqual(["4.5", "5.0", "5.5"]);
    expect(await handleWhatsappMessage(db, tap("66810000030", `wv:${ev.code}:550`, "5.5"))).toBe("wa:joined");
    expect((await findOrCreateWhatsappPlayer(db, "66810000030")).level).toBe(5.5);
    // An old button from another match never overwrites the level the player has now.
    expect(await handleWhatsappMessage(db, tap("66810000030", `wv:${ev.code}:450`, "4.5"))).toBe("wa:already_in");
    expect((await findOrCreateWhatsappPlayer(db, "66810000030")).level).toBe(5.5);
    // Confirmed levels only: a declared level inside the range is a request, and the organiser hears of it, as the reply promises.
    const strict = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 24 * HOUR), tz: "Asia/Bangkok", whenFull: "waitlist", levelMin: 4.5, levelMax: 7, levelVerifiedOnly: true });
    await joinEvent(db, { eventId: strict.id, playerId: org.id });
    urls = [];
    expect(await handleWhatsappMessage(db, tap("66810000031", `wj:${strict.code}`, "I'm in"))).toBe("wa:level_required");
    expect(await handleWhatsappMessage(db, tap("66810000031", `wv:${strict.code}:450`, "4.5"))).toBe("wa:requested");
    expect(sent.filter((x) => x.to === "66810000031").at(-1)?.body).toContain("organiser decides");
    expect(urls.some((u) => u.includes("api.telegram.org"))).toBe(true);
  });

  it("says a played match is over before it asks or saves anything", async () => {
    const org = await makePlayer(db, "Last week organiser");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() - 48 * HOUR), tz: "Asia/Bangkok", whenFull: "waitlist", levelMin: 3, levelMax: 4.5 });
    expect(await handleWhatsappMessage(db, textMessage("66810000032", `JOIN-${ev.code}`))).toBe("wa:past");
    expect(await handleWhatsappMessage(db, tap("66810000032", `wv:${ev.code}:350`, "3.5"))).toBe("wa:past");
    expect((await findOrCreateWhatsappPlayer(db, "66810000032")).level).toBeNull();
  });

  it("gives a number the seat the organiser held for it, and counts a new number whose name is already in", async () => {
    const org = await makePlayer(db, "Holding organiser");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 24 * HOUR), tz: "Asia/Bangkok", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    const held = await reserveSlot(db, { eventId: ev.id, actorPlayerId: org.id, name: "Pim", phone: "+66 81 000 0033" });
    expect(await handleWhatsappMessage(db, textMessage("66810000033", `JOIN-${ev.code}`), { wa_id: "66810000033", profile: { name: "Pim" } })).toBe("wa:confirmed");
    const pim = await findOrCreateWhatsappPlayer(db, "66810000033");
    const [slot] = await db.select().from(slots).where(eq(slots.id, held.slot.id));
    expect(slot.playerId).toBe(pim.id);
    expect(slot.status).toBe("confirmed");
    // Another number whose WhatsApp name is a name already in the match: a second Pim, counted as the web counts it.
    const day = NOW.toISOString().slice(0, 10);
    const count = async () => Number((await db.select().from(metricsDaily).where(and(eq(metricsDaily.day, day), eq(metricsDaily.key, "newid_name_here"))))[0]?.value ?? 0);
    const before = await count();
    expect(await handleWhatsappMessage(db, textMessage("66810000034", `JOIN-${ev.code}`), { wa_id: "66810000034", profile: { name: "Pim" } })).toBe("wa:joined");
    expect(await count()).toBe(before + 1);
  });

  it("answers one message once, however many times Meta delivers it", async () => {
    const org = await makePlayer(db, "Twice organiser");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 24 * HOUR), tz: "Asia/Bangkok", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    const msg = textMessage("66810000035", `JOIN-${ev.code}`);
    const [first, second] = await Promise.all([handleWhatsappMessage(db, msg, { wa_id: "66810000035", profile: { name: "Nok" } }), handleWhatsappMessage(db, msg, { wa_id: "66810000035", profile: { name: "Nok" } })]);
    expect([first, second].sort()).toEqual(["wa:duplicate", "wa:joined"]);
    expect((await db.select().from(players).where(eq(players.phone, "+66810000035"))).length).toBe(1);
  });

  it("cuts a button title to what Meta accepts rather than being refused for it", () => {
    expect(LIMITS.buttonTitle).toBe(20);
    expect(LIMITS.buttons).toBe(3);
  });

  // ------------------------------------------------------------------ LINK- from the match page

  /** A player who joined on the web, as the match page's "stay updated" card sees them. */
  async function webPlayerInAMatch(name: string, token: string) {
    const org = await makePlayer(db, `${name}'s organiser`);
    const web = await makePlayer(db, name, { personalToken: token });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 24 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    await joinEvent(db, { eventId: ev.id, playerId: web.id });
    return { org, web, ev };
  }
  /** What the card puts in the player's WhatsApp, read back out of the wa.me link. */
  const typedFrom = (link: string) => new URL(link).searchParams.get("text")!;
  const seatsOf = async (eventId: string, playerId: string) => (await db.select().from(slots).where(and(eq(slots.eventId, eventId), eq(slots.playerId, playerId)))).length;

  it("offers the link only where a reply can come back: a number, the app secret and the send token", async () => {
    const { web, ev } = await webPlayerInAMatch("Pim", "Pm2kLm5nPq6r");
    expect(bindLink(web, ev.code)).toMatch(new RegExp(`^https://wa\\.me/66812345678\\?text=LINK-${ev.code}-[0-9a-f]{32}_`));
    expect(whatsappLinkable()).toBe(true);
    for (const key of ["WHATSAPP_NUMBER", "WHATSAPP_APP_SECRET", "WHATSAPP_TOKEN"]) {
      const was = process.env[key];
      delete process.env[key];
      expect(bindLink(web, ev.code)).toBeNull();
      process.env[key] = was;
    }
  });

  it("links the number to the web player, takes no second seat and makes no second row, and answers with the match and the calendar", async () => {
    const { web, ev } = await webPlayerInAMatch("Nok", "Nk2kLm5nPq6r");
    const before = (await db.select({ id: players.id }).from(players)).length;
    const text = typedFrom(bindLink(web, ev.code)!);
    expect(bindInText(text)).toEqual({ code: ev.code, ticket: expect.stringMatching(/^[0-9a-f]{32}_/) });

    expect(await handleWhatsappMessage(db, textMessage("66810000020", text), { wa_id: "66810000020", profile: { name: "Nok WA" } })).toBe("wa:linked");
    const [linked] = await db.select().from(players).where(eq(players.id, web.id));
    expect(linked.phone).toBe("+66810000020");
    expect((await db.select({ id: players.id }).from(players)).length).toBe(before);
    expect(await seatsOf(ev.id, web.id)).toBe(1);
    // The reply: the match, and the calendar's page — never the personal link, which signs in whoever holds it.
    const reply = sent.at(-1)!;
    expect(reply.to).toBe("66810000020");
    expect(reply.body).toContain("Rawai Padel");
    expect(reply.body).toContain(`/${ev.code}`);
    expect(reply.body).toMatch(/\/p\/[0-9a-f]{52}\/calendar/);
    expect(reply.body).not.toContain("Nk2kLm5nPq6r");
    // Sent twice, it is the same answer; the number already belongs to Nok.
    expect(await handleWhatsappMessage(db, textMessage("66810000020", text))).toBe("wa:linked");
    // From now on this thread is Nok's: a tap here acts for the web player.
    expect(await handleWhatsappMessage(db, tap("66810000020", `wj:${ev.code}`, "I'm in"))).toBe("wa:already_in");
  });

  it("folds a row this number already had into the web player, one seat where both held one", async () => {
    const { web, ev } = await webPlayerInAMatch("Ploy", "Py2kLm5nPq6r");
    // Earlier, from the crew's group: JOIN- made a WhatsApp row for this number and took a seat with it.
    expect(await handleWhatsappMessage(db, textMessage("66810000021", `JOIN-${ev.code}`), { wa_id: "66810000021", profile: { name: "Ploy" } })).toBe("wa:joined");
    const waRow = await findOrCreateWhatsappPlayer(db, "66810000021");
    expect(waRow.id).not.toBe(web.id);
    expect(await seatsOf(ev.id, waRow.id)).toBe(1);

    expect(await handleWhatsappMessage(db, textMessage("66810000021", typedFrom(bindLink(web, ev.code)!)))).toBe("wa:linked");
    const [gone] = await db.select().from(players).where(eq(players.id, waRow.id));
    expect(gone).toBeUndefined();
    expect((await db.select().from(players).where(eq(players.phone, "+66810000021"))).map((p) => p.id)).toEqual([web.id]);
    expect(await seatsOf(ev.id, web.id)).toBe(1);
    expect(await seatsOf(ev.id, waRow.id)).toBe(0);
  });

  it("refuses a forged or stale code, and creates nobody for it", async () => {
    const { web, ev } = await webPlayerInAMatch("Mai", "Ma2kLm5nPq6r");
    const text = typedFrom(bindLink(web, ev.code)!);
    const before = (await db.select({ id: players.id }).from(players)).length;
    const forged = text.replace(/[0-9a-f]$/, (c) => (c === "0" ? "1" : "0"));
    expect(await handleWhatsappMessage(db, textMessage("66810000022", forged))).toBe("wa:link_bad");
    expect(sent.at(-1)?.body).toMatch(/too old/);
    // Signed with another secret: the webhook's own secret is the only one that makes a code.
    process.env.WHATSAPP_APP_SECRET = "somebody-else";
    const foreign = typedFrom(bindLink(web, ev.code)!);
    process.env.WHATSAPP_APP_SECRET = SECRET;
    expect(await handleWhatsappMessage(db, textMessage("66810000022", foreign))).toBe("wa:link_bad");
    // Three days on, the code has expired.
    expect(verifyBindTicket(bindInText(text)!.ticket, web, new Date(NOW.getTime() + 3 * 24 * HOUR))).toBe(false);
    expect((await db.select({ id: players.id }).from(players)).length).toBe(before);
    const [untouched] = await db.select().from(players).where(eq(players.id, web.id));
    expect(untouched.phone).toBeNull();
  });

  it("leaves the calendar out of the reply for a player whose address already brings an invitation per match", async () => {
    process.env.RESEND_API_KEY = "re_test_only";
    const { web, ev } = await webPlayerInAMatch("Dao", "Da2kLm5nPq6r");
    await db.update(players).set({ email: "dao@example.com" }).where(eq(players.id, web.id));
    expect(await handleWhatsappMessage(db, textMessage("66810000024", typedFrom(bindLink(web, ev.code)!)))).toBe("wa:linked");
    expect(sent.at(-1)?.body).toContain(`/${ev.code}`);
    expect(sent.at(-1)?.body).not.toContain("/calendar");
    delete process.env.RESEND_API_KEY;
  });

  it("never shows a linked number to an organiser: the list of past players keeps only what they typed", async () => {
    const { org, web, ev } = await webPlayerInAMatch("Fah", "Fh2kLm5nPq6r");
    expect(await handleWhatsappMessage(db, textMessage("66810000023", typedFrom(bindLink(web, ev.code)!)))).toBe("wa:linked");
    const entry = (await getRolodex(db, org.id)).find((r) => r.playerId === web.id);
    expect(entry).toBeDefined();
    expect(entry!.phone).toBeNull();
  });
});
