import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, facts, metricsDaily, type Player } from "@/db/schema";
import { nudgeForScore, sendWaResults } from "@/lib/afterMatch";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { channelFor, tell } from "@/lib/coach/notify";
import { REFILL_WHATSAPP_MAX } from "@/lib/config";
import { createEvent } from "@/lib/domain/events";
import { dayKey } from "@/lib/domain/metrics";
import { saveMatchScore } from "@/lib/domain/scores";
import { joinEvent } from "@/lib/domain/slots";
import { notifyEventUpdated, notifyRefill } from "@/lib/notify";
import { readInbound, type WaInboundMessage } from "@/lib/whatsapp/api";
import { handleWhatsappMessage } from "@/lib/whatsapp/bot";
import { templatePayload, variablesOf, WA_LOCALES, WA_TEMPLATES, type WaTemplateName } from "@/lib/whatsapp/templates";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";

/**
 * A player who linked WhatsApp on the match page was promised that the match's changes, a free spot
 * and the result card reach them there (the owner, 26 September 2026). Outside the 24-hour window
 * WhatsApp carries only a template Meta approved, so these are the rules for the four templates:
 * what Meta will accept, who gets which one, what happens when one cannot go, and the one thing a
 * WhatsApp button may never carry, which is a way to sign in as somebody.
 */
const NOW = new Date("2026-09-14T09:00:00.000Z");
freezeClock(NOW);

type Sent = { to: string; name: string; language: string; body: string[]; url: string | null; quickReply: string | null; image: string | null };
/** Every template the stub was asked to deliver, as a reader of the message would see its parts. */
let sent: Sent[] = [];
/** Every other request: the Telegram API, the card picture being warmed. */
let other: string[] = [];
/** Meta refuses every template while this is on, as it does one it has not approved. */
let refuse = false;

function stub() {
  sent = [];
  other = [];
  refuse = false;
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes("graph.facebook.com")) {
      other.push(u);
      const result = u.includes("/sendMessage") ? { message_id: 1, chat: { id: 1 } } : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const b = JSON.parse(String(init?.body ?? "{}")) as { to: string; type: string; template?: { name: string; language: { code: string }; components: { type: string; sub_type?: string; parameters: { type: string; text?: string; payload?: string; image?: { link: string } }[] }[] } };
    if (b.type !== "template" || !b.template) {
      other.push(`wa:${b.type}`);
      return new Response(JSON.stringify({ messages: [{ id: "wamid.reply" }] }), { status: 200 });
    }
    if (refuse) return new Response(JSON.stringify({ error: { message: "Template name does not exist in the translation" } }), { status: 404 });
    const part = (type: string, sub?: string) => b.template!.components.find((c) => c.type === type && (!sub || c.sub_type === sub));
    sent.push({
      to: b.to,
      name: b.template.name,
      language: b.template.language.code,
      body: part("body")?.parameters.map((p) => p.text ?? "") ?? [],
      url: part("button", "url")?.parameters[0]?.text ?? null,
      quickReply: part("button", "quick_reply")?.parameters[0]?.payload ?? null,
      image: part("header")?.parameters[0]?.image?.link ?? null,
    });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.template" }] }), { status: 200 });
  });
}

/**
 * A URL button's variable part opens a public match page, never a personal link: a forwarded message
 * keeps its buttons. (A code may itself end in "p", so "7KQp/card" is public; `/p/` as a path is not.)
 */
