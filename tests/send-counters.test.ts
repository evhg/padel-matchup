import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily } from "@/db/schema";
import { Resend } from "resend";
import { sendEmail } from "@/lib/email/send";
import { tg, tgCounters } from "@/lib/telegram/api";

/**
 * On 23 September 2026 Erik wrote "the emails werent sent out to the players?", and the data could not
 * answer him: a failed email and a failed push were a log line only, and a Telegram call that Telegram
 * refused counted as sent. Each failure is a day counter now, which the service board reads.
 */
let db: Db;
beforeAll(async () => {
  db = await (await import("@/db")).getDb();
});
afterEach(() => vi.unstubAllGlobals());

const counted = async (key: string) => (await db.select().from(metricsDaily).where(eq(metricsDaily.key, key))).reduce((n, r) => n + Number(r.value), 0);
const counts = async (keys: string[]) => Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await counted(k)] as const)));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("a failed email", () => {
  const mail = { to: "ana@mail.example", subject: "The line-up is complete", html: "<p>Saturday 18:00</p>", text: "Saturday 18:00" };

  it("counts emails_failed when Resend refuses the send, and emails_sent when it takes it", async () => {
    process.env.RESEND_API_KEY = "re_test";
    delete process.env.EMAIL_SINK_FILE;
    let refuse = true;
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      if (!String(url).startsWith("https://api.resend.com/emails")) throw new Error(`unexpected ${String(url)}`);
      return refuse ? json({ statusCode: 500, name: "application_error", message: "Internal server error" }, 500) : json({ id: "re_1" });
    });
    const before = await counts(["emails_failed", "emails_sent"]);
    expect(await sendEmail(mail)).toBe(false);
    expect(await counts(["emails_failed", "emails_sent"])).toEqual({ emails_failed: before.emails_failed + 1, emails_sent: before.emails_sent });
    refuse = false;
    expect(await sendEmail(mail)).toBe(true);
    expect(await counts(["emails_failed", "emails_sent"])).toEqual({ emails_failed: before.emails_failed + 1, emails_sent: before.emails_sent + 1 });
  });

  it("counts emails_failed when the network gives no answer at all, which Resend's client turns into an error answer", async () => {
    process.env.RESEND_API_KEY = "re_test";
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const before = await counted("emails_failed");
    expect(await sendEmail(mail)).toBe(false);
    expect(await counted("emails_failed")).toBe(before + 1);
  });

  it("counts emails_failed when the send itself throws", async () => {
    // Resend's client catches a failed fetch and answers `{ error }` (the test above), so only a throw
    // reaches sendEmail's catch: here the client's own request call rejects (review, 15 October 2026).
    process.env.RESEND_API_KEY = "re_test";
    vi.stubGlobal("fetch", async () => json({ id: "re_never" }));
    const post = vi.spyOn(Resend.prototype, "post").mockRejectedValueOnce(new Error("socket hang up"));
    try {
      const before = await counts(["emails_failed", "emails_sent"]);
      expect(await sendEmail(mail)).toBe(false);
      expect(post).toHaveBeenCalledTimes(1);
      expect(await counts(["emails_failed", "emails_sent"])).toEqual({ emails_failed: before.emails_failed + 1, emails_sent: before.emails_sent });
    } finally {
      post.mockRestore();
    }
  });
});

describe("a failed Telegram call", () => {
  it("counts telegram_failed beside telegram_sent for a refusal or an answer with no JSON, and keeps a rate limit and a no-op edit apart", () => {
    const refused = { ok: false as const, error_code: 400, description: "Bad Request: chat not found" };
    expect(tgCounters(200, { ok: true, result: {} })).toEqual(["telegram_sent"]);
    expect(tgCounters(400, refused)).toEqual(["telegram_sent", "telegram_failed"]);
    expect(tgCounters(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" })).toEqual(["telegram_sent", "telegram_failed"]);
    expect(tgCounters(502, null)).toEqual(["telegram_sent", "telegram_failed"]);
    expect(tgCounters(429, null)).toEqual(["telegram_429"]);
    expect(tgCounters(200, { ok: false, error_code: 429, description: "Too Many Requests: retry after 3" })).toEqual(["telegram_429"]);
    // An edit that changed nothing is a success (`editOk`), not a failure.
    expect(tgCounters(400, { ok: false, error_code: 400, description: "Bad Request: message is not modified" })).toEqual(["telegram_sent"]);
  });

  it("writes them through tg(): a 400 gives telegram_failed 1 and telegram_sent 1, a timeout gives telegram_failed alone", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test";
    let answer: () => Promise<Response> = async () => json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400);
    vi.stubGlobal("fetch", async () => answer());
    const keys = ["telegram_sent", "telegram_failed", "telegram_429"];
    const before = await counts(keys);
    const r = await tg("sendMessage", { chat_id: 42, text: "hi" });
    expect(r.ok).toBe(false);
    expect(await counts(keys)).toEqual({ telegram_sent: before.telegram_sent + 1, telegram_failed: before.telegram_failed + 1, telegram_429: before.telegram_429 });
    answer = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    expect((await tg("sendMessage", { chat_id: 42, text: "hi" })).ok).toBe(false);
    expect(await counts(keys)).toEqual({ telegram_sent: before.telegram_sent + 1, telegram_failed: before.telegram_failed + 2, telegram_429: before.telegram_429 });
    answer = async () => json({ ok: true, result: { message_id: 7 } });
    expect((await tg("sendMessage", { chat_id: 42, text: "hi" })).ok).toBe(true);
    expect(await counts(keys)).toEqual({ telegram_sent: before.telegram_sent + 2, telegram_failed: before.telegram_failed + 2, telegram_429: before.telegram_429 });
  });
});
