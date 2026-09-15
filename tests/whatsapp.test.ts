import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { createEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { codeInJoinText, joinLink } from "@/lib/whatsapp/link";
import { LIMITS, readInbound, verifySignature, whatsappEnabled, type WaInboundMessage } from "@/lib/whatsapp/api";
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
});
