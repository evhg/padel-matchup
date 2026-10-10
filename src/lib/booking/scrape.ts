import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, demandSignals, events, metricsDaily, type Club, type ClubAvailability, type ClubFreeSlot } from "@/db/schema";
import { isValidTimeZone } from "@/lib/dates";
import { LISTED_SOURCES } from "@/lib/domain/clubs";
import { bumpMetric, dayKey, setMetric } from "@/lib/domain/metrics";
import { ADAPTERS, adapterFor, type AvailabilityAdapter, type ScrapedSlot, type ScrapeFailure, type ScrapeResult, type ScrapeTarget } from "./adapters";
import { AVAILABILITY_KINDS, localDay } from "./availability";
import { cleanUrl, detectPlatform } from "./platforms";

/**
 * Free court times read from the booking platforms' public club pages, every fifteen minutes.
 *
 * The owner's decision of 10 October 2026 (DECIDING rule 32): "platforms forbid scraping in their terms
 * but we are just testing, and on top every app scrapes every other app ... So scraping at risk of being
 * blocked is acceptable, just do it." This file is the frame; a reader per platform lives in
 * `adapters/<platform>.ts` and parses nothing here. The frame holds every reader to the limits that
 * stay, because they are about other people's accounts and money, not about scraping:
 *   - a GET or a HEAD only, with no cookie and no authorization header: it never signs in and never
 *     books, reserves, pays or posts anything;
 *   - an honest User-Agent, one request a second per platform, at most eight a club, and a cache of
 *     every page for the run;
 *   - the first 401, 403 or 429 stops that platform for the run, and the platform rests for six hours,
 *     then a day, then a week. Nothing here rotates an address, fakes a browser or answers a challenge.
 *
 * The job rides the five-minute push job (`/api/cron/push`), which calls `scrapeIfDue`: it costs no
 * invocation of its own and no migration. It runs when the last run is fourteen minutes old or more.
 */
export const SCRAPE = {
  /** A run starts when the last one began this long ago or more: every third push tick, with a minute of slack for a late one. */
  dueMs: 14 * 60_000,
  /** A club read this recently waits for the next run. */
  clubDueMs: 14 * 60_000,
  maxClubs: 12,
  budgetMs: 45_000,
  /** One request a second per platform. */
  gapMs: 1_000,
  /** The most requests one club's read may make (the adapter contract says the same). */
  perClub: 8,
  /** Today and the next two days, in the club's zone. */
  days: 3,
  requestTimeoutMs: 10_000,
  maxBytes: 3_000_000,
  maxSlots: 1_000,
  /** After a "blocked": six hours, then a day, then a week for every block after that. A clean read starts again from six hours. */
  restsMs: [6 * 3600_000, 24 * 3600_000, 7 * 24 * 3600_000],
  /** How far back the rest and stop rows are read; a row older than this counts as cleared. */
  stateDays: 60,
  /** A club is "used" when a crew played there lately, a match there is coming up, or a player wants to play there. */
  usedBackMs: 28 * 24 * 3600_000,
  usedAheadMs: 14 * 24 * 3600_000,
  userAgent: "KicksmashBot/1.0 (+https://kicksma.sh/about)",
} as const;

/** Statuses that mean "stop": the platform does not want this visitor now. */
const BLOCK_STATUSES = new Set([401, 403, 429]);

const keyRest = (p: string) => `scrape_rest_until_${p}`;
const keyLevel = (p: string) => `scrape_rest_level_${p}`;
const keyStop = (p: string) => `scrape_stop_${p}`;
/** The switch with no deploy at all: `POST /api/admin/metrics {"key":"scrape_off_<platform>","value":1}` (or `scrape_off_all`); value 0 turns it back on. */
const keyOff = (p: string) => `scrape_off_${p}`;
export const scrapeCounter = (what: "ok" | "blocked" | "changed" | "requests" | "error", platform: string) => `scrape_${what}_${platform}`;
export const SCRAPE_CLUBS_FRESH = "scrape_clubs_fresh";
export const SCRAPE_RUN_AT = "cron_scrape_at";

/**
 * `SCRAPE_DISABLED`: a comma list of platform ids, or "all". Vercel gives a running deployment the
 * variables it was built with, so a change there needs a redeploy of the same code; the rows
 * `scrape_off_<platform>` and `scrape_off_all` (`keyOff`) need none.
 */
