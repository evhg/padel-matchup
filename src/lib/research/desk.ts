import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { researchCache, researchFinds, researchRuns, type ResearchFind, type ResearchRun } from "@/db/schema";
import { bumpMetric, dayKey } from "@/lib/domain/metrics";
import type { Candidate } from "@/lib/listen/parse";
import { rememberCandidates, WINDOW_MS } from "@/lib/listen/tick";
import { allowance, canSpendByHand, readMeter, type Meter } from "./budget";
import { dueQueries, intervalHours, type Query } from "./queries";
import { extractCredits, hostOf, sameUrl, searchCredits, tavilyEnabled, tavilyExtract, tavilySearch, type Depth, type Hit, type TimeRange } from "./tavily";

/**
 * The research desk, hourly: spend this hour's share of the month's credits on
 * the most overdue queries. Listening hits join the listening desk (source
 * "web", same gate, same drafts, same tap). Find hits become places; clubs and
 * coaches get their public contacts read from the page once. Hand searches are
 * cached for a week. Every credit is counted in `tavily_calls`.
 */
export type ResearchSummary = { enabled: boolean; meter: Meter | null; allowance: number; searches: number; credits: number; newItems: number; newFinds: number; extracted: number; errors: string[]; budgetHit: boolean };

/** The hourly function has sixty seconds for everything; the desk takes at most this much of it and leaves the rest to the steps after it. */
export const RESEARCH = { budgetMs: 20_000, failuresBeforeStop: 2 } as const;
const WEEK_MS = WINDOW_MS;
const SOCIAL = /(^|\.)(instagram|facebook|tiktok|youtube|twitter|x)\.com$|(^|\.)t\.me$/i;
const SHOPS = /(^|\.)(pinterest|amazon|aliexpress|ebay|shopee|lazada)\./i;

/** A search hit becomes a listening candidate: same pipeline as the feeds. */
export function hitToCandidate(h: Hit, now: Date): Candidate {
  const dated = h.publishedAt && h.publishedAt.getTime() <= now.getTime() + 60_000 && now.getTime() - h.publishedAt.getTime() < WEEK_MS;
  return { source: "web", externalId: h.url, url: h.url, title: h.title, body: h.content, author: hostOf(h.url) || null, postedAt: dated ? h.publishedAt! : now, threadId: null };
}

export const findEmails = (text: string): string[] =>
  [...new Set((text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map((e) => e.toLowerCase()))].filter((e) => !/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e) && !/example\.|sentry|wixpress|schema\.org|w3\.org|noreply|no-reply/.test(e)).slice(0, 5);
export const findInstagram = (text: string): string | null => {
  for (const m of text.matchAll(/instagram\.com\/([a-z0-9_.]{2,30})\/?/gi)) {
    const h = m[1].replace(/\.$/, "");
    if (!/^(p|reel|reels|explore|stories|accounts|share)$/i.test(h)) return h;
  }
  return null;
};
export const findPhone = (text: string): string | null => text.match(/\+(?:66|65|60|62|84|63)[\s\d-]{7,14}\d/)?.[0]?.replace(/\s+/g, " ").trim() ?? null;

async function upsertFind(db: Db, q: Query, h: Hit, now: Date): Promise<boolean> {
  const domain = hostOf(h.url);
  if (!domain || SHOPS.test(domain)) return false;
  const rows = await db
    .insert(researchFinds)
    .values({ kind: q.find ?? "other", city: q.city ?? null, url: h.url, domain, title: h.title, snippet: h.content.slice(0, 600), queryKey: q.key, score: h.score, firstSeenAt: now, lastSeenAt: now })
    .onConflictDoUpdate({ target: researchFinds.url, set: { seen: sql`${researchFinds.seen} + 1`, lastSeenAt: now, score: h.score } })
    .returning({ seen: researchFinds.seen });
  return rows[0]?.seen === 1;
}

/**
 * A failed search costs the query one hour, not a day: its row is set so it is
 * due again at the next tick, behind everything that is more overdue, with the
 * error noted and no run counted. A never-run query gets that row too, so it
 * leaves the front of the queue instead of failing first every hour.
 */
async function recordFailure(db: Db, q: Query, now: Date, error: string, run?: Pick<ResearchRun, "emptyStreak"> | null): Promise<void> {
  const penalisedAt = new Date(now.getTime() - (intervalHours(q, run) - 1) * 3_600_000);
  await db
    .insert(researchRuns)
    .values({ key: q.key, lastRunAt: penalisedAt, runs: 0, credits: 0, results: 0, newItems: 0, emptyStreak: 0, lastError: error })
    .onConflictDoUpdate({ target: researchRuns.key, set: { lastRunAt: penalisedAt, lastError: error } });
}

