import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { and, eq } from "drizzle-orm";
import { players, slots } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { getRolodex } from "@/lib/domain/queries";
import { joinEvent } from "@/lib/domain/slots";
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

const textMessage = (from: string, body: string): WaInboundMessage => ({ from, id: "wamid.1", timestamp: "0", type: "text", text: { body } });
const tap = (from: string, id: string, title: string): WaInboundMessage => ({ from, id: "wamid.2", timestamp: "0", type: "interactive", interactive: { type: "button_reply", button_reply: { id, title } } });

describe("the WhatsApp channel", () => {
  let db: Db;
  let close: () => Promise<void>;
  /** Every outbound call, so a test can read what the player was actually told, and which buttons came with it. */
  let sent: { to: string; type: string; body: string; buttons: { id: string; title: string }[] }[] = [];

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
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
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
    expect(sent.at(-1)?.body).toMatch(/JOIN 7KQ2.*put you in at once.*match link.*can't make it.*who is in.*calendar/s);
    expect(await handleWhatsappMessage(db, textMessage("66810000003", "ZZZZ"))).toBe("wa:gone");
  });

  it("sends a level-ranged match to the organiser rather than round its rules", async () => {
    const org = await makePlayer(db, "Ranged organiser");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 24 * HOUR), tz: "Asia/Bangkok", whenFull: "waitlist", levelMin: 3, levelMax: 4 });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    // A player whose level nobody knows is asked for it, not quietly admitted: three buttons, no link out of the chat.
    expect(await handleWhatsappMessage(db, tap("66810000004", `wj:${ev.code}`, "I'm in"))).toBe("wa:level_required");
    const ask = sent.at(-1)!;
    expect(ask.body).toContain("3.0–4.0");
    expect(ask.body).not.toMatch(/https?:/);
    expect(ask.buttons.map((b) => b.id)).toEqual([`wv:${ev.code}:beginner`, `wv:${ev.code}:intermediate`, `wv:${ev.code}:advanced`]);
    // The tap saves the middle of the band as the player's own declaration, and joins: 3.0 is inside 3–4.
    expect(await handleWhatsappMessage(db, tap("66810000004", `wv:${ev.code}:intermediate`, "Intermediate"))).toBe("wa:joined");
    const four = await findOrCreateWhatsappPlayer(db, "66810000004");
    expect(four.level).toBe(3);
    expect(four.levelSource).toBe("self");
    // A band nobody offered is not a level.
    expect(await handleWhatsappMessage(db, tap("66810000004", `wv:${ev.code}:wizard`, "Wizard"))).toBe("wa:help");
    // And one outside the range becomes a request the organiser answers. This is the whole reason the
    // rules live in the domain: a second copy here would be a way around the first.
    const low = await findOrCreateWhatsappPlayer(db, "66810000005", "Low");
    await db.update((await import("@/db/schema")).players).set({ level: 1 }).where((await import("drizzle-orm")).eq((await import("@/db/schema")).players.id, low.id));
    expect(await handleWhatsappMessage(db, tap("66810000005", `wj:${ev.code}`, "I'm in"))).toBe("wa:requested");
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
