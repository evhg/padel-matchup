import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { forgetOperators, operatorAuthorized } from "@/lib/api/secret";
import type { DcInteraction } from "@/lib/discord/api";
import { handleInteraction } from "@/lib/discord/bot";
import { cleanFeedbackText, createFeedback, decideFeedback, FEEDBACK_LIMITS, feedbackWeek, getFeedback, listFeedback } from "@/lib/feedback/store";
import { feedbackStrings } from "@/lib/feedback/strings";
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
    expect(handled.response.data?.content).toContain("Thanks, Ben");
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