export function disabledPlatforms(raw: string | undefined = process.env.SCRAPE_DISABLED): "all" | Set<string> {
  const ids = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return ids.includes("all") ? "all" : new Set(ids);
}

/** This deployment, as a number: a "changed" stop holds until the next deploy, which has another. FNV-1a, 32 bits. Pure. */
export function deployKey(env: Record<string, string | undefined> = process.env): number {
  const id = env.VERCEL_GIT_COMMIT_SHA || env.VERCEL_DEPLOYMENT_ID || "local";
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export type PlatformState = { platform: string; off: boolean; stopped: boolean; restUntil: Date | null; level: number };
export const usable = (s: PlatformState, now: Date) => !s.off && !s.stopped && !(s.restUntil && s.restUntil > now);

/**
 * Where each platform stands: switched off, stopped for this deploy after a "changed", resting after a
 * "blocked", and how many blocks in a row. One query over `metrics_daily`, newest day first. A switch
 * row holds however old it is; the other rows count for sixty days.
 */
export async function readPlatformStates(db: Db, platforms: readonly string[], now: Date, disabled = disabledPlatforms()): Promise<PlatformState[]> {
  if (!platforms.length) return [];
  const keys = platforms.flatMap((p) => [keyRest(p), keyLevel(p), keyStop(p)]);
  const offKeys = [keyOff("all"), ...platforms.map(keyOff)];
  const rows = await db
    .select({ key: metricsDaily.key, value: metricsDaily.value })
    .from(metricsDaily)
    .where(or(and(inArray(metricsDaily.key, keys), gte(metricsDaily.day, dayKey(new Date(now.getTime() - SCRAPE.stateDays * 86_400_000)))), inArray(metricsDaily.key, offKeys)))
    .orderBy(desc(metricsDaily.day));
  const latest = new Map<string, number>();
  for (const r of rows) if (!latest.has(r.key)) latest.set(r.key, Number(r.value));
  const deploy = deployKey();
  return platforms.map((p) => {
    const until = latest.get(keyRest(p)) ?? 0;
    return {
      platform: p,
      off: disabled === "all" || disabled.has(p) || (latest.get(keyOff("all")) ?? 0) > 0 || (latest.get(keyOff(p)) ?? 0) > 0,
      stopped: latest.has(keyStop(p)) && latest.get(keyStop(p)) === deploy,
      restUntil: until > 0 ? new Date(until * 1000) : null,
      level: latest.get(keyLevel(p)) ?? 0,
    };
  });
}

/** A "blocked": rest for the next step of six hours, a day, a week. */
async function rest(db: Db, s: PlatformState, now: Date): Promise<Date> {
  const ms = SCRAPE.restsMs[Math.min(s.level, SCRAPE.restsMs.length - 1)];
  const until = new Date(now.getTime() + ms);
  await setMetric(db, keyRest(s.platform), Math.floor(until.getTime() / 1000), dayKey(now));
  await setMetric(db, keyLevel(s.platform), s.level + 1, dayKey(now));
  return until;
}

/** The club's local days a read covers, today first. Pure. */
export function scrapeDays(now: Date, tz: string, days: number = SCRAPE.days): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < days && i < days + 2; i++) {
    const d = localDay(new Date(now.getTime() + i * 86_400_000), tz);
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, n) : null;
};

/**
 * A reader's slots as the cache keeps them: the free courts counted per time, inside the days the read
 * covers and not yet over, soonest first. A booked court counts for nothing. A booking link is kept
 * only when it is https on the same platform, so a reader cannot put any other address on our pages.
 * Pure.
 */
