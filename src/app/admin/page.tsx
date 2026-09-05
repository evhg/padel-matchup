import type { Metadata } from "next";
import Link from "next/link";
import { TrendChart } from "@/components/admin/TrendChart";
import { getDb } from "@/db";
import { APP_NAME, emailEnabled } from "@/lib/config";
import { activitySeries, metricSeries, totals } from "@/lib/domain/metrics";
import { pushEnabled } from "@/lib/push";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

// Free-tier ceilings (documented plan limits; the dashboards linked below are the source of truth).
const LIMITS = {
  supabaseDbBytes: 500 * 1024 * 1024,
  resendPerMonth: 3000,
  resendPerDay: 100,
  vercelBandwidthGb: 100,
  vercelInvocations: 1_000_000,
};
const RANGES = [7, 30, 90] as const;

const SERIES = { blue: "#2a78d6", orange: "#eb6834", aqua: "#1baf7a" };
const STATUS = { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" };

const fmtInt = (v: number) => new Intl.NumberFormat("en").format(Math.round(v));
const fmtCompact = (v: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v);
const fmtMb = (b: number) => `${(b / 1024 / 1024).toFixed(b > 50 * 1024 * 1024 ? 0 : 1)} MB`;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

function Meter({ label, used, limit, format, note }: { label: string; used: number; limit: number; format: (v: number) => string; note?: string }) {
  const pct = Math.min(100, (used / limit) * 100);
  const color = pct < 60 ? STATUS.good : pct < 85 ? STATUS.warning : pct < 95 ? STATUS.serious : STATUS.critical;
  const icon = pct < 60 ? "✓" : pct < 85 ? "!" : "!!";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-bold">{label}</span>
        <span className="text-sm tabular-nums text-muted">
          {format(used)} <span className="text-faint">/ {format(limit)}</span>
        </span>
      </div>
      <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full" style={{ background: "#e9f2fb" }} aria-hidden>
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(pct > 0 ? 1.5 : 0, pct)}%`, background: color }} />
      </div>
      <div className="mt-1 flex justify-between text-xs text-faint">
        <span>
          <span className="font-bold" style={{ color }}>
            {icon}
          </span>{" "}
          {pct.toFixed(pct < 10 ? 1 : 0)}% used
        </span>
        {note && <span>{note}</span>}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, spark, color }: { label: string; value: string; sub?: string; spark?: number[]; color?: string }) {
  const s = spark ?? [];
  const max = Math.max(1, ...s);
  const pts = s.map((v, i) => `${(i / Math.max(1, s.length - 1)) * 100},${28 - (v / max) * 24}`).join(" ");
  return (
    <div className="card py-4">
      <div className="text-xs font-bold uppercase tracking-wider text-faint">{label}</div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div className="text-3xl font-extrabold leading-none">{value}</div>
        {s.length > 1 && (
          <svg viewBox="0 0 100 30" className="h-8 w-24 shrink-0" preserveAspectRatio="none" aria-hidden>
            <polyline points={pts} fill="none" stroke={color ?? SERIES.blue} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
        )}
      </div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const sp = await searchParams;
  const range = (RANGES as readonly number[]).includes(Number(sp.range)) ? Number(sp.range) : 30;
  const db = await getDb();
  const now = new Date();
  // Sequential on purpose: see metrics.ts (pooler + pipelining).
  const tot = await totals(db, now);
  const metrics = await metricSeries(db, ["emails_sent", "push_sent", "db_bytes", "players_total", "events_total", "push_subs", "cron_hourly_at", "cron_push_at", "errors_server", "errors_client", "errors_cron"], range, now);
  const act = await activitySeries(db, range, now);
  const month = await metricSeries(db, ["emails_sent"], now.getUTCDate(), now);
  const emailsToday = metrics.values.emails_sent.at(-1) ?? 0;
  const emailsMonth = sum(month.values.emails_sent);
  const lastCron = (k: string) => {
    const v = Math.max(0, ...metrics.values[k]);
    return v ? new Date(v * 1000) : null;
  };
  const ago = (d: Date | null) => (d ? `${Math.max(0, Math.round((now.getTime() - d.getTime()) / 60000))} min ago` : "never");
  const dbSeries = metrics.values.db_bytes.map((b, i, arr) => (b ? b : i > 0 ? arr[i - 1] : 0));
  const errorsToday = (metrics.values.errors_server.at(-1) ?? 0) + (metrics.values.errors_cron.at(-1) ?? 0);
  const clientErrorsToday = metrics.values.errors_client.at(-1) ?? 0;
  const health = [
    { label: "Database", ok: true, text: "connected" },
    { label: "Errors today", ok: errorsToday === 0, text: `${fmtInt(errorsToday)} server${clientErrorsToday ? ` · ${fmtInt(clientErrorsToday)} browser` : ""}` },
    { label: "Email (Resend)", ok: emailEnabled(), text: emailEnabled() ? "enabled" : "off" },
    { label: "Push (VAPID)", ok: pushEnabled(), text: pushEnabled() ? "enabled" : "off" },
    { label: "Hourly cron", ok: Boolean(lastCron("cron_hourly_at")) && now.getTime() - (lastCron("cron_hourly_at")?.getTime() ?? 0) < 2 * 3600e3, text: ago(lastCron("cron_hourly_at")) },
    { label: "Push cron (5 min)", ok: Boolean(lastCron("cron_push_at")) && now.getTime() - (lastCron("cron_push_at")?.getTime() ?? 0) < 20 * 60e3, text: ago(lastCron("cron_push_at")) },
  ];

  return (
    <>
      <header className="mx-auto flex w-full max-w-4xl items-center justify-between px-4 pt-5 pb-2">
        <Link href="/" prefetch={false} className="flex items-center gap-2 text-lg font-extrabold tracking-tight">
          <span className="inline-grid h-8 w-8 place-items-center rounded-xl bg-ink">
            <span className="h-4 w-4 rounded-full bg-accent" />
          </span>
          {APP_NAME} <span className="chip-muted ml-1">admin · read-only</span>
        </Link>
        <nav className="flex gap-1" aria-label="Range">
          {RANGES.map((r) => (
            <Link key={r} href={`/admin?range=${r}`} prefetch={false} className={`btn-xs ${r === range ? "btn-secondary" : "btn-ghost"}`} aria-current={r === range ? "page" : undefined}>
              {r}d
            </Link>
          ))}
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 pb-16">
        <section className="card flex flex-wrap items-end justify-between gap-6">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-faint">Matches and tournaments organized</div>
            <div className="mt-1 text-5xl font-extrabold leading-none tracking-tight">{fmtInt(tot.events)}</div>
            <div className="mt-2 text-sm text-muted">
              {fmtInt(tot.matches)} matches · {fmtInt(tot.tournaments)} tournaments · {fmtInt(tot.upcoming)} upcoming
            </div>
          </div>
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {health.map((h) => (
              <li key={h.label} className="flex items-center gap-2">
                <span className="inline-grid h-5 w-5 place-items-center rounded-full text-[11px] font-black text-white" style={{ background: h.ok ? STATUS.good : STATUS.critical }} aria-hidden>
                  {h.ok ? "✓" : "!"}
                </span>
                <span className="font-semibold">{h.label}</span>
                <span className="text-muted">{h.text}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="Players" value={fmtCompact(tot.players)} sub={`+${fmtInt(sum(act.values.newPlayers))} in ${range}d`} spark={act.values.newPlayers} />
          <Tile label="Joins" value={fmtCompact(sum(act.values.joins))} sub={`last ${range} days`} spark={act.values.joins} color={SERIES.aqua} />
          <Tile label="Emails sent" value={fmtCompact(sum(metrics.values.emails_sent))} sub={`${fmtInt(emailsToday)} today · ${fmtInt(emailsMonth)} this month`} spark={metrics.values.emails_sent} color={SERIES.orange} />
          <Tile label="Push reminders" value={fmtCompact(sum(metrics.values.push_sent))} sub={`${fmtInt(tot.pushSubs)} subscribed devices`} spark={metrics.values.push_sent} />
        </section>

        <section className="card flex flex-col gap-5">
          <div>
            <h2 className="font-extrabold">Free-tier limits</h2>
            <p className="text-xs text-muted">Measured by the app. Bandwidth and function counts live in the Vercel dashboard (no public API on Hobby).</p>
          </div>
          <Meter label="Supabase database size" used={tot.dbBytes} limit={LIMITS.supabaseDbBytes} format={fmtMb} note="free project: 500 MB" />
          <Meter label="Resend emails this month" used={emailsMonth} limit={LIMITS.resendPerMonth} format={fmtInt} note="free: 3,000 / month" />
          <Meter label="Resend emails today" used={emailsToday} limit={LIMITS.resendPerDay} format={fmtInt} note="free: 100 / day" />
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <a href="https://vercel.com/dashboard/usage" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between rounded-2xl bg-bg px-4 py-3 hover:bg-line/60">
              <span>
                <span className="font-bold">Vercel bandwidth &amp; functions</span>
                <span className="block text-xs text-muted">Hobby: {LIMITS.vercelBandwidthGb} GB · {fmtCompact(LIMITS.vercelInvocations)} invocations / month</span>
              </span>
              <span className="text-faint">↗</span>
            </a>
            <a href="https://supabase.com/dashboard/project/udvtuxaxzfimeoubofdz/reports" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between rounded-2xl bg-bg px-4 py-3 hover:bg-line/60">
              <span>
                <span className="font-bold">Supabase egress &amp; compute</span>
                <span className="block text-xs text-muted">free: 5 GB egress / month</span>
              </span>
              <span className="text-faint">↗</span>
            </a>
          </div>
        </section>

        <TrendChart title="Growth" subtitle="per day" days={act.days} series={[{ name: "New players", color: SERIES.blue, values: act.values.newPlayers }, { name: "Events created", color: SERIES.orange, values: act.values.eventsCreated }]} />
        <TrendChart title="Joins and confirmations" subtitle="per day" days={act.days} series={[{ name: "Joins", color: SERIES.aqua, values: act.values.joins }]} />
        <TrendChart title="Outbound messages" subtitle="per day" days={metrics.days} series={[{ name: "Emails", color: SERIES.orange, values: metrics.values.emails_sent }, { name: "Push", color: SERIES.blue, values: metrics.values.push_sent }]} />
        <TrendChart title="Errors" subtitle="per day · server actions, cron jobs and browser crash screens" days={metrics.days} series={[{ name: "Server", color: STATUS.critical, values: metrics.values.errors_server }, { name: "Cron", color: SERIES.orange, values: metrics.values.errors_cron }, { name: "Browser", color: SERIES.blue, values: metrics.values.errors_client }]} />
        <TrendChart title="Database size" subtitle="daily snapshot (hourly cron)" days={metrics.days} series={[{ name: "MB", color: SERIES.blue, values: dbSeries.map((b) => Math.round((b / 1024 / 1024) * 10) / 10) }]} unit="mb" />
        <TrendChart title="Totals" subtitle="daily snapshot" days={metrics.days} series={[{ name: "Players", color: SERIES.blue, values: metrics.values.players_total }, { name: "Events", color: SERIES.orange, values: metrics.values.events_total }, { name: "Push devices", color: SERIES.aqua, values: metrics.values.push_subs }]} />
        <p className="text-center text-xs text-faint">Read-only. No personal data is shown here.</p>
      </main>
    </>
  );
}
