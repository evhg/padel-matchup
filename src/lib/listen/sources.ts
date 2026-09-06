import { parseFeed, parseHn, type Candidate } from "./parse";

/**
 * Public places where people ask about organising padel. Read-only, no
 * credentials, polite: one request per feed per run, a real user agent,
 * short timeouts. Everything returned goes through the relevance gate and
 * a model before a human sees it.
 */
export type FeedSpec = { id: string; kind: "hn" | "feed"; url: string; source: Candidate["source"] };

const UA = "Kicksmash listening bot (+https://kicksma.sh/agents; reads public feeds, never posts on its own)";

export const FEEDS: readonly FeedSpec[] = [
  { id: "hn-padel", kind: "hn", url: "https://hn.algolia.com/api/v1/search_by_date?query=padel&tags=(story,comment)&hitsPerPage=50", source: "hn" },
  { id: "reddit-padel-new", kind: "feed", url: "https://www.reddit.com/r/padel/new/.rss?limit=50", source: "reddit" },
  { id: "reddit-search-padel-app", kind: "feed", url: "https://www.reddit.com/search.rss?q=padel+app&sort=new&limit=50", source: "reddit" },
  { id: "reddit-search-padel-organise", kind: "feed", url: "https://www.reddit.com/search.rss?q=padel+organise+OR+organize+OR+americano+OR+mexicano&sort=new&limit=50", source: "reddit" },
];

export type FetchResult = { feed: FeedSpec; items: Candidate[]; error: string | null; status: number | null };

export async function fetchFeed(feed: FeedSpec, fetchImpl: typeof fetch = fetch): Promise<FetchResult> {
  try {
    const res = await fetchImpl(feed.url, { headers: { "user-agent": UA, accept: feed.kind === "hn" ? "application/json" : "application/atom+xml, application/rss+xml, application/xml;q=0.9, */*;q=0.5" }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return { feed, items: [], error: `HTTP ${res.status}`, status: res.status };
    if (feed.kind === "hn") return { feed, items: parseHn((await res.json()) as Parameters<typeof parseHn>[0]), error: null, status: res.status };
    return { feed, items: parseFeed(await res.text(), feed.source), error: null, status: res.status };
  } catch (e) {
    return { feed, items: [], error: e instanceof Error ? e.message : String(e), status: null };
  }
}

/** All feeds, one after another (a handful of requests; sequential keeps us polite). */
export async function fetchAll(feeds: readonly FeedSpec[] = FEEDS, fetchImpl: typeof fetch = fetch): Promise<FetchResult[]> {
  const out: FetchResult[] = [];
  for (const f of feeds) out.push(await fetchFeed(f, fetchImpl));
  return out;
}
