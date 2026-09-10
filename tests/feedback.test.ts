import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { forgetOperators, operatorAuthorized } from "@/lib/api/secret";
import type { DcInteraction } from "@/lib/discord/api";
import { handleInteraction } from "@/lib/discord/bot";
import { cleanFeedbackText, createFeedback, decideFeedback, FEEDBACK_LIMITS, feedbackWeek, getFeedback, listFeedback } from "@/lib/feedback/store";
import { feedbackStrings, PROMISE_RE, promisesSomething } from "@/lib/feedback/strings";
import { composeAck, fallbackAck, parseAck, POOL } from "@/lib/feedback/ack";
import { readFileSync } from "node:fs";
import { llmsTxt } from "@/lib/api/docs";
import { signSvix } from "@/lib/outreach/svix";
import { handleTelegramUpdate } from "@/lib/telegram/bot";
import { POST as inboundWebhook } from "@/app/api/inbound/resend/route";
import { createTestDb } from "./helpers/db";

type Call = { url: string; method: string; body: Record<string, unknown> };
let calls: Call[] = [];
function stubNet(received?: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ url: u, method: init?.method ?? "GET", body });
      if (u.includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true, result: { message_id: 500, chat: { id: body.chat_id } } }), { headers: { "content-type": "application/json" } });
      if (u.includes("discord.com/api")) return new Response(JSON.stringify({ id: "m1", channel_id: body.channel_id ?? "c" }), { headers: { "content-type": "application/json" } });
      if (u.includes("api.resend.com/emails/receiving/")) return new Response(JSON.stringify(received ?? {}), { headers: { "content-type": "application/json" } });
      if (u === "https://api.resend.com/emails") return new Response(JSON.stringify({ id: `sent_${calls.length}` }), { headers: { "content-type": "application/json" } });
      if (u.includes("api.vercel.com")) return new Response("{}", { status: init?.headers && (init.headers as Record<string, string>).Authorization === "Bearer vercel_good_token_1234567890" ? 200 : 403 });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }),
  );
}
const tgCalls = () => calls.filter((c) => c.url.includes("api.telegram.org"));
const APP = "1545988138055237723";
const user = (id: number, name: string) => ({ id: String(id), username: name.toLowerCase(), global_name: name });
const command = (name: string, from: ReturnType<typeof user>, options: Record<string, string> = {}): DcInteraction => ({
  id: String(Date.now()),
  application_id: APP,
  type: 2,
  token: "itoken",
  guild_id: "1545987795863085087",
  channel_id: "1545987795863085099",
  channel: { id: "1545987795863085099", type: 0, name: "padel" },
  member: { user: from },
  locale: "en-US",
  data: { name, options: Object.entries(options).map(([k, v]) => ({ name: k, type: 3, value: v })) },
});