export function freeSlotsFromScrape(slots: readonly ScrapedSlot[], o: { platform: string; tz: string; now: Date; days: readonly string[] }): ClubFreeSlot[] {
  const byTime = new Map<string, { start: string; end: string; named: Set<string>; unnamed: number; price: string | null; bookUrl: string | null }>();
  for (const s of slots.slice(0, 5_000)) {
    if (!s || s.free !== true) continue;
    const start = new Date(s.start);
    const end = new Date(s.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start || end <= o.now) continue;
    if (end.getTime() - start.getTime() > 6 * 3600_000) continue;
    if (!o.days.includes(localDay(start, o.tz))) continue;
    const key = `${start.toISOString()}|${end.toISOString()}`;
    const row = byTime.get(key) ?? { start: start.toISOString(), end: end.toISOString(), named: new Set<string>(), unnamed: 0, price: null, bookUrl: null };
    const court = clip(s.court, 40);
    if (court) row.named.add(court);
    else row.unnamed++;
    row.price ??= clip(s.priceText, 40);
    if (!row.bookUrl && s.bookUrl) {
      const url = cleanUrl(s.bookUrl);
      if (url?.startsWith("https://") && detectPlatform(url)?.id === o.platform) row.bookUrl = url;
    }
    byTime.set(key, row);
  }
  return [...byTime.values()]
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
    .slice(0, SCRAPE.maxSlots)
    .map((r) => {
      const courts = [...r.named].slice(0, 16);
      return { start: r.start, end: r.end, free: Math.min(64, r.named.size + r.unnamed), ...(courts.length ? { courts } : {}), price: r.price, bookUrl: r.bookUrl };
    });
}

/** No feed the club shared: a shared feed always wins over a read (`refreshAllAvailability` keeps those rows). */
const noFeed = () => or(isNull(clubs.availabilityUrl), isNull(clubs.availabilityKind), notInArray(clubs.availabilityKind, [...AVAILABILITY_KINDS]));

/**
 * The clubs this run reads: listed, not refused, a booking link on a platform that may be read now, no
 * feed of their own, and not read in the last fourteen minutes. Clubs that people use come first (a
 * crew's match there in the last four weeks, a match there in the next two, a player's want there),
 * then the oldest cache. One query; `clubs` is small and the two subqueries use their venue indexes.
 */
export async function dueClubs(db: Db, now: Date, platforms: readonly string[], limit: number): Promise<{ club: Club; used: boolean }[]> {
  if (!platforms.length || limit <= 0) return [];
  const back = new Date(now.getTime() - SCRAPE.usedBackMs).toISOString();
  const nowIso = now.toISOString();
  const ahead = new Date(now.getTime() + SCRAPE.usedAheadMs).toISOString();
  const used = sql<boolean>`(exists (select 1 from ${events} e where e.venue_slug = ${clubs}.slug and ((e.group_id is not null and e.starts_at >= ${back}::timestamptz and e.starts_at < ${nowIso}::timestamptz) or (e.starts_at >= ${nowIso}::timestamptz and e.starts_at < ${ahead}::timestamptz))) or exists (select 1 from ${demandSignals} d where d.venue_slug = ${clubs}.slug and d.expires_at > ${nowIso}::timestamptz))`;
  const rows = await db
    .select({ club: clubs, used })
    .from(clubs)
    .where(
      and(
        isNull(clubs.rejectedAt),
        or(isNotNull(clubs.approvedAt), inArray(clubs.source, [...LISTED_SOURCES])),
        isNotNull(clubs.bookingUrl),
        inArray(clubs.bookingPlatform, [...platforms]),
        noFeed(),
        or(isNull(clubs.availabilityAt), lt(clubs.availabilityAt, new Date(now.getTime() - SCRAPE.clubDueMs))),
      ),
    )
    .orderBy(desc(used), sql`${clubs.availabilityAt} asc nulls first`, clubs.slug)
    .limit(limit);
  return rows.map((r) => ({ club: r.club, used: Boolean(r.used) }));
}

