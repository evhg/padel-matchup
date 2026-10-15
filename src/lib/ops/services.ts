import { and, gte, inArray, like, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily } from "@/db/schema";
import { BACKUP_ROW_CAP } from "@/lib/backup";
import { marksSince } from "@/lib/domain/emailMarks";
import { emailEnabled } from "@/lib/config";
import { dayKey } from "@/lib/domain/metrics";
import { pushEnabled } from "@/lib/push";
import { searchConsoleEnabled } from "@/lib/search/console";
import { AI_FEATURES, KEY_REFUSED_LINE, anthropicAdminKey, anthropicCapUsd, estimateCostUsd, listenModel } from "./anthropic";
import { PLAN, pacedTarget } from "@/lib/research/budget";
import { platformById } from "@/lib/booking/platforms";
import { scrapeBoard } from "@/lib/booking/scrape";

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
  // Hobby's Web Analytics allowance, shared by every project on the Vercel account: then a three-day
  // grace, then collection pauses, and nothing is billed. From vercel.com/docs/analytics/limits-and-pricing
  // (updated 25 August 2026), read on 24 September 2026. It said 2,500 here until then, and the board
  // put a month at 80% that was really at 4%.
  vercelAnalyticsEvents: 50_000,
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
/** A delivery row's words and state for the sends that failed today: said only when there are some, and never greener than yellow then. */
const failedToday = (n: number) => (n > 0 ? ` · ${fmt(n)} failed today` : "");
const warnIfFailed = (state: ServiceState, failed: number): ServiceState => (failed > 0 && (state === "ok" || state === "info") ? "warn" : state);

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

