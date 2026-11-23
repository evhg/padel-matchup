import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily, players } from "@/db/schema";
import { baseUrl, reelUploadUrl } from "@/lib/config";
import { sendEmail } from "@/lib/email/send";
import { dayKey, setMetric } from "@/lib/domain/metrics";
import { ownerTelegramId } from "@/lib/listen/tick";
import { esc, sendMessage, telegramEnabled } from "@/lib/telegram/api";
import { AI_FEATURES, fetchCostReport, KEY_REFUSED_LINE } from "./anthropic";
import { serviceBoard, STORE_BYTES_KEY, type ServiceBoard } from "./services";

/**
 * Hourly: refresh the billed Anthropic figure when an admin key exists, then tell the
 * owner once per month per service when something crosses 85 percent or goes red.
 * One message, what it is, what happens next. Never twice for the same month.
 */

export async function refreshAnthropicCost(db: Db, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const report = await fetchCostReport(from, now, fetchImpl);
  if (!report) return false;
  // Stored as a month-to-date snapshot on today's row; the board reads the latest.
  await setMetric(db, "anthropic_cost_cents", Math.round(report.usd * 100), dayKey(now));
  return true;
}

/**
 * Hourly, but one question a day: what does the reel host's store weigh? The host measures it in its own
 * daily job (`GET /usage`, scripts/highlights/modal/serve.py); the answer is kept on today's row, and
 * the board reads the latest. No answer changes nothing: the last day's figure stays.
 */
export async function refreshStoreBytes(db: Db, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const url = reelUploadUrl();
  if (!url) return false;
  const [seen] = await db.select({ value: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.key, STORE_BYTES_KEY), eq(metricsDaily.day, dayKey(now)))).limit(1);
  if (seen) return false;
  try {
    const res = await fetchImpl(`${url}/usage`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return false;
    const bytes = Number(((await res.json()) as { bytes?: unknown }).bytes);
    if (!Number.isFinite(bytes) || bytes < 0) return false;
    await setMetric(db, STORE_BYTES_KEY, Math.round(bytes), dayKey(now));
    return true;
  } catch {
    return false;
  }
}

/** Rows whose alert goes to the owner by email too, beside Telegram (the owner, 23 November 2026: the store). */
const ALSO_BY_EMAIL: ReadonlySet<string> = new Set(["modal_store"]);

/** The owner's own player record is the one with the owner's Telegram id: its email is where the mail goes. */
async function emailOwner(db: Db, ownerTelegram: number, subject: string, text: string): Promise<boolean> {
  const [me] = await db.select({ email: players.email }).from(players).where(eq(players.telegramId, ownerTelegram)).limit(1);
  if (!me?.email) return false;
  const html = `<p>${text.split("\n").map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("<br>")}</p><p><a href="${baseUrl()}/admin">Service board</a></p>`;
  return sendEmail({ to: me.email, subject, html, text: `${text}\n\n${baseUrl()}/admin` });
}

const whatNext: Record<string, string> = {
  modal_store: "Past 1 TiB Modal bills $0.09 a month for each GiB over it. Each match video goes after 7 days and each reel after 30, so the store empties by itself; I look at what holds the space.",
  vercel_analytics: "After three days of grace Vercel stops recording page views until the next billing cycle, for every project on the account, and bills nothing; our own counter keeps going and the digest uses it.",
  resend_month: "Past the ceiling Resend refuses to send; the rule is to move up only past fifty emails a day, so I will slow the non-essential mail first.",
  resend_day: "Today's remaining mail waits for tomorrow; reminders go by push and Telegram meanwhile.",
  anthropic: "At the cap the feedback replies and drafts stop until the month turns. Raising the cap is your call in the console.",
  // A refused key is not the cap: every model call stops, whatever the month's spend. A key with no
  // workspace is refused too (`keyRefused`), and ANTHROPIC_WORKSPACE_ID is its fix.
  anthropic_key: `Every AI feature is off until a new ANTHROPIC_API_KEY, or ANTHROPIC_WORKSPACE_ID when the key has no workspace, is in Vercel and the app is deployed again: ${AI_FEATURES.join(", ")}.`,
  supabase_db: "I will prune old activity rows and error events before it matters.",
  tavily: "The desk stops searching before the meter does.",
  pg_cron: "The scheduled jobs have not run on time; I am looking at Supabase pg_cron.",
  backup: "The nightly backup has not run; I am checking the token and the job.",
  uptime: "The outside probe sees the site down; the daily session is on it.",
  domain: "The domain renewal is the one payment only you can make; Porkbun auto-renew must be on and the card valid.",
};

export async function alertOnServices(db: Db, now = new Date(), board?: ServiceBoard): Promise<number> {
  const owner = ownerTelegramId();
  if (!owner || !telegramEnabled()) return 0;
  const b = board ?? (await serviceBoard(db, now));
  const month = now.toISOString().slice(0, 7);
  let sent = 0;
  for (const row of b.rows) {
    const crossed = row.state === "alert";
    if (!crossed) continue;
    // The Anthropic row is red for one of two reasons, and each has its own alert and its own month:
    // a refused key (`KEY_REFUSED_LINE` leads its usage), or the spend at the cap.
    const refusedKey = row.key === "anthropic" && row.usage.startsWith(KEY_REFUSED_LINE);
    const kind = refusedKey ? "anthropic_key" : row.key;
    const key = `svc_alert_${kind}_${month}`;
    const [seen] = await db.select({ value: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.key, key), eq(metricsDaily.day, dayKey(now)))).limit(1);
    const [seenMonth] = await db.select({ value: metricsDaily.value }).from(metricsDaily).where(eq(metricsDaily.key, key)).limit(1);
    if (seen || seenMonth) continue;
    const pct = row.pct !== null && !refusedKey ? ` (${row.pct.toFixed(0)}% of ${row.ceiling})` : "";
    const next = whatNext[kind] ?? (row.key.startsWith("scrape_") ? "The platform's page changed at two clubs, so its reader stopped until a deploy of new code. Other platforms and the clubs' own feeds go on; the reader needs a fix." : "I am looking at it.");
    const text = refusedKey ? `⚠️ ${row.name}: ${KEY_REFUSED_LINE}.\n${next}` : `⚠️ ${row.name}: ${row.usage}${pct}.\n${next}`;
    const res = await sendMessage(owner, esc(text), { keyboard: { inline_keyboard: [[{ text: "Service board", url: `${baseUrl()}/admin` }]] } });
    if (res.ok) {
      await setMetric(db, key, 1, dayKey(now));
      sent++;
      if (ALSO_BY_EMAIL.has(kind)) await emailOwner(db, owner, `Kicksmash: ${row.name} is at ${row.pct?.toFixed(0) ?? "?"}%`, text).catch(() => false);
    }
  }
  return sent;
}