/** Why the frame refused a reader's request. Thrown into the reader, which may catch it; the frame still knows. */
export class ScrapeStop extends Error {
  constructor(readonly why: "blocked" | "cap" | "budget" | "method" | "credentials") {
    super(`scrape stopped: ${why}`);
    this.name = "ScrapeStop";
  }
}

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
const realClock: Clock = { now: () => performance.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** One platform's lane for a run: its pace, its block, its cache and its request count. */
type Lane = { platform: string; lastAt: number; blocked: number | null; changed: boolean; outOfTime: boolean; requests: number; cache: Map<string, { status: number; body: string; type: string | null }> };

/** The only fetch a reader gets. Every limit that stays is enforced here, not trusted to the reader. */
function laneFetch(lane: Lane, o: { fetchImpl: typeof fetch; clock: Clock; deadline: number }): { fetch: typeof fetch; count: () => number } {
  let n = 0;
  const f = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = typeof input === "object" && "url" in input && !(input instanceof URL) ? input : null;
    const url = req ? req.url : String(input);
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new ScrapeStop("method");
    const given = new Headers(init?.headers ?? req?.headers);
    if (given.has("authorization") || given.has("cookie")) throw new ScrapeStop("credentials");
    if (lane.blocked !== null) throw new ScrapeStop("blocked");
    const hit = method === "GET" ? lane.cache.get(url) : undefined;
    if (hit) return new Response(hit.body, { status: hit.status, headers: hit.type ? { "content-type": hit.type } : {} });
    if (n >= SCRAPE.perClub) throw new ScrapeStop("cap");
    const wait = Math.max(0, lane.lastAt + SCRAPE.gapMs - o.clock.now());
    if (o.clock.now() + wait >= o.deadline) {
      lane.outOfTime = true;
      throw new ScrapeStop("budget");
    }
    if (wait > 0) await o.clock.sleep(wait);
    lane.lastAt = o.clock.now();
    n++;
    lane.requests++;
    const headers = new Headers(given);
    headers.set("user-agent", SCRAPE.userAgent);
    if (!headers.has("accept")) headers.set("accept", "text/html,application/json;q=0.9,*/*;q=0.8");
    const timeout = Math.max(1_000, Math.min(SCRAPE.requestTimeoutMs, o.deadline - o.clock.now()));
    const res = await o.fetchImpl(url, { method, headers, redirect: "follow", signal: AbortSignal.timeout(timeout) });
    if (BLOCK_STATUSES.has(res.status)) {
      lane.blocked = res.status;
      return res;
    }
    if (method !== "GET" || res.status !== 200) return res;
    const body = (await res.text()).slice(0, SCRAPE.maxBytes);
    const type = res.headers.get("content-type");
    lane.cache.set(url, { status: 200, body, type });
    return new Response(body, { status: 200, headers: type ? { "content-type": type } : {} });
  };
  return { fetch: f as typeof fetch, count: () => n };
}

/** A reader that never answers still ends: two seconds past the run's deadline, on the real clock. */
async function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("the reader did not answer in time"), { name: "TimeoutError" })), Math.max(1_000, ms));
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

type Outcome = { club: Club; platform: string; result: ScrapeResult };

/** One platform's clubs, one after another, until the platform blocks, changes, or the time runs out. */
async function runLane(lane: Lane, queue: { club: Club; adapter: AvailabilityAdapter }[], o: { fetchImpl: typeof fetch; clock: Clock; deadline: number; now: Date }): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const { club, adapter } of queue) {
    if (lane.blocked !== null || lane.changed || lane.outOfTime) break;
    // Not even one request fits before the deadline: leave the club due for the next run.
    if (o.clock.now() + Math.max(0, lane.lastAt + SCRAPE.gapMs - o.clock.now()) >= o.deadline) {
      lane.outOfTime = true;
      break;
    }
    const tz = club.tz && isValidTimeZone(club.tz) ? club.tz : "UTC";
    const target: ScrapeTarget = { clubSlug: club.slug, platform: lane.platform, bookingUrl: club.bookingUrl!, tz, days: SCRAPE.days };
    const lf = laneFetch(lane, o);
    let result: ScrapeResult;
    try {
      result = await bounded(adapter.scrape(target, lf.fetch, o.now), o.deadline - o.clock.now() + 2_000);
    } catch (e) {
      const why: ScrapeFailure = e instanceof ScrapeStop && e.why === "blocked" ? "blocked" : e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "error";
      result = { ok: false, status: null, reason: why, requests: lf.count(), detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
    }
    // The frame's own count, whatever the reader says, and its own view of a block.
    result = { ...result, requests: lf.count() };
    if (lane.blocked !== null) result = { ok: false, status: lane.blocked, reason: "blocked", requests: lf.count(), detail: null };
    // Cut short by the deadline: nothing is written, and the club stays due.
    if (lane.outOfTime && lane.blocked === null) break;
    out.push({ club, platform: lane.platform, result });
    if (!result.ok && result.reason === "blocked") lane.blocked ??= result.status ?? 0;
    if (!result.ok && result.reason === "changed") lane.changed = true;
  }
  return out;
}