const PUBLIC = /^[A-Za-z0-9]{4}(\/card)?$/;
const allPublic = () => sent.every((s) => s.url === null || (PUBLIC.test(s.url) && !/(^|\/)p\//.test(s.url)));

describe("the WhatsApp templates Meta will approve", () => {
  const letters = /\p{L}/u;
  const pieces = (body: string) => body.split(/\{\{\d+\}\}/);

  it("are the four notices, each a utility template in English, Russian and Spanish", () => {
    expect(WA_TEMPLATES.map((t) => t.name).sort()).toEqual(["ks_match_result", "ks_match_update", "ks_score_ask", "ks_spot_open"]);
    for (const t of WA_TEMPLATES) {
      expect(t.category, t.name).toBe("UTILITY");
      expect(Object.keys(t.languages).sort(), t.name).toEqual([...WA_LOCALES].sort());
    }
    const shape = (name: WaTemplateName) => WA_TEMPLATES.find((t) => t.name === name)!;
    expect(shape("ks_spot_open").buttons.map((b) => b.type)).toEqual(["QUICK_REPLY", "URL"]);
    expect(shape("ks_match_result").header).toBe("IMAGE");
    expect(Object.fromEntries(WA_TEMPLATES.map((t) => [t.name, new Set(variablesOf(t.languages.en.body)).size]))).toEqual({ ks_match_update: 2, ks_spot_open: 3, ks_score_ask: 1, ks_match_result: 2 });
  });

  it("keep Meta's rules in every language: no variable first or last, {{1}}…{{n}} in order, none side by side, short enough", () => {
    for (const t of WA_TEMPLATES) {
      const counts = new Set<number>();
      for (const l of WA_LOCALES) {
        const lang = t.languages[l];
        const where = `${t.name}/${l}`;
        const vars = variablesOf(lang.body);
        const order = [...new Set(vars)];
        expect(order, `${where}: numbered from 1, in order, none skipped`).toEqual(order.map((_, i) => i + 1));
        counts.add(order.length);
        const between = pieces(lang.body);
        expect(letters.test(between[0]), `${where} starts with a variable`).toBe(true);
        expect(letters.test(between.at(-1)!), `${where} ends with a variable`).toBe(true);
        for (const middle of between.slice(1, -1)) expect(middle.trim().length, `${where} has two variables side by side`).toBeGreaterThan(0);
        expect(lang.body.length, where).toBeLessThanOrEqual(1024);
        expect(/^\p{Extended_Pictographic}/u.test(lang.body), `${where} starts with an emoji`).toBe(false);
        expect(lang.example.length, `${where}: an example for every variable`).toBe(order.length);
        for (const e of lang.example) expect(e.trim().length, where).toBeGreaterThan(0);
        expect(lang.buttons.length, `${where}: a text for every button`).toBe(t.buttons.length);
        for (const b of lang.buttons) expect(b.length, `${where}: "${b}"`).toBeLessThanOrEqual(25);
      }
      expect(counts.size, `${t.name}: the same variables in every language`).toBe(1);
    }
  });

  it("open a public match page from every URL button, and nothing else", () => {
    for (const t of WA_TEMPLATES) {
      for (const b of t.buttons) {
        if (b.type !== "URL") continue;
        expect(b.url, t.name).toBe("{base}/{{1}}");
        expect(PUBLIC.test(b.example), t.name).toBe(true);
      }
    }
  });

  it("fill every variable when a message is built, in the player's language", () => {
    for (const t of WA_TEMPLATES) {
      for (const l of WA_LOCALES) {
        const lang = t.languages[l];
        const url = t.buttons.find((b) => b.type === "URL");
        const payload = templatePayload(t.name, l === "en" ? "en-GB" : l, { body: lang.example, button: url?.type === "URL" ? url.example : undefined, quickReply: "wj:7KQ2", image: "https://kicksma.sh/7KQ2/card/opengraph-image?v=1" });
        expect(payload.language.code).toBe(l);
        const body = payload.components.find((c) => c.type === "body") as { parameters: { text: string }[] };
        expect(body.parameters.map((p) => p.text)).toEqual(lang.example);
        const buttons = payload.components.filter((c) => c.type === "button");
        expect(buttons, `${t.name}/${l}`).toHaveLength(t.buttons.length);
        expect(payload.components.some((c) => c.type === "header"), `${t.name}/${l}`).toBe(t.header === "IMAGE");
      }
    }
  });

  it("refuses a message Meta would refuse, or one whose button could sign somebody in", () => {
    const parts = { body: ["Sat · 18:00 · Rawai", "The match moved"], button: "7KQ2" };
    expect(() => templatePayload("ks_match_update", "en", { ...parts, body: ["only one"] })).toThrow(/2 body values/);
    expect(() => templatePayload("ks_match_result", "en", { ...parts, button: "7KQ2/card" })).toThrow(/picture/);
    expect(() => templatePayload("ks_spot_open", "en", { body: ["a", "b", "c"], button: "7KQ2" })).toThrow(/quick reply/);
    // A personal link, a bare personal token, and anything past the card page.
    for (const button of ["p/Ab3dEf6hJk9m/7KQ2", "Ab3dEf6hJk9mNp", "7KQ2/card/../p/x", undefined]) {
      expect(() => templatePayload("ks_match_update", "en", { ...parts, button }), String(button)).toThrow(/public match page/);
    }
    // Meta refuses a newline inside a variable; it becomes a space rather than a refused message.
    const clean = templatePayload("ks_match_update", "en", { ...parts, body: ["Sat\n18:00", "moved\t\tagain"] });
    expect((clean.components.find((c) => c.type === "body") as { parameters: { text: string }[] }).parameters.map((p) => p.text)).toEqual(["Sat 18:00", "moved again"]);
  });
});

describe("which channel a notice takes, once WhatsApp is one", () => {
  const ALL = { telegram: true, whatsapp: true, email: true, push: true };
  const everything = { telegramId: 42, phone: "+66810000001", email: "a@b.co", emailNotifications: true };

  it("tries Telegram, then WhatsApp, then email, then push", () => {
    expect(channelFor(everything, ALL)).toBe("telegram");
    expect(channelFor({ ...everything, telegramId: null }, ALL)).toBe("whatsapp");
    expect(channelFor({ ...everything, telegramId: null, phone: null }, ALL)).toBe("email");
    expect(channelFor({ telegramId: null, phone: null, email: null, emailNotifications: true }, ALL)).toBe("push");
    expect(channelFor({ ...everything, telegramId: null }, { ...ALL, whatsapp: false })).toBe("email");
  });

  it("leaves every caller that does not name WhatsApp exactly where it was", () => {
    const OLD = { telegram: true, email: true, push: true };
    expect(channelFor({ ...everything, telegramId: null }, OLD)).toBe("email");
    expect(channelFor({ telegramId: null, phone: "+66810000001", email: null, emailNotifications: true }, OLD)).toBe("push");
    expect(channelFor({ telegramId: null, phone: "+66810000001", email: null, emailNotifications: true }, { telegram: true, email: true, push: false })).toBe("none");
  });
});

describe("WhatsApp carries the match to a player whose channel it is", () => {
  let db: Db;
  let close: () => Promise<void>;
  let mailDir: string;
  const mails = () => {
    const f = path.join(mailDir, "mail.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { to: string; subject: string }) : [];
  };

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(async () => {
    process.env.WHATSAPP_TOKEN = "t";
    process.env.WHATSAPP_PHONE_ID = "123";
    delete process.env.WHATSAPP_TEMPLATES_PER_DAY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    mailDir = mkdtempSync(path.join(tmpdir(), "wa-notices-"));
    process.env.RESEND_API_KEY = "re_test_only";
    process.env.EMAIL_SINK_FILE = path.join(mailDir, "mail.jsonl");
    // The day's count starts from nothing in every test, so each cap is the one the test sets.
    await db.delete(metricsDaily);
    stub();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(mailDir, { recursive: true, force: true });
  });

  let n = 0;
  /** A player whose only way in is the WhatsApp number that wrote to us. */
  const waPlayer = (name: string, extra: Partial<Player> = {}) => makePlayer(db, name, { phone: `+668100${String(++n).padStart(5, "0")}`, ...extra });
  const digits = (p: Player) => p.phone!.replace(/\D/g, "");
  const match = async (org: Player, others: Player[], over: { startsAt?: Date; venueName?: string } = {}) => {
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: over.startsAt ?? new Date(NOW.getTime() + 6 * HOUR), tz: "Asia/Bangkok", venueName: over.venueName ?? "Rawai Padel", whenFull: "waitlist" });
    for (const p of [org, ...others]) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: new Date(Math.min(NOW.getTime(), ev.startsAt.getTime() - HOUR)) });
    return ev;
  };
  const notice = (code: string) => ({ template: "ks_match_update" as const, body: ["Sat · 18:00 · Rawai Padel", "The match moved"], button: code });

  it("tell(): a player with no Telegram gets the template, and no email besides", async () => {
    const nok = await waPlayer("Nok", { email: "nok@example.com" });
    await tell(db, nok, "The match moved\nNow Sat at 18:00", { inline_keyboard: [[{ text: "Open", url: "https://kicksma.sh/p/secret/7KQ2" }]] }, { whatsapp: notice("7KQ2") });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: digits(nok), name: "ks_match_update", language: "en", url: "7KQ2" });
    expect(mails()).toHaveLength(0);
    expect(allPublic()).toBe(true);
  });

  it("tell(): a template Meta will not deliver falls through to email, as the notice did before WhatsApp", async () => {
    const pim = await waPlayer("Pim", { email: "pim@example.com", locale: "ru" });
    refuse = true;
    await tell(db, pim, "Матч перенесли\nТеперь в субботу", undefined, { whatsapp: notice("7KQ2") });
    expect(sent).toHaveLength(0);
    expect(mails().map((m) => m.to)).toEqual(["pim@example.com"]);
  });

  it("tell(): a notice without a template never tries WhatsApp (a coach's notices have none)", async () => {
    const tai = await waPlayer("Tai", { email: "tai@example.com" });
    await tell(db, tai, "Lesson booked\nMonday 10:00");
    expect(sent).toHaveLength(0);
    expect(mails().map((m) => m.to)).toEqual(["tai@example.com"]);
  });

  it("the daily cap stops template sends, and the notice goes by email instead", async () => {
    process.env.WHATSAPP_TEMPLATES_PER_DAY = "1";
    const a = await waPlayer("Cap A", { email: "cap-a@example.com" });
    const b = await waPlayer("Cap B", { email: "cap-b@example.com" });
    await tell(db, a, "One\ntwo", undefined, { whatsapp: notice("7KQ2") });
    await tell(db, b, "One\ntwo", undefined, { whatsapp: notice("7KQ2") });
    expect(sent.map((s) => s.to)).toEqual([digits(a)]);
    expect(mails().map((m) => m.to)).toEqual(["cap-b@example.com"]);
    const counted = await db.select().from(metricsDaily).where(eq(metricsDaily.day, dayKey(NOW)));
    expect(Object.fromEntries(counted.map((r) => [r.key, Number(r.value)]))).toMatchObject({ whatsapp_templates: 1, whatsapp_templates_capped: 1 });

    // Zero switches template sends off altogether: WhatsApp is not even tried.
    process.env.WHATSAPP_TEMPLATES_PER_DAY = "0";
    await db.delete(metricsDaily);
    await tell(db, a, "One\ntwo", undefined, { whatsapp: notice("7KQ2") });
    expect(sent).toHaveLength(1);
    expect(mails().map((m) => m.to)).toEqual(["cap-b@example.com", "cap-a@example.com"]);
    expect(await db.select().from(metricsDaily)).toEqual([]);
  });

  it("a change to the match reaches a WhatsApp-only player as ks_match_update, and not somebody with a working email", async () => {
    const org = await makePlayer(db, "Organiser U", { email: "org-u@example.com" });
    const wa = await waPlayer("Beam");
    const both = await waPlayer("Mali", { email: "mali@example.com" });
    const ev = await match(org, [wa, both]);
    await notifyEventUpdated(db, ev);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: digits(wa), name: "ks_match_update", url: ev.code });
    expect(sent[0].body[0]).toContain("Rawai Padel");
    expect(sent[0].body[1]).toBe("The match moved");
    // Mali has an address that works, so the invitation is her notice; nothing goes to her number.
    expect(sent.some((s) => s.to === digits(both))).toBe(false);
    expect(mails().map((m) => m.to).sort()).toEqual(["mali@example.com", "org-u@example.com"]);
    expect(allPublic()).toBe(true);
  });

  it("a free spot reaches past partners as ks_spot_open, whose I'm in joins, and stops at the WhatsApp cap", async () => {
    const org = await makePlayer(db, "Organiser R");
    const partners: Player[] = [];
    for (let i = 0; i < REFILL_WHATSAPP_MAX + 2; i++) partners.push(await waPlayer(`Partner ${i}`));
    // Four finished matches in the last days, three partners in each, made every one of them the organiser's partner.
    for (let day = 1; day <= 4; day++) {
      const played = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() - day * DAY), tz: "Asia/Bangkok", whenFull: "waitlist" });
      for (const p of [org, ...partners.slice((day - 1) * 3, day * 3)]) await joinEvent(db, { eventId: played.id, playerId: p.id, now: new Date(played.startsAt.getTime() - HOUR) });
    }
    const ev = await match(org, []);

    const out = await notifyRefill(db, ev.id, NOW);
    expect(out).toMatchObject({ whatsapp: REFILL_WHATSAPP_MAX, emails: 0, pushes: 0 });
    expect(sent).toHaveLength(REFILL_WHATSAPP_MAX);
    for (const s of sent) expect(s).toMatchObject({ name: "ks_spot_open", quickReply: `wj:${ev.code}`, url: ev.code });
    expect(sent[0].body[1]).toBe("Organiser");
    expect(sent[0].body[2]).toBe("3 spots left");
    expect(allPublic()).toBe(true);

    // The quick reply comes back as a button message, and the thread joins on it like its own button.
    const tapper = partners.find((p) => digits(p) === sent[0].to)!;
    const tap: WaInboundMessage = { from: digits(tapper), id: "wamid.tap", timestamp: "0", type: "button", button: { payload: `wj:${ev.code}`, text: "I'm in" } };
    expect(readInbound(tap)).toEqual({ text: "I'm in", tappedId: `wj:${ev.code}` });
    expect(await handleWhatsappMessage(db, tap)).toBe("wa:joined");
  });

  it("after the match, a WhatsApp player is asked for the score with ks_score_ask, and the email is skipped", async () => {
    const org = await waPlayer("Score org", { email: "score-org@example.com" });
    const other = await makePlayer(db, "Score other", { email: "score-other@example.com" });
    const ev = await match(org, [other]);
    const [past] = await db.update(events).set({ startsAt: new Date(NOW.getTime() - 3 * HOUR), status: "past" }).where(eq(events.id, ev.id)).returning();
    const out = await nudgeForScore(db, past);
    expect(out).toMatchObject({ players: 2, whatsapp: 1, email: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: digits(org), name: "ks_score_ask", url: ev.code });
    expect(mails().map((m) => m.to)).toEqual(["score-other@example.com"]);
  });

  it("the result card goes once per player, ever, with the picture, and only where WhatsApp is the channel", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
    const org = await waPlayer("Result org");
    const two = await waPlayer("Result two");
    // Telegram carries this one's result already: the nudge turned into it in place.
    const tg = await waPlayer("Result tg", { telegramId: 777001 });
    const ev = await match(org, [two, tg], { startsAt: new Date(NOW.getTime() + HOUR) });
    await db.update(events).set({ startsAt: new Date(NOW.getTime() - 3 * HOUR), status: "past" }).where(eq(events.id, ev.id));
    await saveMatchScore(db, { eventId: ev.id, playerId: org.id, isCreator: true, sets: [{ setNumber: 1, sideA: 6, sideB: 3 }] });

    // Through the central result hook, as every screen that records a score reaches it.
    await emitMatchEvent(db, "match.result", ev.code);
    const results = sent.filter((s) => s.name === "ks_match_result");
    expect(results.map((s) => s.to).sort()).toEqual([digits(org), digits(two)].sort());
    for (const s of results) {
      expect(s.url).toBe(`${ev.code}/card`);
      expect(s.image).toContain(`/${ev.code}/card/opengraph-image?v=`);
      expect(s.body[1]).toContain("6-3");
    }
    // The picture was rendered before Meta was asked to fetch it.
    expect(other.some((u) => u.includes(`/${ev.code}/card/opengraph-image?v=`))).toBe(true);
    expect(allPublic()).toBe(true);

    // A corrected score is a second result: the chat is not written to again.
    sent = [];
    await saveMatchScore(db, { eventId: ev.id, playerId: org.id, isCreator: true, sets: [{ setNumber: 1, sideA: 6, sideB: 4 }] });
    expect(await sendWaResults(db, ev.code, NOW)).toBe(0);
    await emitMatchEvent(db, "match.result", ev.code);
    expect(sent.filter((s) => s.name === "ks_match_result")).toHaveLength(0);
  });

  it("a result Meta would not deliver is not marked sent, so the next result tries again", async () => {
    const org = await waPlayer("Retry org");
    const ev = await match(org, [await waPlayer("Retry two")], { startsAt: new Date(NOW.getTime() + HOUR) });
    await db.update(events).set({ startsAt: new Date(NOW.getTime() - 3 * HOUR), status: "past" }).where(eq(events.id, ev.id));
    await saveMatchScore(db, { eventId: ev.id, playerId: org.id, isCreator: true, sets: [{ setNumber: 1, sideA: 6, sideB: 2 }] });
    refuse = true;
    expect(await sendWaResults(db, ev.code, NOW)).toBe(0);
    refuse = false;
    expect(await sendWaResults(db, ev.code, NOW)).toBe(2);
    expect(await sendWaResults(db, ev.code, NOW)).toBe(0);
    const marked = await db.select().from(facts).where(and(eq(facts.kind, "whatsapp.result"), eq(facts.code, ev.code)));
    expect(marked).toHaveLength(2);
    expect(marked.every((f) => f.channel === "whatsapp" && f.subjectId === ev.id)).toBe(true);
  });
});