/** The newest reading of a gauge; by default a positive one, optionally only from a given day on and zero included (a monthly meter reads 0 on the 1st). */
async function latest(db: Db, key: string, o: { since?: string; zero?: boolean } = {}): Promise<{ day: string; value: number } | null> {
  const rows = await db
    .select({ day: metricsDaily.day, value: metricsDaily.value })
    .from(metricsDaily)
    .where(and(sql`${metricsDaily.key} = ${key}`, ...(o.zero ? [] : [sql`${metricsDaily.value} > 0`]), ...(o.since ? [sql`${metricsDaily.day} >= ${o.since}`] : [])))
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
  const month = await sumSince(db, ["pageviews", "emails_sent", "emails_failed", "telegram_sent", "telegram_429", "telegram_failed", "discord_sent", "push_sent", "push_failed", "anthropic_in", "anthropic_out", "anthropic_cost_cents", "tavily_calls", "indexnow_daily", "api_calls", "mcp_calls", "feedback_received", "feedback_shipped", "errors_server", "errors_cron"], since);
  const day = await sumSince(db, ["emails_sent", "emails_failed", "telegram_sent", "telegram_429", "telegram_failed", "discord_sent", "push_sent", "push_failed", "pageviews", "anthropic_failed"], today);
  const dbBytes = (await latest(db, "db_bytes"))?.value ?? 0;
  const hourlyAt = (await latest(db, "cron_hourly_at"))?.value ?? 0;
  const pushAt = (await latest(db, "cron_push_at"))?.value ?? 0;
  const syncAt = (await latest(db, "cron_sync_at"))?.value ?? 0;
  const syncAge = syncAt ? Math.round((now.getTime() / 1000 - syncAt) / 60) : null;
  const pushSubs = (await latest(db, "push_subs"))?.value ?? 0;
  const backup = await latest(db, "backup_done");
  const backupCapped = await latest(db, "backup_capped");
  const historyRebuilt = await latest(db, "backup_history_rebuilt");
  const historyKept = await latest(db, "backup_history_kept");
  const domainExp = (await latest(db, "domain_expires_at"))?.value ?? 0;
  const costReported = (await latest(db, "anthropic_cost_cents"))?.value ?? 0;
  // Red while the newest answer to our key is a refusal (src/lib/ops/anthropic.ts, recordModelCall).
  const keyRefusedAt = (await latest(db, "anthropic_refused_at"))?.value ?? 0;
  const keyRefused = keyRefusedAt > ((await latest(db, "anthropic_ok_at"))?.value ?? 0);
  const incidents = await openUptimeIncidents(db);

  const rows: ServiceRow[] = [];
  const push = (r: Omit<ServiceRow, "pct" | "state"> & { pct?: number | null; state?: ServiceState }) => {
    const pct = r.pct ?? (r.used !== null && r.limit ? pctOf(r.used, r.limit) : null);
    rows.push({ ...r, pct, state: r.state ?? stateForPct(pct) });
  };

  // Hosting
  push({ key: "vercel", name: "Vercel", role: "hosting, functions, daily cron", used: null, limit: null, usage: "not exposed on Hobby", ceiling: `${CEILINGS.vercelBandwidthGb} GB · ${fmt(CEILINGS.vercelInvocations)} invocations / month`, note: "Bandwidth and invocations live in the Vercel dashboard. Hobby crons run once a day; pg_cron runs the rest.", link: "https://vercel.com/dashboard/usage", state: "info" });
  push({ key: "vercel_analytics", name: "Vercel Web Analytics", role: "page views, Web Vitals", used: month.pageviews ?? 0, limit: CEILINGS.vercelAnalyticsEvents, usage: `${fmt(month.pageviews ?? 0)} page renders this month · ${fmt(day.pageviews ?? 0)} today`, ceiling: `${fmt(CEILINGS.vercelAnalyticsEvents)} events / month`, note: "Our own estimate: page renders counted on the server, crawlers left out; Vercel counts page views in the browser. Every project on the Vercel account shares the allowance. Past it, three days of grace, then Vercel stops recording until the next billing cycle; no bill." });

  // Database and jobs
  push({ key: "supabase_db", name: "Supabase Postgres", role: "the database", used: dbBytes, limit: CEILINGS.supabaseDbBytes, usage: mb(dbBytes), ceiling: `${mb(CEILINGS.supabaseDbBytes)} free project`, note: "Daily snapshot by the hourly job.", link: "https://supabase.com/dashboard/project/udvtuxaxzfimeoubofdz/reports" });
  push({ key: "supabase_egress", name: "Supabase egress", role: "bytes out of the database", used: null, limit: null, usage: "dashboard only", ceiling: `${CEILINGS.supabaseEgressGb} GB / month`, note: "No API for it on the free plan.", link: "https://supabase.com/dashboard/project/udvtuxaxzfimeoubofdz/reports", state: "info" });
  const hourlyAge = hourlyAt ? minutesAgo(hourlyAt, now) : null;
  const pushAge = pushAt ? minutesAgo(pushAt, now) : null;
  push({ key: "pg_cron", name: "Supabase pg_cron + pg_net", role: "hourly job, the five-minute push job, the ten-minute calendar sync", used: null, limit: null, usage: `hourly ${hourlyAge === null ? "never" : `${hourlyAge} min ago`} · push ${pushAge === null ? "never" : `${pushAge} min ago`} · sync ${syncAge === null ? "never" : `${syncAge} min ago`}`, ceiling: `hourly < ${CEILINGS.hourlyCronMaxAgeMin} min · push < ${CEILINGS.pushCronMaxAgeMin} min · sync < ${CEILINGS.syncCronMaxAgeMin} min`, note: "Reminders, waitlists, lessons, offers, calendars, listening, backups, digests all hang off these three.", state: hourlyAge !== null && hourlyAge < CEILINGS.hourlyCronMaxAgeMin && pushAge !== null && pushAge < CEILINGS.pushCronMaxAgeMin && (syncAge === null || syncAge < CEILINGS.syncCronMaxAgeMin) ? "ok" : "alert" });

  // Free court times read from the booking platforms' public pages (DECIDING rule 35): one line per
  // platform with a reader, and one per platform that listed clubs name but no reader reads.
  const scrapeLines = await scrapeBoard(db, now);
  if (!scrapeLines.length) push({ key: "scrape", name: "Court times from platforms", role: "free courts read from the booking platforms' public pages", used: null, limit: null, usage: "no platform reader yet", ceiling: "1 request / second / platform · 8 clubs / platform / run · 45 s", note: "A reader per platform goes in src/lib/booking/adapters/. Until one exists the job reads nothing.", state: "off" });
  const clubsOf = (n: number) => `${fmt(n)} listed club${n === 1 ? "" : "s"}`;
  for (const l of scrapeLines) {
    const name = platformById(l.platform)?.name ?? l.platform;
    if (l.state === "no_reader") {
      push({ key: `scrape_${l.platform}`, name: `Court times: ${name}`, role: "free courts read from the platform's public club pages", used: null, limit: null, usage: `no reader: ${clubsOf(l.unread)} on ${name} get no times`, ceiling: "none: nothing is read", note: "No file in src/lib/booking/adapters/ reads this platform, so the job never visits its clubs.", state: "info" });
      continue;
    }
    const usage =
      l.state === "off"
        ? "off (switched off: scrape_off_* row or SCRAPE_DISABLED)"
        : l.state === "stopped"
          ? "stopped: the page changed at two clubs; the reader needs a fix, and a deploy of new code starts it again"
          : l.state === "resting"
            ? `resting until ${l.restUntil!.toISOString().slice(0, 16).replace("T", " ")} UTC after a block`
            : `fresh: ${fmt(l.fresh)} club${l.fresh === 1 ? "" : "s"} read in the last hour`;
    const unread = l.unread ? ` · ${clubsOf(l.unread)} not read: no link a reader takes` : "";
    // "Book this court" fills the platform's checkout (DECIDING rule 36) while its club page still builds that link.
    const checkout = l.checkout === "lost" ? ` · checkout off: ${name}'s page no longer builds its link (match pages give the day page)` : l.checkout === "off" ? " · checkout off (checkout_off_* row)" : l.checkout === "on" ? " · checkout on" : "";
    push({ key: `scrape_${l.platform}`, name: `Court times: ${name}`, role: "free courts read from the platform's public club pages", used: null, limit: null, usage: `${usage} · ${fmt(l.requestsToday)} requests today${l.blockedToday ? ` · blocked ${l.blockedToday} time(s) today` : ""}${unread}${checkout}`, ceiling: "1 request / second · 8 a club · rest 6 h, 24 h, then a week after a block", note: "Today read every 15 minutes, the next two days about hourly, by the push job. A 401, 403, 429 or a challenge stops the platform; nothing gets around a block.", state: l.state === "off" ? "off" : l.state === "stopped" ? "alert" : l.state === "resting" || l.checkout === "lost" ? "warn" : "ok" });
  }

  // Mail. A send that failed today turns the row yellow and says how many: until 15 October 2026 a
  // failure was a log line only, and "the emails weren't sent out?" (23 September) had no answer here.
  const mailFailed = day.emails_failed ?? 0;
  push({ key: "resend_month", name: "Resend, this month", role: "outbound email", used: emailEnabled() ? (month.emails_sent ?? 0) : null, limit: CEILINGS.resendPerMonth, usage: emailEnabled() ? `${fmt(month.emails_sent ?? 0)} sent${failedToday(mailFailed)}` : "off", ceiling: `${fmt(CEILINGS.resendPerMonth)} / month`, note: "Free plan. Paid tiers only past fifty emails a day, by decision.", state: emailEnabled() ? warnIfFailed(stateForPct(pctOf(month.emails_sent ?? 0, CEILINGS.resendPerMonth)), mailFailed) : "off" });
  push({ key: "resend_day", name: "Resend, today", role: "outbound email", used: emailEnabled() ? (day.emails_sent ?? 0) : null, limit: CEILINGS.resendPerDay, usage: emailEnabled() ? `${fmt(day.emails_sent ?? 0)} sent${failedToday(mailFailed)}` : "off", ceiling: `${CEILINGS.resendPerDay} / day`, note: "Inbound mail (claude@, feedback@) arrives through the Resend webhook and has no ceiling. A failed send is Resend's refusal or no answer; the function log says why.", state: emailEnabled() ? warnIfFailed(stateForPct(pctOf(day.emails_sent ?? 0, CEILINGS.resendPerDay)), mailFailed) : "off" });
  // Bounces and complaints this month against what was sent: the two rates a mail provider judges a
  // sender by. A marked address is not written to again (src/lib/domain/emailMarks.ts).
  const marks = await marksSince(db, new Date(`${since}T00:00:00Z`));
  const sentMonth = month.emails_sent ?? 0;
  const bounceRate = sentMonth ? marks.bounced / sentMonth : 0;
  const complaintRate = sentMonth ? marks.complained / sentMonth : 0;
  push({ key: "email_marks", name: "Bounces and complaints", role: "addresses that stopped working", used: null, limit: null, usage: `${marks.bounced} bounced · ${marks.complained} complained · of ${fmt(sentMonth)} sent this month`, ceiling: "bounces under 4% · complaints under 0.3%", note: "A marked address gets no more mail until a code proves it works. Gmail and Yahoo slow a sender whose complaints reach 0.3%.", state: !emailEnabled() ? "off" : complaintRate >= 0.003 || bounceRate >= 0.04 ? "alert" : complaintRate >= 0.001 || bounceRate >= 0.02 ? "warn" : "ok" });

  // Chat platforms
  const tgOn = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const tg429 = day.telegram_429 ?? 0;
  const tgFailed = day.telegram_failed ?? 0;
  push({ key: "telegram", name: "Telegram Bot API", role: "cards, the coach's assistant, alerts to you", used: null, limit: null, usage: tgOn ? `${fmt(day.telegram_sent ?? 0)} calls today · ${fmt(month.telegram_sent ?? 0)} this month${tg429 ? ` · ${tg429} rate-limited today` : ""}${failedToday(tgFailed)}` : "off", ceiling: `${CEILINGS.telegramPerSecond} messages / second · 20 / minute per group`, note: "No monthly ceiling. A rate-limited reply is retried by Telegram's own timing; a day with many is the signal. A failed call is one Telegram refused (a blocked bot, a chat that is gone) or never answered.", state: !tgOn ? "off" : tg429 > 0 || tgFailed > 0 ? "warn" : "ok" });
  const dcOn = Boolean(process.env.DISCORD_BOT_TOKEN);
  push({ key: "discord", name: "Discord API", role: "cards and /feedback in servers", used: null, limit: null, usage: dcOn ? `${fmt(day.discord_sent ?? 0)} calls today · ${fmt(month.discord_sent ?? 0)} this month` : "off", ceiling: "50 requests / second", note: "No monthly ceiling.", state: dcOn ? "ok" : "off" });
  const pushFailed = day.push_failed ?? 0;
  push({ key: "web_push", name: "Web Push (VAPID)", role: "reminders on phones", used: null, limit: null, usage: pushEnabled() ? `${fmt(pushSubs)} devices · ${fmt(day.push_sent ?? 0)} sent today${failedToday(pushFailed)}` : "off", ceiling: "no ceiling", note: "Apple and Google push services, free. A phone that dropped its subscription is removed, not counted as failed.", state: pushEnabled() ? (pushFailed > 0 ? "warn" : "ok") : "off" });

  // Models and search
  const cap = anthropicCapUsd();
  const estUsd = estimateCostUsd(month.anthropic_in ?? 0, month.anthropic_out ?? 0);
  const reportedUsd = costReported ? costReported / 100 : null;
  const anthropicUsd = reportedUsd ?? estUsd;
  push({
    key: "anthropic",
    name: "Anthropic API",
    role: AI_FEATURES.join(", "),
    used: Math.round(anthropicUsd * 100) / 100,
    limit: cap,
    usage: `${keyRefused ? `${KEY_REFUSED_LINE} · ` : ""}$${anthropicUsd.toFixed(2)} ${reportedUsd !== null ? "billed" : "estimated"} this month · ${fmt((month.anthropic_in ?? 0) / 1000)}k in, ${fmt((month.anthropic_out ?? 0) / 1000)}k out${day.anthropic_failed ? ` · ${fmt(day.anthropic_failed)} failed today` : ""}`,
    ceiling: `$${cap} / month, your cap`,
    ...(keyRefused ? { state: "alert" as const } : {}),
    note: reportedUsd !== null ? "Billed figure from the organisation's cost report, refreshed hourly." : `Estimated from our own token counters at ${listenModel()} list prices${anthropicAdminKey() ? "; the cost report could not be read" : "; add ANTHROPIC_ADMIN_KEY for the billed figure"}.`,
  });
  const tavilyOn = Boolean(process.env.TAVILY_API_KEY);
  const tavilyMeter = await latest(db, "tavily_plan_used", { since, zero: true });
  const tavilyLimit = (await latest(db, "tavily_plan_limit"))?.value || CEILINGS.tavilyCredits;
  const tavilyUsed = tavilyMeter ? tavilyMeter.value : (month.tavily_calls ?? 0);
  const tavilyPace = pacedTarget(now, tavilyLimit);
  // Spent evenly by design, so the raw percentage means nothing here: the alarm is the hard stop, the warning is running ahead of the pace by more than the reserve.
  const tavilyState: ServiceState = !tavilyOn ? "off" : tavilyUsed >= tavilyLimit - PLAN.hardStop ? "alert" : tavilyUsed > tavilyPace + PLAN.reserve ? "warn" : "ok";
  push({
    key: "tavily",
    name: "Tavily",
    role: "the research desk: listening searches, club and coach discovery, answer grounding",
    used: tavilyOn ? tavilyUsed : null,
    limit: tavilyLimit,
    usage: tavilyOn ? `${fmt(tavilyUsed)} of ${fmt(tavilyLimit)} credits · even pace says ${fmt(tavilyPace)} by now` : "off",
    ceiling: `${fmt(tavilyLimit)} credits / month, spent evenly, the last five never`,
    note: !tavilyOn ? "Free Researcher plan." : tavilyUsed ? (tavilyMeter ? "Tavily's own meter, read hourly." : "Our counter; Tavily's meter has not answered yet.") : "Key stored; the desk starts spending on the next hourly run.",
    state: tavilyState,
  });
  push({ key: "google", name: "Google Search Console", role: "impressions per language, sitemap", used: null, limit: null, usage: searchConsoleEnabled() ? "configured, read weekly" : "off", ceiling: "quota far above our use", note: "Service account; APIs enabled by it.", state: searchConsoleEnabled() ? "ok" : "off" });
  push({ key: "indexnow", name: "IndexNow", role: "Bing, Yandex, Seznam, Naver", used: null, limit: null, usage: `${fmt(month.indexnow_daily ?? 0)} submissions this month`, ceiling: "no practical ceiling", note: "Key file at the domain root.", state: "ok" });

  // Outside jobs
  const backupAgeH = backup ? Math.round((now.getTime() - new Date(`${backup.day}T23:59:59Z`).getTime()) / 3_600_000) : null;
  // A table that filled its cap was cut short: the file is still a backup, but not of everything.
  const cutShort = backup && backupCapped && backupCapped.day === backup.day ? backupCapped.value : 0;
  // Each night rebuilds the repository's history with only the kept days (src/lib/backup.ts). One night
  // that does not rebuild it is harmless; more than two in a row and /privacy's "about sixty days" stops
  // being true, so the row turns yellow. The age of the last rebuild against the last backup is the
  // measure, so it also sees a night that counts neither metric: a run that the hourly job's 60 s stopped
  // after `backup_done` and before the history step, which the next run answers "already" and never
  // retries. Until 11 October 2026 only `backup_history_kept` could turn the row yellow, and such nights
  // left it green. The job's log line says why a night kept the history.
  const keptLast = historyKept && (!historyRebuilt || historyKept.day > historyRebuilt.day) ? historyKept.day : null;
  const rebuiltBehind = backup ? (historyRebuilt ? (Date.parse(backup.day) - Date.parse(historyRebuilt.day)) / 86_400_000 : Infinity) : 0;
  const historyStale = rebuiltBehind > 2;
  const historyText = keptLast
    ? ` · history kept on ${keptLast}, last rebuilt ${historyRebuilt?.day ?? "never"}`
    : !backup
      ? ""
      : !historyRebuilt
        ? " · history never rebuilt"
        : historyRebuilt.day === backup.day
          ? ` · history rebuilt on ${historyRebuilt.day}`
          : ` · history last rebuilt on ${historyRebuilt.day}`;
  push({ key: "backup", name: "GitHub backup", role: "nightly export to the private repository", used: null, limit: null, usage: backup ? `last on ${backup.day}${cutShort ? ` · ${cutShort} table(s) cut at ${BACKUP_ROW_CAP.toLocaleString("en")} rows` : ""}${historyText}` : "never", ceiling: `under ${CEILINGS.backupMaxAgeHours} h old · history rebuilt within 2 days of it`, note: "About sixty days kept (the cutoff day too, so 61 nights), and each night the history is rebuilt with only those days (docs/OPERATING.md says how to undo one). Token expiry would show here first. Restore one on a laptop with scripts/restore-backup.ts.", state: !backup || backupAgeH === null || backupAgeH > CEILINGS.backupMaxAgeHours ? "alert" : cutShort || historyStale ? "warn" : "ok" });
  push({ key: "uptime", name: "GitHub Actions uptime probe", role: "outside check when GitHub runs it: about every five hours", used: null, limit: null, usage: incidents === 0 ? "no open incident" : `${incidents} open incident${incidents > 1 ? "s" : ""}`, ceiling: "public repository: free minutes", note: "Opens an issue and messages you while the site is down. The workflow asks for every ten minutes; GitHub ran the 100 scheduled runs to 15 October 2026 a median of 301 minutes apart, and once 585, so an outage can last hours before this row knows.", link: process.env.UPTIME_REPO ? `https://github.com/${process.env.UPTIME_REPO}/issues?q=label%3Auptime` : undefined, state: incidents === 0 ? "ok" : "alert" });

  // Domain
  const domainDays = domainExp ? Math.floor((domainExp * 1000 - now.getTime()) / 86_400_000) : null;
  push({ key: "domain", name: "kicksma.sh at Porkbun", role: "the domain and DNS", used: null, limit: null, usage: domainDays === null ? "expiry not recorded" : `renews in ${domainDays} days`, ceiling: `warn at ${CEILINGS.domainWarnDays} d, alert at ${CEILINGS.domainAlertDays} d`, note: "Read from Porkbun by the daily session and posted here. The one renewal only you can pay.", state: domainDays === null ? "warn" : domainDays <= CEILINGS.domainAlertDays ? "alert" : domainDays <= CEILINGS.domainWarnDays ? "warn" : "ok" });

  // Loops
  push({ key: "feedback", name: "Feedback loop", role: "notes from players and coaches", used: null, limit: null, usage: `${fmt(month.feedback_received ?? 0)} received · ${fmt(month.feedback_shipped ?? 0)} shipped this month`, ceiling: "read every day", note: "Four doors, one desk.", state: "ok" });
  push({ key: "api", name: "Public API and MCP", role: "people's assistants", used: null, limit: null, usage: `${fmt(month.api_calls ?? 0)} API · ${fmt(month.mcp_calls ?? 0)} MCP calls this month`, ceiling: "our own rate limits", note: "Keys are instant; every crawler is welcome.", state: "ok" });
  push({ key: "errors", name: "Error store", role: "every production exception", used: null, limit: null, usage: `${fmt(month.errors_server ?? 0)} server · ${fmt(month.errors_cron ?? 0)} cron this month`, ceiling: "fixed by the daily session", note: "Rows unseen for ninety days disappear.", state: "ok" });

  return { month: since.slice(0, 7), at: now.toISOString(), rows };
}

/** Rows that deserve a line on Sunday: anything past sixty percent, plus anything alerting. */
export const boardHighlights = (board: ServiceBoard): ServiceRow[] => board.rows.filter((r) => r.state === "alert" || r.state === "warn");