async function recordRun(db: Db, q: Query, now: Date, r: { credits: number; results: number; newItems: number; error: string | null }): Promise<void> {
  await db
    .insert(researchRuns)
    .values({ key: q.key, lastRunAt: now, runs: 1, credits: r.credits, results: r.results, newItems: r.newItems, emptyStreak: r.newItems ? 0 : 1, lastError: r.error })
    .onConflictDoUpdate({
      target: researchRuns.key,
      set: {
        lastRunAt: now,
        runs: sql`${researchRuns.runs} + 1`,
        credits: sql`${researchRuns.credits} + ${r.credits}`,
        results: sql`${researchRuns.results} + ${r.results}`,
        newItems: sql`${researchRuns.newItems} + ${r.newItems}`,
        emptyStreak: r.newItems ? 0 : sql`${researchRuns.emptyStreak} + 1`,
        lastError: r.error,
      },
    });
}

/** Public contacts for the newest clubs and coaches, ten pages for two credits. */
async function extractContacts(db: Db, now: Date, room: number, fetchImpl: typeof fetch, timeoutMs = 30_000): Promise<{ extracted: number; credits: number; error: string | null }> {
  const pending = await db
    .select()
    .from(researchFinds)
    .where(and(isNull(researchFinds.extractedAt), inArray(researchFinds.kind, ["club", "coach"])))
    .orderBy(desc(researchFinds.firstSeenAt))
    .limit(10);
  let extracted = 0;
  for (const f of pending.filter((x) => SOCIAL.test(x.domain))) {
    await db.update(researchFinds).set({ extractedAt: now, instagram: findInstagram(f.url) }).where(eq(researchFinds.id, f.id));
    extracted++;
  }
  const pages = pending.filter((x) => !SOCIAL.test(x.domain));
  if (pages.length === 0 || room < extractCredits(pages.length)) return { extracted, credits: 0, error: null };
  const ex = await tavilyExtract(pages.map((p) => p.url), "basic", fetchImpl, timeoutMs);
  if (!ex.ok) return { extracted, credits: 0, error: ex.error };
  for (const f of pages) {
    const text = ex.pages.find((p) => sameUrl(p.url, f.url))?.content ?? "";
    await db.update(researchFinds).set({ extractedAt: now, emails: findEmails(text), instagram: findInstagram(text) ?? findInstagram(f.url), phone: findPhone(text) }).where(eq(researchFinds.id, f.id));
    extracted++;
  }
  return { extracted, credits: ex.credits, error: null };
}

/** The hourly step. Idempotent; spends at most this hour's allowance. */
export async function researchTick(db: Db, now = new Date(), fetchImpl: typeof fetch = fetch, o: { queries?: readonly Query[]; budgetMs?: number } = {}): Promise<ResearchSummary> {
  const out: ResearchSummary = { enabled: tavilyEnabled(), meter: null, allowance: 0, searches: 0, credits: 0, newItems: 0, newFinds: 0, extracted: 0, errors: [], budgetHit: false };
  if (!out.enabled) return out;
  const started = Date.now();
  const budgetMs = o.budgetMs ?? RESEARCH.budgetMs;
  const overBudget = () => Date.now() - started >= budgetMs;
  const remaining = () => Math.max(0, budgetMs - (Date.now() - started));
  const day = dayKey(now);
  const meter = await readMeter(db, now, fetchImpl);
  out.meter = meter;
  let room = allowance(meter.used, now, meter.limit);
  out.allowance = room;
  const spend = async (credits: number) => {
    room -= credits;
    out.credits += credits;
    if (credits) await bumpMetric(db, "tavily_calls", credits, day);
  };
  // Contacts for places found last time come first: two credits at most, and a find is worth little without them.
  const contacts = overBudget() ? { extracted: 0, credits: 0, error: null } : await extractContacts(db, now, room, fetchImpl, remaining());
  if (overBudget() && !contacts.extracted && !contacts.credits) out.budgetHit = true;
  out.extracted = contacts.extracted;
  if (contacts.credits) await spend(contacts.credits);
  if (contacts.error) out.errors.push(`extract: ${contacts.error}`);
  const runs = await db.select().from(researchRuns);
  let failures = 0;
  for (const q of dueQueries(now, runs, o.queries)) {
    if (room < searchCredits("basic")) break;
    if (overBudget()) {
      out.budgetHit = true;
      break;
    }
    const res = await tavilySearch(q.q, { depth: "basic", maxResults: 10, timeRange: q.timeRange, country: q.country, timeoutMs: remaining() }, fetchImpl);
    if (!res.ok) {
      // One bad answer costs an hour, not a day. Two in a row and Tavily is having a bad hour: stop.
      out.errors.push(`${q.key}: ${res.error}`);
      await recordFailure(db, q, now, res.error, runs.find((r) => r.key === q.key));
      if (++failures >= RESEARCH.failuresBeforeStop) break;
      continue;
    }
    failures = 0;
    await spend(res.credits);
    out.searches++;
    let fresh = 0;
    if (q.kind === "listen") {
      fresh = await rememberCandidates(db, res.hits.map((h) => hitToCandidate(h, now)), now);
      out.newItems += fresh;
    } else {
      for (const h of res.hits) if (await upsertFind(db, q, h, now)) fresh++;
      out.newFinds += fresh;
    }
    await recordRun(db, q, now, { credits: res.credits, results: res.hits.length, newItems: fresh, error: null });
  }
  if (out.searches) await bumpMetric(db, "research_searches", out.searches, day);
  if (out.newItems) await bumpMetric(db, "research_items", out.newItems, day);
  if (out.newFinds) await bumpMetric(db, "research_finds", out.newFinds, day);
  return out;
}

