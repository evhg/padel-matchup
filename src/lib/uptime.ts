import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily } from "@/db/schema";
import { dayKey, setMetric } from "@/lib/domain/metrics";
import { ownerTelegramId } from "@/lib/listen/tick";
import { esc, sendMessage, telegramEnabled } from "@/lib/telegram/api";

/**
 * The GitHub Actions probe (.github/workflows/uptime.yml) opens an `uptime`
 * issue when kicksma.sh stops answering and closes it when it is back. When
 * the workflow could not tell the owner itself (no Telegram secrets there),
 * the app relays each issue state once, on its next hourly run.
 */
export const uptimeRepo = () => process.env.UPTIME_REPO ?? "evhg/padel-matchup";

type Issue = { number: number; state: "open" | "closed"; html_url: string; created_at: string; closed_at: string | null; labels?: { name?: string }[]; pull_request?: unknown };

const stamp = (iso: string) => iso.replace("T", " ").slice(0, 16);

export async function relayUptimeIssues(db: Db, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<{ relayed: number }> {
  const owner = ownerTelegramId();
  if (!owner || !telegramEnabled()) return { relayed: 0 };
  const since = new Date(now.getTime() - 3 * 3600 * 1000).toISOString();
  let issues: Issue[] = [];
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${uptimeRepo()}/issues?labels=uptime&state=all&since=${encodeURIComponent(since)}&per_page=10`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "kicksmash-uptime-relay" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { relayed: 0 };
    issues = (await res.json()) as Issue[];
  } catch {
    return { relayed: 0 };
  }
  let relayed = 0;
  for (const i of issues) {
    if (i.pull_request || (i.labels ?? []).some((l) => l.name === "notified")) continue;
    const key = `uptime_issue_${i.number}_${i.state}`;
    const [seen] = await db.select({ value: metricsDaily.value }).from(metricsDaily).where(eq(metricsDaily.key, key)).limit(1);
    if (seen) continue;
    await setMetric(db, key, 1, dayKey(now));
    const text =
      i.state === "open"
        ? `⚠️ kicksma.sh has not been answering since ${stamp(i.created_at)} UTC (outside probe). Still down at the last check.`
        : `✅ kicksma.sh was down from ${stamp(i.created_at)} to ${stamp(i.closed_at ?? now.toISOString())} UTC (${Math.max(1, Math.round((new Date(i.closed_at ?? now).getTime() - new Date(i.created_at).getTime()) / 60000))} min) and is back.`;
    const res = await sendMessage(owner, esc(text), { keyboard: { inline_keyboard: [[{ text: "Details", url: i.html_url }]] } });
    if (res.ok) relayed++;
  }
  return { relayed };
}
