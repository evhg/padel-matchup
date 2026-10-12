import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { clubs, events, metricsDaily } from "@/db/schema";
import { dayKey, setMetric } from "@/lib/domain/metrics";
import { LIMITS } from "@/lib/domain/ratelimit";
import type { WaInboundMessage } from "@/lib/whatsapp/api";
import { handleWhatsappMessage } from "@/lib/whatsapp/bot";
import { freezeClock } from "./helpers/clock";
import { createTestDb } from "./helpers/db";

/**
 * "Paste your booking" in the WhatsApp thread (the owner, 11 October 2026: "I can share the booking page
 * link from ie. Padel Society to a tg or whatsapp bot"). Until then the thread answered a pasted booking
 * with its help. The thread answers once with what it read and the filled create form; the form makes
 * the match. Every outbound call goes to a fake WhatsApp API: no test here reaches Meta or a platform.
 * NOW is Sunday 11 October 2026, 05:00 UTC, 12:00 in Phuket.
 */
const NOW = new Date("2026-10-11T05:00:00.000Z");
freezeClock(NOW);
const LINK = "https://thepadelsociety.app.link/AbCdEf12345";

let seq = 0;
const text = (from: string, body: string): WaInboundMessage => ({ from, id: `wamid.p${++seq}`, timestamp: "0", type: "text", text: { body } });

describe("a booked court pasted into the WhatsApp thread", () => {
  let db: Db;
  let close: () => Promise<void>;
  /** What the thread sent, in order. */
  let sent: { to: string; body: string }[] = [];
  /** Every address outside the WhatsApp API: a pasted link is read at most once, as a chat app's preview robot reads it. */
  let outside: string[] = [];

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await db.insert(clubs).values({ slug: "warehaus", name: "WAREHAUS.club", manageToken: "tok-warehaus-wa-paste-abcdefghijklmnop", source: "directory", tz: "Asia/Bangkok" });
  });
  afterAll(async () => close());
  beforeEach(() => {
    process.env.WHATSAPP_TOKEN = "t";
    process.env.WHATSAPP_PHONE_ID = "123";
    process.env.WHATSAPP_NUMBER = "+66 81 234 5678";
    process.env.APP_BASE_URL = "https://kicksma.sh";
    sent = [];
    outside = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://graph.facebook.com/")) {
        outside.push(url);
        return new Response("not found", { status: 404 });
      }
      const b = JSON.parse(String(init?.body)) as { to: string; text?: { body: string }; interactive?: { body: { text: string } } };
      sent.push({ to: b.to, body: b.text?.body ?? b.interactive?.body.text ?? "" });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const matches = async () => (await db.select({ id: events.id }).from(events)).length;

  it("answers the owner's words with what it read and the filled form, in the club's zone, and makes no match", async () => {
    const before = await matches();
    const out = await handleWhatsappMessage(db, text("66810000001", "Warehaus Mon 12 Oct 18:00-19:30 court 3 with Danny, Alberto"), { wa_id: "66810000001", profile: { name: "Cath" } });
    expect(out).toBe("wa:paste_read");
    expect(sent).toHaveLength(1);
    const [head, next, url] = sent[0].body.split("\n");
    expect(head).toBe("📋 WAREHAUS.club, Mon, Oct 12, 18:00–19:30, court 3, with Danny and Alberto");
    expect(next).toBe("Check it on the form, then tap Create:");
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ src: "paste", venue: "WAREHAUS.club", date: "2026-10-12", time: "18:00", tz: "Asia/Bangkok", len: "90", court: "3", names: "Danny,Alberto", booked: "1" });
    // The words said everything: no link was read, and the form makes the match, not the thread.
    expect(outside).toEqual([]);
    expect(await matches()).toBe(before);
  });

  it("answers a Padel Society link alone with what it does not say, and a form with no zone, never UTC", async () => {
    const out = await handleWhatsappMessage(db, text("66810000002", LINK), { wa_id: "66810000002", profile: { name: "Ana" } });
    expect(out).toBe("wa:paste_missing:club,date,time");
    const [head, next, url] = sent[0].body.split("\n");
    expect(head).toBe("📋 A booking on The Padel Society");
    expect(next).toBe("Your booking does not say the club, the day or the time. Fill it in on the form, then tap Create:");
    const form = new URL(url);
    expect(form.searchParams.get("tz")).toBeNull();
    expect(form.searchParams.get("invite")).toBe(LINK);
    // One read of the link, as for a paste on the web or in Telegram (DECIDING rule 35).
    expect(outside).toEqual([LINK]);
  });

  it("answers in the player's language", async () => {
    await handleWhatsappMessage(db, text("66810000003", "hola"), { wa_id: "66810000003", profile: { name: "Nuria" } });
    const { players } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(players).set({ locale: "es" }).where(eq(players.phone, "+66810000003"));
    sent = [];
    await handleWhatsappMessage(db, text("66810000003", "Warehaus lun 12 oct 18:00"), { wa_id: "66810000003", profile: { name: "Nuria" } });
    expect(sent[0].body.split("\n")[1]).toBe("Compruébalo en el formulario y toca Crear:");
  });

  it("still answers anything that is no booking with the help, and a day and a time at no listed club too", async () => {
    expect(await handleWhatsappMessage(db, text("66810000004", "hello there"), { wa_id: "66810000004", profile: { name: "Bo" } })).toBe("wa:help");
    expect(await handleWhatsappMessage(db, text("66810000004", "tomorrow 18:00 at the beach"), { wa_id: "66810000004", profile: { name: "Bo" } })).toBe("wa:help");
    expect(sent.map((m) => m.body.startsWith("📋"))).toEqual([false, false]);
  });

  it("stops at the day's thirty pastes for one person, and says so", async () => {
    await handleWhatsappMessage(db, text("66810000005", "hi"), { wa_id: "66810000005", profile: { name: "Lim" } });
    const { players } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [lim] = await db.select().from(players).where(eq(players.phone, "+66810000005"));
    await setMetric(db, `rl:paste:wa:${lim.id}`, LIMITS.bookingPastesPerIpPerDay, dayKey(NOW));
    sent = [];
    expect(await handleWhatsappMessage(db, text("66810000005", "Warehaus Mon 12 Oct 18:00"), { wa_id: "66810000005", profile: { name: "Lim" } })).toBe("wa:paste_limit");
    expect(sent[0].body).toBe("You sent thirty bookings today. That is the limit. Try again tomorrow.");
    await db.delete(metricsDaily);
  });
});