export type HandSearch = { hits: Hit[]; credits: number; cached: boolean };

/** A search by hand (answer grounding, outreach facts): cached a week, counted, refused past the hard stop. */
export async function groundedSearch(db: Db, q: string, o: { timeRange?: TimeRange; maxResults?: number; depth?: Depth } = {}, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<HandSearch | { error: string }> {
  const query = q.trim().slice(0, 300);
  if (!query) return { error: "empty query" };
  const hash = createHash("sha256").update(JSON.stringify({ q: query.toLowerCase(), t: o.timeRange ?? null, n: o.maxResults ?? 8, d: o.depth ?? "basic" })).digest("hex");
  const [hit] = await db.select().from(researchCache).where(eq(researchCache.hash, hash)).limit(1);
  if (hit && now.getTime() - hit.createdAt.getTime() < WEEK_MS) {
    const hits = (hit.payload as (Omit<Hit, "publishedAt"> & { publishedAt: string | null })[]).map((h) => ({ ...h, publishedAt: h.publishedAt ? new Date(h.publishedAt) : null }));
    return { hits, credits: 0, cached: true };
  }
  const meter = await readMeter(db, now, fetchImpl);
  const cost = searchCredits(o.depth ?? "basic");
  if (!canSpendByHand(meter.used, cost, meter.limit)) return { error: `budget: ${meter.used} of ${meter.limit} credits used this month` };
  const res = await tavilySearch(query, { depth: o.depth ?? "basic", maxResults: o.maxResults ?? 8, timeRange: o.timeRange }, fetchImpl);
  if (!res.ok) return { error: res.error };
  await bumpMetric(db, "tavily_calls", res.credits, dayKey(now));
  await db
    .insert(researchCache)
    .values({ hash, query, kind: "search", payload: res.hits, credits: res.credits, createdAt: now })
    .onConflictDoUpdate({ target: researchCache.hash, set: { payload: res.hits, credits: res.credits, createdAt: now } });
  return { hits: res.hits, credits: res.credits, cached: false };
}

export async function listRuns(db: Db): Promise<ResearchRun[]> {
  return db.select().from(researchRuns).orderBy(desc(researchRuns.lastRunAt));
}

export async function listFinds(db: Db, o: { status?: string; kind?: string; city?: string; limit?: number } = {}): Promise<ResearchFind[]> {
  const where = [o.status && o.status !== "all" ? eq(researchFinds.status, o.status) : undefined, o.kind ? eq(researchFinds.kind, o.kind) : undefined, o.city ? eq(researchFinds.city, o.city) : undefined].filter(Boolean);
  const base = db.select().from(researchFinds);
  const rows = where.length ? base.where(and(...(where as [ReturnType<typeof eq>]))) : base;
  return rows.orderBy(desc(researchFinds.firstSeenAt)).limit(Math.min(500, o.limit ?? 100));
}

export async function setFindStatus(db: Db, id: string, status: "new" | "used" | "dismissed", note: string | null): Promise<ResearchFind | null> {
  const [row] = await db.update(researchFinds).set({ status, note }).where(eq(researchFinds.id, id)).returning();
  return row ?? null;
}
