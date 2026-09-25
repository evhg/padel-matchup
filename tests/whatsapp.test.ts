import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { and, eq } from "drizzle-orm";
import { players, slots } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { getRolodex } from "@/lib/domain/queries";
import { joinEvent } from "@/lib/domain/slots";
import { bindInText, bindLink, codeInJoinText, joinLink, verifyBindTicket } from "@/lib/whatsapp/link";
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
  /** Every outbound call, so a test can read what the player was actually told. */
  let sent: { to: string; type: string; body: string }[] = [];

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
      const b = JSON.parse(init.body) as { to: string; type: string; text?: { body: string }; interactive?: { body: { text: string } } };
      sent.push({ to: b.to, type: b.type, body: b.text?.body ?? b.interactive?.body.text ?? "" });
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
    delete process.env.WHATSAPP_NUMBER;
    expect(joinLink("7KQ2")).toBe(null);
    expect(codeInJoinText("JOIN-7KQ2")).toBe("7KQ2");
    // The prefix is ours and matches either way; the code is handed back exactly as typed, because
    // CODE_ALPHABET is mixed case and "7kq2" is not the same match as "7KQ2".
    expect(codeInJoinText("  join-7kq2  ")).toBe("7kq2");
    expect(codeInJoinText("hello there")).toBe(null);
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

  it("shows the match, then puts the player in it, then takes them out", async () => {
    const org = await makePlayer(db, "Organiser");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 24 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });

    expect(await handleWhatsappMessage(db, textMessage("66810000002", `JOIN-${ev.code}`), { wa_id: "66810000002", profile: { name: "Nok" } })).toBe("wa:match");
    expect(sent.at(-1)?.type).toBe("interactive");
    expect(sent.at(-1)?.body).toContain("Rawai Padel");

    expect(await handleWhatsappMessage(db, tap("66810000002", `wj:${ev.code}`, "I'm in"))).toBe("wa:joined");
    expect(sent.at(-1)?.body).toContain("You are in");

    expect(await handleWhatsappMessage(db, tap("66810000002", `wj:${ev.code}`, "I'm in"))).toBe("wa:already_in");
    expect(await handleWhatsappMessage(db, tap("66810000002", `wl:${ev.code}`, "Can't make it"))).toBe("wa:left");
    expect(await handleWhatsappMessage(db, tap("66810000002", `wl:${ev.code}`, "Can't make it"))).toBe("wa:not_in");
  });

  it("answers a code it cannot place with help, and a cancelled match by saying so", async () => {
    expect(await handleWhatsappMessage(db, textMessage("66810000003", "good morning"))).toBe("wa:help");
    expect(await handleWhatsappMessage(db, textMessage("66810000003", "ZZZZ"))).toBe("wa:gone");
  });

  it("sends a level-ranged match to the organiser rather than round its rules", async () => {
    const org = await makePlayer(db, "Ranged organiser");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 24 * HOUR), tz: "Asia/Bangkok", whenFull: "waitlist", levelMin: 3, levelMax: 4 });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    // A player whose level nobody knows is asked for it, not quietly admitted.
    expect(await handleWhatsappMessage(db, tap("66810000004", `wj:${ev.code}`, "I'm in"))).toBe("wa:level_required");
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
    expect(await handleWhatsappMessage(db, textMessage("66810000021", `JOIN-${ev.code}`), { wa_id: "66810000021", profile: { name: "Ploy" } })).toBe("wa:match");
    expect(await handleWhatsappMessage(db, tap("66810000021", `wj:${ev.code}`, "I'm in"))).toBe("wa:joined");
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