export type PlatformRun = { requests: number; ok: number; errors: number; blocked: boolean; changed: boolean; restUntil: string | null };
export type ScrapeRun = { clubs: number; fresh: number; requests: number; outOfTime: boolean; platforms: Record<string, PlatformRun> };
export type ScrapeOptions = { adapters?: readonly AvailabilityAdapter[]; fetchImpl?: typeof fetch; clock?: Clock; budgetMs?: number; maxClubs?: number; disabled?: string };

/** What a reader's answer becomes on the club row. Pure. */
export function availabilityFrom(result: ScrapeResult, o: { platform: string; tz: string; now: Date }): ClubAvailability {
  const days = scrapeDays(o.now, o.tz);
  const base = { fetchedAt: o.now.toISOString(), day: days[0], days, tz: o.tz, source: `scrape:${o.platform}`, platform: o.platform };
  if (result.ok) return { ...base, slots: freeSlotsFromScrape(result.slots, { platform: o.platform, tz: o.tz, now: o.now, days }), error: null };
  return { ...base, slots: [], error: `${result.reason}${result.status ? ` ${result.status}` : ""}` };
}

/**
 * One run: a bounded slice of clubs, each platform in its own lane at one request a second, the
 * results written one after another (never a burst on the pool), then the rests, the stops and the
 * day's counters. Returns what it did; never throws for a reader's failure.
 */
export async function runScrape(db: Db, now = new Date(), o: ScrapeOptions = {}): Promise<ScrapeRun> {
  const adapters = o.adapters ?? ADAPTERS;
  const clock = o.clock ?? realClock;
  const deadline = clock.now() + Math.min(o.budgetMs ?? SCRAPE.budgetMs, SCRAPE.budgetMs);
  const run: ScrapeRun = { clubs: 0, fresh: 0, requests: 0, outOfTime: false, platforms: {} };
  const day = dayKey(now);
  await setMetric(db, SCRAPE_RUN_AT, Math.floor(now.getTime() / 1000), day);

  const ids = [...new Set(adapters.map((a) => a.platform))];
  const states = await readPlatformStates(db, ids, now, disabledPlatforms(o.disabled ?? process.env.SCRAPE_DISABLED));
  const open = states.filter((s) => usable(s, now));
  if (!open.length) return run;

  const maxClubs = o.maxClubs ?? SCRAPE.maxClubs;
  const due = await dueClubs(db, now, open.map((s) => s.platform), maxClubs * 2);
  const lanes = new Map<string, { lane: Lane; queue: { club: Club; adapter: AvailabilityAdapter }[] }>();
  let picked = 0;
  for (const { club } of due) {
    if (picked >= maxClubs) break;
    const adapter = adapterFor(club.bookingUrl, club.bookingPlatform, adapters);
    if (!adapter) continue;
    const entry: { lane: Lane; queue: { club: Club; adapter: AvailabilityAdapter }[] } = lanes.get(adapter.platform) ?? { lane: { platform: adapter.platform, lastAt: -Infinity, blocked: null, changed: false, outOfTime: false, requests: 0, cache: new Map() }, queue: [] };
    entry.queue.push({ club, adapter });
    lanes.set(adapter.platform, entry);
    picked++;
  }

  const fetchImpl = o.fetchImpl ?? fetch;
  const outcomes = (await Promise.all([...lanes.values()].map(({ lane, queue }) => runLane(lane, queue, { fetchImpl, clock, deadline, now })))).flat();

  for (const { club, platform, result } of outcomes) {
    const tz = club.tz && isValidTimeZone(club.tz) ? club.tz : "UTC";
    const availability = availabilityFrom(result, { platform, tz, now });
    const written = await db
      .update(clubs)
      .set({ availability, availabilityAt: now })
      .where(and(eq(clubs.slug, club.slug), noFeed()))
      .returning({ slug: clubs.slug });
    run.clubs++;
    const p = (run.platforms[platform] ??= { requests: 0, ok: 0, errors: 0, blocked: false, changed: false, restUntil: null });
    if (result.ok) {
      p.ok++;
      if (written.length) run.fresh++;
    } else if (result.reason !== "blocked" && result.reason !== "changed") p.errors++;
  }

  for (const { lane } of lanes.values()) {
    const s = states.find((x) => x.platform === lane.platform)!;
    const p = (run.platforms[lane.platform] ??= { requests: 0, ok: 0, errors: 0, blocked: false, changed: false, restUntil: null });
    p.requests = lane.requests;
    run.requests += lane.requests;
    if (lane.outOfTime) run.outOfTime = true;
    if (lane.blocked !== null) {
      p.blocked = true;
      p.restUntil = (await rest(db, s, now)).toISOString();
      await bumpMetric(db, scrapeCounter("blocked", lane.platform), 1, day);
    } else if (p.ok && s.level > 0) {
      await setMetric(db, keyLevel(lane.platform), 0, day);
    }
    if (lane.changed) {
      p.changed = true;
      await setMetric(db, keyStop(lane.platform), deployKey(), day);
      await bumpMetric(db, scrapeCounter("changed", lane.platform), 1, day);
    }
    if (p.ok) await bumpMetric(db, scrapeCounter("ok", lane.platform), p.ok, day);
    if (p.errors) await bumpMetric(db, scrapeCounter("error", lane.platform), p.errors, day);
    if (lane.requests) await bumpMetric(db, scrapeCounter("requests", lane.platform), lane.requests, day);
  }
  if (run.fresh) await bumpMetric(db, SCRAPE_CLUBS_FRESH, run.fresh, day);
  return run;
}

