import { and, gte, inArray, like, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily } from "@/db/schema";
import { emailEnabled } from "@/lib/config";
import { dayKey } from "@/lib/domain/metrics";
import { pushEnabled } from "@/lib/push";
import { searchConsoleEnabled } from "@/lib/search/console";
import { anthropicAdminKey, anthropicCapUsd, estimateCostUsd, listenModel } from "./anthropic";

/**
 * The service board: every service the stack leans on, what we use of it this month,
 * and the ceiling of its free plan. Measured by the app wherever a provider will not
 * tell us, linked where only a dashboard knows. One row per service, one state each.
 */

export type ServiceState = "ok" | "warn" | "alert" | "off" | "info";
export type ServiceRow = {
  key: string;
  name: string;
  role: string;
  state: ServiceState;
  /** Numbers behind the bar, when there is one. */
  used: number | null;
  limit: number | null;
  pct: number | null;
  usage: string;
  ceiling: string;
  note: string;
  link?: string;
};

export const CEILINGS = {
  vercelBandwidthGb: 100,
  vercelInvocations: 1_000_000,
  vercelAnalyticsEvents: 2500,
  supabaseDbBytes: 500 * 1024 * 1024,
  supabaseEgressGb: 5,
  resendPerMonth: 3000,
  resendPerDay: 100,
  tavilyCredits: 1000,
  telegramPerSecond: 30,
  domainWarnDays: 60,
  domainAlertDays: 30,
  backupMaxAgeHours: 36,
  hourlyCronMaxAgeMin: 120,
  pushCronMaxAgeMin: 20,
  syncCronMaxAgeMin: 40,
} as const;