describe("the feedback loop", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    process.env.TELEGRAM_BOT_TOKEN = "123456:feedback-test-token";
    process.env.TELEGRAM_WEBHOOK_SECRET = "hooksecret";
    process.env.DISCORD_BOT_TOKEN = "dc-token";
    process.env.DISCORD_APPLICATION_ID = APP;
    process.env.RESEND_API_KEY = "re_test";
    process.env.APP_BASE_URL = "https://kicksma.sh";
  });
  afterAll(async () => {
    for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID", "RESEND_API_KEY", "APP_BASE_URL", "RESEND_WEBHOOK_SECRET", "CRON_SECRET", "OPERATOR_VERCEL_PROJECT", "OPERATOR_VERCEL_TEAM"]) delete process.env[k];
    await close();
  });
  beforeEach(() => stubNet());
  afterEach(() => vi.unstubAllGlobals());

  it("cleans and validates a note", async () => {
    expect(cleanFeedbackText("  hi there \r\nnext  \n")).toBe("hi there\nnext");
    await expect(createFeedback(db, { source: "web", text: "ok" })).rejects.toThrow("too_short");
    const row = await createFeedback(db, { source: "web", text: "Please let me pick the court number on the web too.", locale: "es", name: "Lucía" });
    expect(row.status).toBe("new");
    expect(row.locale).toBe("es");
    expect(feedbackStrings("es").thanks("Lucía")).toContain("Gracias, Lucía");
    expect(feedbackStrings("de").how).toContain("/feedback");
  });

  it("Telegram: /feedback alone explains, with words it is stored and thanked in the chat; the verdict goes back to the same chat, three messages at most", async () => {
    const group = { id: -100777001, type: "supergroup" as const, title: "Rawai regulars" };
    const olga = { id: 770001, first_name: "Olga", username: "olga_tg", language_code: "ru" };
    const ctx = NO_SIDE_EFFECTS;
    const bare = await handleTelegramUpdate(db, { update_id: 1, message: { message_id: 11, date: 0, chat: group, from: olga, text: "/feedback" } }, ctx);
    expect(bare).toBe("feedback:how");
    expect(tgCalls().at(-1)?.body.text).toContain("/feedback");
    const out = await handleTelegramUpdate(db, { update_id: 2, message: { message_id: 12, date: 0, chat: group, from: olga, text: "/feedback@kicksmash_bot the reminder should come two hours before, not one" } }, ctx);
    expect(out).toMatch(/^feedback:[0-9a-f-]{36}$/);
    const id = out.slice("feedback:".length);
    const row = await getFeedback(db, id);
    expect(row).toMatchObject({ source: "telegram", status: "acknowledged", telegramChatId: group.id, telegramUserId: olga.id, telegramMessageId: 12, name: "Olga", context: "Rawai regulars", messagesSent: 1 });
    const ack = tgCalls().at(-1)!;
    expect(ack.body.chat_id).toBe(group.id);
    expect(ack.body.disable_notification).toBe(true);
    expect((ack.body.reply_parameters as { message_id: number }).message_id).toBe(12);
    expect(String(ack.body.text)).toContain("Olga");

    const shipped = await decideFeedback(db, id, { status: "shipped", verdict: "adopt", assessment: "rule 2: a default nobody has to touch", message: "Olga, the reminder now comes two hours before the match. Thank you for the nudge.", prUrl: "https://github.com/evhg/padel-matchup/pull/99" });
    expect(shipped.delivery).toEqual({ status: "sent" });
    expect(shipped.item).toMatchObject({ status: "shipped", verdict: "adopt", messagesSent: 2, prUrl: "https://github.com/evhg/padel-matchup/pull/99" });
    expect(shipped.item?.shippedAt).toBeInstanceOf(Date);
    const told = tgCalls().at(-1)!;
    expect(told.body.chat_id).toBe(group.id);
    expect(String(told.body.text)).toContain("two hours before");
    // A third message is the last one; a fourth never leaves.
    expect((await decideFeedback(db, id, { status: "shipped", message: "one more line" })).delivery).toEqual({ status: "sent" });
    expect((await decideFeedback(db, id, { status: "shipped", message: "and another" })).delivery).toEqual({ status: "capped" });
    expect((await getFeedback(db, id))?.messagesSent).toBe(FEEDBACK_LIMITS.messagesPerItem);
  });

  it("Discord: /feedback text is stored and answered where it was said", async () => {
    const ben = user(880001, "Ben");
    const handled = await handleInteraction(db, command("feedback", ben, { text: "let /new accept a court number too" }), NO_SIDE_EFFECTS);
    expect(handled.outcome).toMatch(/^feedback:/);
    // Discord gives three seconds; the line is written for this note, so the bot defers and edits.
    expect(handled.response.type).toBe(5);
    expect(handled.response.data?.flags).toBe(64);
    await handled.followUp?.();
    const edited = calls.find((c) => c.method === "PATCH" && c.url.includes("/messages/@original"));
    expect(String(edited?.body.content)).toContain("Ben");
    const id = handled.outcome.slice("feedback:".length);
    expect(await getFeedback(db, id)).toMatchObject({ source: "discord", status: "acknowledged", discordUserId: ben.id, discordChannelId: "1545987795863085099", context: "padel" });
    const short = await handleInteraction(db, command("feedback", ben, { text: "no" }), NO_SIDE_EFFECTS);
    expect(short.outcome).toBe("feedback_short");
    const r = await decideFeedback(db, id, { status: "declined", verdict: "decline", message: "Ben, /new keeps to day, time and place on purpose (rule 1); the card's Edit button sets the court in one tap." });
    expect(r.delivery).toEqual({ status: "sent" });
    const post = calls.find((c) => c.url.endsWith("/channels/1545987795863085099/messages") && c.method === "POST")!;
    expect(String(post.body.content)).toContain(`<@${ben.id}>`);
    expect(String(post.body.content)).toContain("rule 1");
  });

  it("email: a note to feedback@ becomes a row, gets an automatic thank-you in the thread, and the verdict replies by email", async () => {
    process.env.RESEND_WEBHOOK_SECRET = "whsec_" + Buffer.from("feedback-secret").toString("base64");
    const emailId = `fb_${Date.now()}`;
    stubNet({ id: emailId, from: "Marta Ruiz <marta@club.example>", to: ["feedback@kicksma.sh"], subject: "Idea: cost in the calendar invite", text: "Hola! Please put the cost per player into the calendar invite too.", html: null, message_id: `<${emailId}@club.example>` });
    const body = JSON.stringify({ type: "email.received", data: { email_id: emailId, from: "Marta Ruiz <marta@club.example>", to: ["feedback@kicksma.sh"] } });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await inboundWebhook(new Request("https://kicksma.sh/api/inbound/resend", { method: "POST", body, headers: { "svix-id": "msg_fb", "svix-timestamp": ts, "svix-signature": signSvix(process.env.RESEND_WEBHOOK_SECRET!, "msg_fb", ts, body) } }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; id: string; feedback: boolean };
    expect(json).toMatchObject({ ok: true, feedback: true });
    const { getDb } = await import("@/db");
    const appDb = await getDb();
    const row = await getFeedback(appDb, json.id);
    expect(row).toMatchObject({ source: "email", email: "marta@club.example", name: "Marta Ruiz", status: "acknowledged", messagesSent: 1 });
    expect(row?.text).toContain("cost per player");
    const ack = calls.find((c) => c.url === "https://api.resend.com/emails")!;
    expect(ack.body.to).toEqual(["marta@club.example"]);
    expect(String(ack.body.subject)).toBe("Re: Idea: cost in the calendar invite");
    expect((ack.body.headers as Record<string, string>)["In-Reply-To"]).toBe(`<${emailId}@club.example>`);
    expect(String(ack.body.from)).toContain("claude@kicksma.sh");
    const verdict = await decideFeedback(appDb, json.id, { status: "planned", verdict: "later", message: "Marta, the invite will carry the cost line; it needs the calendar template in three languages, so it is on the list rather than today. I will write when it ships." });
    expect(verdict.delivery).toEqual({ status: "sent" });
    const reply = calls.filter((c) => c.url === "https://api.resend.com/emails").at(-1)!;
    expect(String(reply.body.text)).toContain("on the list");
    expect((reply.body.headers as Record<string, string>)["In-Reply-To"]).toBe(`<${emailId}@club.example>`);
  });

  it("web notes without a channel are kept but cannot be answered; the week's numbers add up", async () => {
    const row = await createFeedback(db, { source: "web", text: "Dark mode please, the court lights are bright enough.", locale: "en" });
    const r = await decideFeedback(db, row.id, { status: "declined", message: "no way to send this" });
    expect(r.delivery).toEqual({ status: "no_channel" });
    expect(r.item?.status).toBe("declined");
    expect(r.item?.messagesSent).toBe(0);
    const week = await feedbackWeek(db, new Date(Date.now() - 7 * 86400000));
    expect(week.received).toBeGreaterThanOrEqual(4);
    expect(week.shipped).toBeGreaterThanOrEqual(1);
    expect((await listFeedback(db, ["new"])).some((f) => f.id === row.id)).toBe(false);
  });

  it("operator auth: the cron secret, or a Vercel token that can read the project", async () => {
    forgetOperators();
    process.env.CRON_SECRET = "cron-secret-value-long-enough";
    process.env.OPERATOR_VERCEL_PROJECT = "prj_test";
    process.env.OPERATOR_VERCEL_TEAM = "team_test";
    const req = (token?: string) => new Request("https://kicksma.sh/api/admin/feedback", { headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect(await operatorAuthorized(req())).toBe(false);
    expect(await operatorAuthorized(req("cron-secret-value-long-enough"))).toBe(true);
    expect(await operatorAuthorized(req("cron-secret-value-long-enougH"))).toBe(false);
    expect(await operatorAuthorized(req("vercel_good_token_1234567890"))).toBe(true);
    const before = calls.filter((c) => c.url.includes("api.vercel.com")).length;
    expect(await operatorAuthorized(req("vercel_good_token_1234567890"))).toBe(true);
    expect(calls.filter((c) => c.url.includes("api.vercel.com")).length).toBe(before);
    expect(await operatorAuthorized(req("vercel_wrong_token_1234567890"))).toBe(false);
    delete process.env.OPERATOR_VERCEL_PROJECT;
    forgetOperators();
    expect(await operatorAuthorized(req("vercel_good_token_1234567890"))).toBe(false);
  });
});


describe("the instant reply", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    process.env.TELEGRAM_BOT_TOKEN = "123:test";
  });
  afterAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await close();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("promises nothing, anywhere: no day, no date, no answer, in any language", () => {
    const forbidden = PROMISE_RE;
    // The guard itself is not vacuous: every shape of promise the copy has ever carried, and a few it has not, trip it.
    for (const bad of ["we check each claim within 48 hours", "I will reply tomorrow", "you hear back within a day", "I'll get back to you shortly", "мы ответим в течение недели", "отвечу завтра", "обычно в течение суток", "responderemos en 24 horas", "te contestaré mañana", "normalmente en un día"]) expect(promisesSomething(bad), bad).toBe(true);
    const lines: string[] = [];
    for (const locale of ["en", "ru", "es"] as const) {
      const p = POOL[locale];
      lines.push(...p.open, ...p.openNoName, ...p.mid, ...p.close, ...p.closeNoReply, p.notFeedback);
      const s = feedbackStrings(locale);
      lines.push(s.how, s.thanks("Olga"), s.added, s.emailSubject, s.tooMany);
      const messages = JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")) as { feedback: Record<string, string>; club: Record<string, string> };
      lines.push(...Object.values(messages.feedback), messages.club.claimSub);
    }
    lines.push(...llmsTxt("https://kicksma.sh").split("\n").filter((l) => /feedback/i.test(l)));
    for (const line of lines) expect(line, line).not.toMatch(forbidden);
    // Without a way back the closer names no place in any language; with a way back that is not the page, it names no place either.
    for (const l of [...POOL.ru.closeNoReply, ...POOL.ru.closeAway]) expect(l).not.toMatch(/здесь|туда/);
    for (const l of [...POOL.es.closeNoReply, ...POOL.es.closeAway]) expect(l).not.toMatch(/aquí|allí/);
    for (const l of [...POOL.en.closeNoReply, ...POOL.en.closeAway]) expect(l).not.toMatch(/\bhere\b/);
    for (let i = 0; i < 12; i++) expect(fallbackAck({ text: `note ${i}`, name: "Olga", locale: "en", source: "web", canReply: true, replyVia: "email" })).not.toMatch(/\bhere\b/);
    // A note with no way back gets a closer that does not say "here".
    const web = fallbackAck({ text: "the reminder should come two hours before", name: "Olga", locale: "en", canReply: false });
    expect(web).not.toMatch(/here|let you know/);
    expect(web).toMatch(/Kicksmash|the app/);
    expect(fallbackAck({ text: "the reminder should come two hours before", name: "Olga", locale: "en", canReply: true })).toMatch(/here|let you know/);
  });

  it("without the model, the line still differs from note to note and names the person", () => {
    const a = fallbackAck({ text: "the reminder should come two hours before", name: "Olga", locale: "ru" });
    const b = fallbackAck({ text: "let /new accept a court number", name: "Olga", locale: "ru" });
    const c = fallbackAck({ text: "the reminder should come two hours before", name: "Olga", locale: "ru" });
    expect(a).not.toBe(b);
    expect(a).toBe(c);
    expect(a).toContain("Olga");
    expect(fallbackAck({ text: "anything", name: null, locale: "en" })).not.toContain("{name}");
    expect(fallbackAck({ text: "algo", name: "Lucía", locale: "es" })).toMatch(/Lucía/);
    const distinct = new Set(Array.from({ length: 40 }, (_, i) => fallbackAck({ text: `note ${i}`, name: "Sam", locale: "en" })));
    expect(distinct.size).toBeGreaterThan(10);
  });

  it("parses the model's JSON and drops anything else", () => {
    expect(parseAck('{"kind":"feedback","reply":"Thanks Olga, two hours instead of one, noted; you hear back within a day."}')).toEqual({ kind: "feedback", reply: "Thanks Olga, two hours instead of one, noted; you hear back within a day." });
    expect(parseAck('Sure! {"kind":"not_feedback","reply":"I can only act on what should change; tell me that and I answer within a day. see https://evil.example/x"}')).toEqual({ kind: "not_feedback", reply: "I can only act on what should change; tell me that and I answer within a day. see" });
    expect(parseAck("no json here")).toBeNull();
    expect(parseAck('{"kind":"praise","reply":"x"}')).toBeNull();
  });

  it("with the model: an insult gets no thanks and is closed at once; real feedback gets its own line", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const tg: Record<string, unknown>[] = [];
    let answer = { kind: "not_feedback", reply: "Мне нечего с этим сделать: напишите одним предложением, что стоит изменить в Kicksmash, и я отвечу в течение суток." };
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.anthropic.com")) return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 300, output_tokens: 40 } }), { headers: { "content-type": "application/json" } });
      tg.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }), { headers: { "content-type": "application/json" } });
    });
    const group = { id: -100777009, type: "supergroup" as const, title: "Late night" };
    const troll = { id: 770009, first_name: "Vlad", username: "vlad_tg", language_code: "ru" };
    const out = await handleTelegramUpdate(db, { update_id: 9, message: { message_id: 91, date: 0, chat: group, from: troll, text: "/feedback вы все идиоты" } }, NO_SIDE_EFFECTS);
    expect(out).toMatch(/^feedback_not:/);
    const row = await getFeedback(db, out.slice("feedback_not:".length));
    expect(row).toMatchObject({ status: "declined", verdict: "not_feedback", messagesSent: 1 });
    expect(String(tg.at(-1)?.text)).not.toMatch(/Спасибо|Thanks/);
    expect(String(tg.at(-1)?.text)).toContain("что стоит изменить");

    answer = { kind: "feedback", reply: "Vlad, a compliment after a win: I like it, and I will look at how the card could say it. If it gets built, I'll let you know." };
    const ok = await handleTelegramUpdate(db, { update_id: 10, message: { message_id: 92, date: 0, chat: group, from: { ...troll, language_code: "en" }, text: "/feedback when I win a match I'd like a compliment from you" } }, NO_SIDE_EFFECTS);
    expect(ok).toMatch(/^feedback:/);
    expect(String(tg.at(-1)?.text)).toContain("a compliment after a win");
    expect((await getFeedback(db, ok.slice("feedback:".length)))?.status).toBe("acknowledged");
    const direct = await composeAck(db, { text: "hello?", name: null, locale: "en", source: "web" });
    expect(direct.by).toBe("model");
    // A model reply that promises a day, a date or an answer never reaches anyone: the pool line takes its place.
    answer = { kind: "feedback", reply: "Thanks Vlad, noted. You hear back within a day." };
    const guarded = await composeAck(db, { text: "another idea", name: "Vlad", locale: "en", source: "web", canReply: true, replyVia: "telegram" });
    expect(guarded.by).toBe("fallback");
    expect(guarded.reply).not.toMatch(PROMISE_RE);
    expect(guarded.reply).toContain("Vlad");
    answer = { kind: "not_feedback", reply: "Tell me what should change and I answer within a day." };
    const guardedNot = await composeAck(db, { text: "lol", name: null, locale: "en", source: "web" });
    expect(guardedNot.kind).toBe("not_feedback");
    expect(guardedNot.reply).not.toMatch(PROMISE_RE);
  });

  it("when the model fails, the fallback still answers as feedback", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.stubGlobal("fetch", async () => new Response("upstream down", { status: 500 }));
    const ack = await composeAck(db, { text: "the court name could be bigger on the card", name: "Ana", locale: "es", source: "web" });
    expect(ack.by).toBe("fallback");
    expect(ack.kind).toBe("feedback");
    expect(ack.reply).toContain("Ana");
  });
});
