import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { listenItems, metricsDaily } from "@/db/schema";
import { bumpMetric, dayKey, setMetric } from "@/lib/domain/metrics";
import { WINDOW_MS } from "@/lib/listen/window";

/**
 * What the Anthropic key costs us. Two sources: our own token counters priced at the
 * model's list rates (always available), and the organisation's cost report when an
 * Admin API key is present (the figure Anthropic itself bills). Both are compared to the
 * monthly cap the owner set in the console, mirrored here as ANTHROPIC_MONTHLY_CAP_USD.
 */

/** List prices per million tokens, USD. Kept in one place so a price change is one line. */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
};

export const listenModel = () => process.env.LISTEN_MODEL || "claude-sonnet-5";
export const anthropicCapUsd = () => {
  const v = Number(process.env.ANTHROPIC_MONTHLY_CAP_USD ?? 20);
  return Number.isFinite(v) && v > 0 ? v : 20;
};
export const anthropicAdminKey = () => process.env.ANTHROPIC_ADMIN_KEY?.trim() || null;

/** Tokens in and out → USD at the model's list price; unknown models fall back to Sonnet 5 rates. */
export function estimateCostUsd(inputTokens: number, outputTokens: number, model = listenModel()): number {
  const p = MODEL_PRICES[model] ?? MODEL_PRICES["claude-sonnet-5"];
  return (Math.max(0, inputTokens) * p.input + Math.max(0, outputTokens) * p.output) / 1_000_000;
}

export type CostReport = { usd: number; from: string; to: string };

/**
 * The organisation's cost report for a window (Admin API, raw HTTP; not in the SDKs).
 * Amounts arrive as decimal strings in cents; the sum is returned in dollars. Null when
 * there is no admin key or the report cannot be read.
 */
export async function fetchCostReport(from: Date, to: Date, fetchImpl: typeof fetch = fetch): Promise<CostReport | null> {
  const key = anthropicAdminKey();
  if (!key) return null;
  try {
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", from.toISOString());
    url.searchParams.set("ending_at", to.toISOString());
    url.searchParams.set("bucket_width", "1d");
    let cents = 0;
    let page: string | null = null;
    for (let i = 0; i < 10; i++) {
      if (page) url.searchParams.set("page", page);
      const res = await fetchImpl(url, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: { results?: { amount?: string | number; currency?: string }[] }[]; has_more?: boolean; next_page?: string | null };
      for (const bucket of json.data ?? []) for (const r of bucket.results ?? []) cents += Number(r.amount ?? 0) || 0;
      if (!json.has_more || !json.next_page) break;
      page = json.next_page;
    }
    return { usd: cents / 100, from: from.toISOString(), to: to.toISOString() };
  } catch {
    return null;
  }
}

/** A 401 or a 403 from the Messages API: the key itself was refused, so every further call this run is refused too. */
export const keyRefused = (status: number) => status === 401 || status === 403;

/** What the service board says when the newest answer to our key was a refusal. */
export const KEY_REFUSED_LINE = "the key was refused: set a new ANTHROPIC_API_KEY";

/**
 * After every Messages API call, whatever its feature: the tokens it spent, and a failure where the
 * board and the digest can see it. From 5 October 2026 every call answered 401 for six days while
 * `listen_drafts` counted each one as a draft and the board stayed green. A refusal and an accepted
 * call each leave a time (`anthropic_refused_at`, `anthropic_ok_at`, epoch seconds), and the board
 * is red while the refusal is the newer of the two. `status` is 0 when no answer came at all.
 */
export async function recordModelCall(db: Db, o: { status: number; ok: boolean; usage?: { input: number; output: number }; now?: Date }): Promise<void> {
  const now = o.now ?? new Date();
  const day = dayKey(now);
  const at = Math.floor(now.getTime() / 1000);
  // Before `anthropic_ok_at` moves: the restore reads it to know this is the first accepted call.
  if (o.ok) await restoreRefusedItems(db, now).catch(() => undefined);
  await Promise.all([
    o.usage?.input ? bumpMetric(db, "anthropic_in", o.usage.input, day) : null,
    o.usage?.output ? bumpMetric(db, "anthropic_out", o.usage.output, day) : null,
    o.ok ? setMetric(db, "anthropic_ok_at", at, day) : bumpMetric(db, "anthropic_failed", 1, day),
    !o.ok && keyRefused(o.status) ? setMetric(db, "anthropic_refused_at", at, day) : null,
  ]);
}

/**
 * What a listening item's `last_error` says when the key itself was refused: the Messages API's own
 * words for a 401, and the line `draftReply` writes when the answer carries none.
 */
export const KEY_REFUSAL_ERRORS = ["API key is invalid.", "invalid x-api-key", "HTTP 401", "HTTP 403"] as const;

/**
 * From 5 to 11 October 2026 the dead key failed 176 listening items for good, before a refusal kept
 * items new, and a failed item is never drafted again. On the first accepted call after a refusal,
 * the items the key failed that are still inside the listening window go back to new, so the new
 * key drafts them, three a run, inside the day's budget. That is also the first accepted call the
 * window records at all, which covers a key replaced before this code ran. One update, and once: the
 * accepted call then writes `anthropic_ok_at`, and the condition stays false until the next refusal.
 * When it is false Postgres checks it once and reads no item.
 */
export async function restoreRefusedItems(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  // A day as text ("2026-10-04"), never a Date: the metrics are read from the window's first day.
  const firstDay = dayKey(cutoff);
  const newest = (key: string) => sql`(select coalesce(max(m.value), 0) from ${metricsDaily} m where m.day >= ${firstDay} and m.key = ${key})`;
  const rows = await db
    .update(listenItems)
    .set({ status: "new", lastError: null, draftedAt: null })
    .where(and(eq(listenItems.status, "failed"), inArray(listenItems.lastError, [...KEY_REFUSAL_ERRORS]), gt(listenItems.postedAt, cutoff), sql`${newest("anthropic_refused_at")} >= ${newest("anthropic_ok_at")}`))
    .returning({ id: listenItems.id });
  return rows.length;
}
