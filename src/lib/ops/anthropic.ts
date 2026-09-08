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
