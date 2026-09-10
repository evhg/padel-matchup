import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { dayKey, setMetric } from "@/lib/domain/metrics";
import { ownerTelegramId } from "@/lib/listen/tick";
import { esc, sendMessage, telegramEnabled } from "@/lib/telegram/api";
import { fetchCostReport } from "./anthropic";
import { serviceBoard, type ServiceBoard } from "./services";

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

const whatNext: Record<string, string> = {
  vercel_analytics: "Vercel stops recording page views for the rest of the month; our own counter keeps going and the digest uses it.",
  resend_month: "Past the ceiling Resend refuses to send; the rule is to move up only past fifty emails a day, so I will slow the non-essential mail first.",
  resend_day: "Today's remaining mail waits for tomorrow; reminders go by push and Telegram meanwhile.",
  anthropic: "At the cap the feedback replies and drafts stop until the month turns. Raising the cap is your call in the console.",
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
    const key = `svc_alert_${row.key}_${month}`;
    const [seen] = await db.select({ value: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.key, key), eq(metricsDaily.day, dayKey(now)))).limit(1);
    const [seenMonth] = await db.select({ value: metricsDaily.value }).from(metricsDaily).where(eq(metricsDaily.key, key)).limit(1);
    if (seen || seenMonth) continue;
    const pct = row.pct !== null ? ` (${row.pct.toFixed(0)}% of ${row.ceiling})` : "";
    const text = `⚠️ ${row.name}: ${row.usage}${pct}.\n${whatNext[row.key] ?? "I am looking at it."}`;
    const res = await sendMessage(owner, esc(text), { keyboard: { inline_keyboard: [[{ text: "Service board", url: `${baseUrl()}/admin` }]] } });
    if (res.ok) {
      await setMetric(db, key, 1, dayKey(now));
      sent++;
    }
  }
  return sent;
}