export const stateForPct = (pct: number | null): ServiceState => (pct === null ? "info" : pct < 60 ? "ok" : pct < 85 ? "warn" : "alert");
const pctOf = (used: number, limit: number) => Math.min(999, Math.round((used / limit) * 1000) / 10);
const fmt = (n: number) => new Intl.NumberFormat("en").format(Math.round(n));
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(b > 50 * 1024 * 1024 ? 0 : 1)} MB`;
const monthStart = (now: Date) => `${now.toISOString().slice(0, 7)}-01`;

type Sums = Record<string, number>;

async function sumSince(db: Db, keys: string[], sinceDay: string): Promise<Sums> {
  const rows = await db
    .select({ key: metricsDaily.key, total: sql<number>`sum(${metricsDaily.value})` })
    .from(metricsDaily)
    .where(and(inArray(metricsDaily.key, keys), gte(metricsDaily.day, sinceDay)))
    .groupBy(metricsDaily.key);
  const out: Sums = {};
  for (const r of rows) out[r.key] = Number(r.total);
  return out;
}

/** The latest day with a value for a key, and that value (snapshots and heartbeats). */
async function latest(db: Db, key: string): Promise<{ day: string; value: number } | null> {
  const rows = await db
    .select({ day: metricsDaily.day, value: metricsDaily.value })
    .from(metricsDaily)
    .where(and(sql`${metricsDaily.key} = ${key}`, sql`${metricsDaily.value} > 0`))
    .orderBy(sql`${metricsDaily.day} desc`)
    .limit(1);
  return rows[0] ? { day: rows[0].day, value: Number(rows[0].value) } : null;
}

async function openUptimeIncidents(db: Db): Promise<number> {
  const rows = await db.select({ key: metricsDaily.key }).from(metricsDaily).where(like(metricsDaily.key, "uptime_issue_%"));
  const open = new Set<string>();
  const closed = new Set<string>();
  for (const r of rows) {
    const m = /^uptime_issue_(\d+)_(open|closed)$/.exec(r.key);
    if (!m) continue;
    (m[2] === "open" ? open : closed).add(m[1]);
  }
  let n = 0;
  for (const id of open) if (!closed.has(id)) n++;
  return n;
}

const minutesAgo = (epochSeconds: number, now: Date) => Math.max(0, Math.round((now.getTime() / 1000 - epochSeconds) / 60));

export type ServiceBoard = { month: string; at: string; rows: ServiceRow[] };

export async function serviceBoard(db: Db, now = new Date()): Promise<ServiceBoard> {
  const today = dayKey(now);
  const since = monthStart(now);
  const month = await sumSince(db, ["pageviews", "emails_sent", "telegram_sent", "telegram_429", "discord_sent", "push_sent", "anthropic_in", "anthropic_out", "anthropic_cost_cents", "tavily_calls", "indexnow_daily", "api_calls", "mcp_calls", "feedback_received", "feedback_shipped", "errors_server", "errors_cron"], since);
  const day = await sumSince(db, ["emails_sent", "telegram_sent", "telegram_429", "discord_sent", "push_sent", "pageviews"], today);
  const dbBytes = (await latest(db, "db_bytes"))?.value ?? 0;
  const hourlyAt = (await latest(db, "cron_hourly_at"))?.value ?? 0;
  const pushAt = (await latest(db, "cron_push_at"))?.value ?? 0;
  const syncAt = (await latest(db, "cron_sync_at"))?.value ?? 0;
  const syncAge = syncAt ? Math.round((now.getTime() / 1000 - syncAt) / 60) : null;
  const pushSubs = (await latest(db, "push_subs"))?.value ?? 0;
  const backup = await latest(db, "backup_done");
  const domainExp = (await latest(db, "domain_expires_at"))?.value ?? 0;
  const costReported = (await latest(db, "anthropic_cost_cents"))?.value ?? 0;
  const incidents = await openUptimeIncidents(db);

  const rows: ServiceRow[] = [];
  const push = (r: Omit<ServiceRow, "pct" | "state"> & { pct?: number | null; state?: ServiceState }) => {
    const pct = r.pct ?? (r.used !== null && r.limit ? pctOf(r.used, r.limit) : null);
    rows.push({ ...r, pct, state: r.state ?? stateForPct(pct) });
  };

  // Hosting
  push({ key: "vercel", name: "Vercel", role: "hosting, functions, daily cron", used: null, limit: null, usage: "not exposed on Hobby", ceiling: `${CEILINGS.vercelBandwidthGb} GB · ${fmt(CEILINGS.vercelInvocations)} invocations / month`, note: "Bandwidth and invocations live in the Vercel dashboard. Hobby crons run once a day; pg_cron runs the rest.", link: "https://vercel.com/dashboard/usage", state: "info" });
  push({ key: "vercel_analytics", name: "Vercel Web Analytics", role: "page views, Web Vitals", used: month.pageviews ?? 0, limit: CEILINGS.vercelAnalyticsEvents, usage: `${fmt(month.pageviews ?? 0)} page renders this month · ${fmt(day.pageviews ?? 0)} today`, ceiling: `${fmt(CEILINGS.vercelAnalyticsEvents)} events / month`, note: "Counted by the app on every page render; the Vercel dashboard stops recording past its ceiling until the month turns." });

  // Database and jobs
  push({ key: "supabase_db", name: "Supabase Postgres", role: "the database", used: dbBytes, limit: CEILINGS.supabaseDbBytes, usage: mb(dbBytes), ceiling: `${mb(CEILINGS.supabaseDbBytes)} free project`, note: "Daily snapshot by the hourly job.", link: "https://supabase.com/dashboard/project/udvtuxaxzfimeoubofdz/reports" });
  push({ key: "supabase_egress", name: "Supabase egress", role: "bytes out of the database", used: null, limit: null, usage: "dashboard only", ceiling: `${CEILINGS.supabaseEgressGb} GB / month`, note: "No API for it on the free plan.", link: "https://supabase.com/dashboard/project/udvtuxaxzfimeoubofdz/reports", state: "info" });
  const hourlyAge = hourlyAt ? minutesAgo(hourlyAt, now) : null;
  const pushAge = pushAt ? minutesAgo(pushAt, now) : null;
  push({ key: "pg_cron", name: "Supabase pg_cron + pg_net", role: "hourly job, the five-minute push job, the ten-minute calendar sync", used: null, limit: null, usage: `hourly ${hourlyAge === null ? "never" : `${hourlyAge} min ago`} · push ${pushAge === null ? "never" : `${pushAge} min ago`} · sync ${syncAge === null ? "never" : `${syncAge} min ago`}`, ceiling: `hourly < ${CEILINGS.hourlyCronMaxAgeMin} min · push < ${CEILINGS.pushCronMaxAgeMin} min · sync < ${CEILINGS.syncCronMaxAgeMin} min`, note: "Reminders, waitlists, lessons, offers, calendars, listening, backups, digests all hang off these three.", state: hourlyAge !== null && hourlyAge < CEILINGS.hourlyCronMaxAgeMin && pushAge !== null && pushAge < CEILINGS.pushCronMaxAgeMin && (syncAge === null || syncAge < CEILINGS.syncCronMaxAgeMin) ? "ok" : "alert" });

  // Mail
  push({ key: "resend_month", name: "Resend, this month", role: "outbound email", used: emailEnabled() ? (month.emails_sent ?? 0) : null, limit: CEILINGS.resendPerMonth, usage: emailEnabled() ? `${fmt(month.emails_sent ?? 0)} sent` : "off", ceiling: `${fmt(CEILINGS.resendPerMonth)} / month`, note: "Free plan. Paid tiers only past fifty emails a day, by decision.", state: emailEnabled() ? undefined : "off" });
  push({ key: "resend_day", name: "Resend, today", role: "outbound email", used: emailEnabled() ? (day.emails_sent ?? 0) : null, limit: CEILINGS.resendPerDay, usage: emailEnabled() ? `${fmt(day.emails_sent ?? 0)} sent` : "off", ceiling: `${CEILINGS.resendPerDay} / day`, note: "Inbound mail (claude@, feedback@) arrives through the Resend webhook and has no ceiling.", state: emailEnabled() ? undefined : "off" });

  // Chat platforms
  const tgOn = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const tg429 = day.telegram_429 ?? 0;
  push({ key: "telegram", name: "Telegram Bot API", role: "cards, the coach's assistant, alerts to you", used: null, limit: null, usage: tgOn ? `${fmt(day.telegram_sent ?? 0)} calls today · ${fmt(month.telegram_sent ?? 0)} this month${tg429 ? ` · ${tg429} rate-limited today` : ""}` : "off", ceiling: `${CEILINGS.telegramPerSecond} messages / second · 20 / minute per group`, note: "No monthly ceiling. A rate-limited reply is retried by Telegram's own timing; a day with many is the signal.", state: !tgOn ? "off" : tg429 > 0 ? "warn" : "ok" });
  const dcOn = Boolean(process.env.DISCORD_BOT_TOKEN);
  push({ key: "discord", name: "Discord API", role: "cards and /feedback in servers", used: null, limit: null, usage: dcOn ? `${fmt(day.discord_sent ?? 0)} calls today · ${fmt(month.discord_sent ?? 0)} this month` : "off", ceiling: "50 requests / second", note: "No monthly ceiling.", state: dcOn ? "ok" : "off" });
  push({ key: "web_push", name: "Web Push (VAPID)", role: "reminders on phones", used: null, limit: null, usage: pushEnabled() ? `${fmt(pushSubs)} devices · ${fmt(day.push_sent ?? 0)} sent today` : "off", ceiling: "no ceiling", note: "Apple and Google push services, free.", state: pushEnabled() ? "ok" : "off" });

  // Models and search
  const cap = anthropicCapUsd();
  const estUsd = estimateCostUsd(month.anthropic_in ?? 0, month.anthropic_out ?? 0);
  const reportedUsd = costReported ? costReported / 100 : null;
  const anthropicUsd = reportedUsd ?? estUsd;
  push({
    key: "anthropic",
    name: "Anthropic API",
    role: "feedback replies, listening drafts, answer pages",
    used: Math.round(anthropicUsd * 100) / 100,
    limit: cap,
    usage: `$${anthropicUsd.toFixed(2)} ${reportedUsd !== null ? "billed" : "estimated"} this month · ${fmt((month.anthropic_in ?? 0) / 1000)}k in, ${fmt((month.anthropic_out ?? 0) / 1000)}k out`,
    ceiling: `$${cap} / month, your cap`,
    note: reportedUsd !== null ? "Billed figure from the organisation's cost report, refreshed hourly." : `Estimated from our own token counters at ${listenModel()} list prices${anthropicAdminKey() ? "; the cost report could not be read" : "; add ANTHROPIC_ADMIN_KEY for the billed figure"}.`,
  });
  const tavilyOn = Boolean(process.env.TAVILY_API_KEY);
  push({ key: "tavily", name: "Tavily", role: "web search for the desk", used: tavilyOn ? (month.tavily_calls ?? 0) : null, limit: CEILINGS.tavilyCredits, usage: tavilyOn ? `${fmt(month.tavily_calls ?? 0)} credits this month` : "off", ceiling: `${fmt(CEILINGS.tavilyCredits)} credits / month`, note: tavilyOn && !(month.tavily_calls ?? 0) ? "Key stored; the app has not needed it yet." : "Free Researcher plan.", state: tavilyOn ? undefined : "off" });
  push({ key: "google", name: "Google Search Console", role: "impressions per language, sitemap", used: null, limit: null, usage: searchConsoleEnabled() ? "configured, read weekly" : "off", ceiling: "quota far above our use", note: "Service account; APIs enabled by it.", state: searchConsoleEnabled() ? "ok" : "off" });
  push({ key: "indexnow", name: "IndexNow", role: "Bing, Yandex, Seznam, Naver", used: null, limit: null, usage: `${fmt(month.indexnow_daily ?? 0)} submissions this month`, ceiling: "no practical ceiling", note: "Key file at the domain root.", state: "ok" });

  // Outside jobs
  const backupAgeH = backup ? Math.round((now.getTime() - new Date(`${backup.day}T23:59:59Z`).getTime()) / 3_600_000) : null;
  push({ key: "backup", name: "GitHub backup", role: "nightly export to the private repository", used: null, limit: null, usage: backup ? `last on ${backup.day}` : "never", ceiling: `under ${CEILINGS.backupMaxAgeHours} h old`, note: "Sixty days kept. Token expiry would show here first.", state: backup && backupAgeH !== null && backupAgeH <= CEILINGS.backupMaxAgeHours ? "ok" : "alert" });
  push({ key: "uptime", name: "GitHub Actions uptime probe", role: "outside check every ten minutes", used: null, limit: null, usage: incidents === 0 ? "no open incident" : `${incidents} open incident${incidents > 1 ? "s" : ""}`, ceiling: "public repository: free minutes", note: "Opens an issue and messages you while the site is down.", link: process.env.UPTIME_REPO ? `https://github.com/${process.env.UPTIME_REPO}/issues?q=label%3Auptime` : undefined, state: incidents === 0 ? "ok" : "alert" });

  // Domain
  const domainDays = domainExp ? Math.floor((domainExp * 1000 - now.getTime()) / 86_400_000) : null;
  push({ key: "domain", name: "kicksma.sh at Porkbun", role: "the domain and DNS", used: null, limit: null, usage: domainDays === null ? "expiry not recorded" : `renews in ${domainDays} days`, ceiling: `warn at ${CEILINGS.domainWarnDays} d, alert at ${CEILINGS.domainAlertDays} d`, note: "Read from Porkbun by the daily session and posted here. The one renewal only you can pay.", state: domainDays === null ? "warn" : domainDays <= CEILINGS.domainAlertDays ? "alert" : domainDays <= CEILINGS.domainWarnDays ? "warn" : "ok" });

  // Loops
  push({ key: "feedback", name: "Feedback loop", role: "notes from players and coaches", used: null, limit: null, usage: `${fmt(month.feedback_received ?? 0)} received · ${fmt(month.feedback_shipped ?? 0)} shipped this month`, ceiling: "answered within a day", note: "Four doors, one desk.", state: "ok" });
  push({ key: "api", name: "Public API and MCP", role: "people's assistants", used: null, limit: null, usage: `${fmt(month.api_calls ?? 0)} API · ${fmt(month.mcp_calls ?? 0)} MCP calls this month`, ceiling: "our own rate limits", note: "Keys are instant; every crawler is welcome.", state: "ok" });
  push({ key: "errors", name: "Error store", role: "every production exception", used: null, limit: null, usage: `${fmt(month.errors_server ?? 0)} server · ${fmt(month.errors_cron ?? 0)} cron this month`, ceiling: "fixed by the daily session", note: "Rows unseen for ninety days disappear.", state: "ok" });

  return { month: since.slice(0, 7), at: now.toISOString(), rows };
}

/** Rows that deserve a line on Sunday: anything past sixty percent, plus anything alerting. */
export const boardHighlights = (board: ServiceBoard): ServiceRow[] => board.rows.filter((r) => r.state === "alert" || (r.pct !== null && r.pct >= 60));
