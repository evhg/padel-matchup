import { shortHost } from "@/lib/config";

/**
 * Tavily, the one web-search key we hold. Every call costs credits from a monthly
 * allowance, so each function reports what it cost and never retries on its own.
 * Basic search 1, advanced 2; extract 1 per five pages (2 advanced); usage free.
 */
export const tavilyEnabled = () => Boolean(process.env.TAVILY_API_KEY);
const API = "https://api.tavily.com";

export type Depth = "basic" | "advanced";
export type TimeRange = "day" | "week" | "month" | "year";
export type SearchOpts = { depth?: Depth; maxResults?: number; timeRange?: TimeRange; topic?: "general" | "news"; includeDomains?: string[]; excludeDomains?: string[]; country?: string };
export type Hit = { title: string; url: string; content: string; score: number; publishedAt: Date | null };
export type SearchOutcome = { ok: true; hits: Hit[]; credits: number } | { ok: false; error: string; status: number | null; credits: 0 };
export type ExtractOutcome = { ok: true; pages: { url: string; content: string }[]; failed: string[]; credits: number } | { ok: false; error: string; credits: 0 };
export type Usage = { used: number; limit: number; plan: string | null };

export const searchCredits = (depth: Depth = "basic") => (depth === "advanced" ? 2 : 1);
export const extractCredits = (pages: number, depth: Depth = "basic") => (pages <= 0 ? 0 : Math.ceil(pages / 5) * (depth === "advanced" ? 2 : 1));

export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};
/** Same page, ignoring scheme, "www." and a trailing slash. */
export const sameUrl = (a: string, b: string) => a.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase() === b.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase();

const headers = () => ({ "content-type": "application/json", authorization: `Bearer ${process.env.TAVILY_API_KEY}` });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function tavilySearch(query: string, o: SearchOpts = {}, fetchImpl: typeof fetch = fetch): Promise<SearchOutcome> {
  if (!tavilyEnabled()) return { ok: false, error: "no key", status: null, credits: 0 };
  const depth = o.depth ?? "basic";
  const body = {
    query,
    search_depth: depth,
    topic: o.topic ?? "general",
    max_results: Math.min(20, Math.max(1, o.maxResults ?? 10)),
    include_answer: false,
    include_raw_content: false,
    ...(o.timeRange ? { time_range: o.timeRange } : {}),
    ...(o.includeDomains?.length ? { include_domains: o.includeDomains } : {}),
    ...(o.excludeDomains?.length ? { exclude_domains: o.excludeDomains } : {}),
    ...(o.country ? { country: o.country } : {}),
  };
  try {
    const res = await fetchImpl(`${API}/search`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const json = (await res.json().catch(() => null)) as { results?: { title?: string; url?: string; content?: string; score?: number; published_date?: string }[]; detail?: { error?: string }; error?: string } | null;
    if (!res.ok) return { ok: false, error: json?.detail?.error ?? json?.error ?? `HTTP ${res.status}`, status: res.status, credits: 0 };
    const own = shortHost();
    const seen = new Set<string>();
    const hits: Hit[] = [];
    for (const r of json?.results ?? []) {
      const url = (r.url ?? "").trim();
      if (!url || !/^https?:\/\//i.test(url) || seen.has(url) || hostOf(url) === own) continue;
      seen.add(url);
      const when = r.published_date ? new Date(r.published_date) : null;
      hits.push({ title: (r.title ?? "").trim().slice(0, 300) || url, url, content: (r.content ?? "").trim().slice(0, 1500), score: typeof r.score === "number" ? r.score : 0, publishedAt: when && !Number.isNaN(when.getTime()) ? when : null });
    }
    return { ok: true, hits, credits: searchCredits(depth) };
  } catch (e) {
    return { ok: false, error: message(e), status: null, credits: 0 };
  }
}

export async function tavilyExtract(urls: string[], depth: Depth = "basic", fetchImpl: typeof fetch = fetch): Promise<ExtractOutcome> {
  if (!tavilyEnabled()) return { ok: false, error: "no key", credits: 0 };
  const list = [...new Set(urls)].slice(0, 20);
  if (list.length === 0) return { ok: true, pages: [], failed: [], credits: 0 };
  try {
    const res = await fetchImpl(`${API}/extract`, { method: "POST", headers: headers(), body: JSON.stringify({ urls: list, extract_depth: depth }), signal: AbortSignal.timeout(30_000) });
    const json = (await res.json().catch(() => null)) as { results?: { url: string; raw_content?: string }[]; failed_results?: { url: string }[]; detail?: { error?: string } } | null;
    if (!res.ok) return { ok: false, error: json?.detail?.error ?? `HTTP ${res.status}`, credits: 0 };
    return { ok: true, pages: (json?.results ?? []).map((p) => ({ url: p.url, content: (p.raw_content ?? "").slice(0, 20_000) })), failed: (json?.failed_results ?? []).map((f) => f.url), credits: extractCredits(list.length, depth) };
  } catch (e) {
    return { ok: false, error: message(e), credits: 0 };
  }
}

/** Tavily's own meter for the plan; costs nothing to read. */
export async function tavilyUsage(fetchImpl: typeof fetch = fetch): Promise<Usage | null> {
  if (!tavilyEnabled()) return null;
  try {
    const res = await fetchImpl(`${API}/usage`, { headers: { authorization: `Bearer ${process.env.TAVILY_API_KEY}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { key?: { usage?: number; limit?: number | null }; account?: { current_plan?: string; plan_usage?: number; plan_limit?: number } };
    const used = j.account?.plan_usage ?? j.key?.usage;
    const limit = j.account?.plan_limit ?? j.key?.limit;
    if (typeof used !== "number" || typeof limit !== "number" || limit <= 0) return null;
    return { used, limit, plan: j.account?.current_plan ?? null };
  } catch {
    return null;
  }
}