/**
 * Called by every push tick. Nothing at all while no reader exists or every platform is switched off;
 * one read of `metrics_daily` otherwise, and a run when the last one began fourteen minutes ago or more.
 */
export async function scrapeIfDue(db: Db, now = new Date(), o: ScrapeOptions = {}): Promise<ScrapeRun | { skipped: "no_reader" | "off" | "not_due" }> {
  if (!(o.adapters ?? ADAPTERS).length) return { skipped: "no_reader" };
  if (disabledPlatforms(o.disabled ?? process.env.SCRAPE_DISABLED) === "all") return { skipped: "off" };
  const [last] = await db
    .select({ value: metricsDaily.value })
    .from(metricsDaily)
    .where(and(eq(metricsDaily.key, SCRAPE_RUN_AT), gte(metricsDaily.day, dayKey(new Date(now.getTime() - 86_400_000)))))
    .orderBy(desc(metricsDaily.day))
    .limit(1);
  if (last && now.getTime() - Number(last.value) * 1000 < SCRAPE.dueMs) return { skipped: "not_due" };
  return runScrape(db, now, o);
}

export type PlatformLine = { platform: string; state: "fresh" | "resting" | "off" | "stopped"; fresh: number; restUntil: Date | null; requestsToday: number; blockedToday: number };

/** The service board's line per platform: fresh (clubs read clean in the last hour), resting until, stopped, or off. Two queries. */
export async function scrapeBoard(db: Db, now: Date, adapters: readonly AvailabilityAdapter[] = ADAPTERS): Promise<PlatformLine[]> {
  const ids = [...new Set(adapters.map((a) => a.platform))];
  if (!ids.length) return [];
  const states = await readPlatformStates(db, ids, now);
  const fresh = await db
    .select({ source: sql<string>`${clubs.availability}->>'source'`, n: sql<number>`count(*)` })
    .from(clubs)
    .where(and(gte(clubs.availabilityAt, new Date(now.getTime() - 3600_000)), sql`${clubs.availability}->>'source' like 'scrape:%'`, sql`${clubs.availability}->>'error' is null`))
    .groupBy(sql`${clubs.availability}->>'source'`);
  const today = await db
    .select({ key: metricsDaily.key, value: metricsDaily.value })
    .from(metricsDaily)
    .where(and(eq(metricsDaily.day, dayKey(now)), inArray(metricsDaily.key, ids.flatMap((p) => [scrapeCounter("requests", p), scrapeCounter("blocked", p)]))));
  const count = (k: string) => Number(today.find((r) => r.key === k)?.value ?? 0);
  return states.map((s) => ({
    platform: s.platform,
    state: s.off ? "off" : s.stopped ? "stopped" : s.restUntil && s.restUntil > now ? "resting" : "fresh",
    fresh: Number(fresh.find((r) => r.source === `scrape:${s.platform}`)?.n ?? 0),
    restUntil: s.restUntil && s.restUntil > now ? s.restUntil : null,
    requestsToday: count(scrapeCounter("requests", s.platform)),
    blockedToday: count(scrapeCounter("blocked", s.platform)),
  }));
}
