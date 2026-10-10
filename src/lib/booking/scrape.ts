import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, demandSignals, events, metricsDaily, type Club, type ClubAvailability, type ClubFreeSlot } from "@/db/schema";
import { isValidTimeZone, zonedTimeToUtc } from "@/lib/dates";
import { LISTED_SOURCES } from "@/lib/domain/clubs";
import { bumpMetric, dayKey, setMetric } from "@/lib/domain/metrics";
import { ADAPTERS, adapterFor, type AvailabilityAdapter, type ScrapedSlot, type ScrapeFailure, type ScrapeResult, type ScrapeTarget } from "./adapters";
import { AVAILABILITY_KINDS, localDay } from "./availability";
import { platformById } from "./platforms";

/**
 * Free court times read from the booking platforms' public club pages, every fifteen minutes.
 *
 * The owner's decision of 10 October 2026 (DECIDING rule 35): "platforms forbid scraping in their terms
 * but we are just testing, and on top every app scrapes every other app ... So scraping at risk of being
 * blocked is acceptable, just do it." This file is the frame; a reader per platform lives in
 * `adapters/<platform>.ts` and parses nothing here. The frame holds every reader to the limits that
 * stay, because they are about other people's accounts and money, not about scraping:
 *   - a GET or a HEAD only, with no cookie and no authorization header: it never signs in and never
 *     books, reserves, pays or posts anything;
 *   - an honest User-Agent, one request a second per platform, at most eight a club, and a cache of
 *     every page for the run;
 *   - the first 401, 403 or 429, or a challenge (`isBlock`), stops that platform for the run, and the
 *     platform rests for six hours, then a day, then a week. Nothing here rotates an address, fakes a
 *     browser or answers a challenge;
 *   - the club's zone as the row has it: a reader that cannot know the zone says so, never guesses.
 *
 * robots.txt does not bind a reader under rule 35 (the owner accepted the risk of a block); the frame
 * keeps the load low instead: each platform's own slice of at most eight clubs a run, today every 15
 * minutes for a club people use, the next two days at most hourly. `/about#bot` says who we are.
 *
 * The job rides the five-minute push job (`/api/cron/push`), which calls `scrapeIfDue`: it costs no
 * invocation of its own and no migration. It runs when the last run is fourteen minutes old or more.
 */
export const SCRAPE = {
  /** A run starts when the last one began this long ago or more: every third push tick, with a minute of slack for a late one. */
  dueMs: 14 * 60_000,
  /** A club people use (`usedBackMs`, `usedAheadMs`) is read again after this long: every run. */
  usedDueMs: 14 * 60_000,
  /** Any other club is read again after this long: once an hour. */
  clubDueMs: 60 * 60_000,
  /** The clubs one platform's lane takes in a run. Each lane has its own 45 seconds, so one platform never crowds out another. */
  perLane: 8,
  budgetMs: 45_000,
  /** One request a second per platform. */
  gapMs: 1_000,
  /** The most requests one club's read may make (the adapter contract says the same). */
  perClub: 8,
  /** Today and the next two days, in the club's zone. */
  days: 3,
  /**
   * The next two days are read at most this often. In between, a club read every run (one people use)
   * has today alone read, and keeps the later days of its last full read: half the requests (the
   * decision of 10 October 2026 on this reader's review, to lower the load on a platform).
   */
  fullDueMs: 60 * 60_000,
  requestTimeoutMs: 10_000,
  /** No request starts with less than this left before the deadline: it would run past it. */
  minRequestMs: 1_000,
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

/**
 * A response that is a challenge, not a page: AWS WAF answers a Challenge with 202 and a CAPTCHA with
 * 405, both with `x-amzn-waf-action`, and Cloudflare marks its own with `cf-mitigated`. Playtomic runs
 * behind CloudFront. Each is a block: the platform rests, and nothing here answers a challenge.
 */
export function isBlock(method: string, res: Pick<Response, "status" | "headers">): boolean {
  if (BLOCK_STATUSES.has(res.status)) return true;
  if (res.headers.has("x-amzn-waf-action") || res.headers.has("cf-mitigated")) return true;
  return method === "GET" && (res.status === 202 || res.status === 405);
}

/** A response rebuilt from the run's cache keeps the address it ended on, so a reader can tell a redirect to a sign-in page. */
function withUrl(res: Response, url: string): Response {
  if (url) Object.defineProperty(res, "url", { value: url });
  return res;
}

const keyRest = (p: string) => `scrape_rest_until_${p}`;
const keyLevel = (p: string) => `scrape_rest_level_${p}`;
const keyStop = (p: string) => `scrape_stop_${p}`;
/** The switch with no deploy at all: `POST /api/admin/metrics {"key":"scrape_off_<platform>","value":1}` (or `scrape_off_all`); value 0 turns it back on. */
const keyOff = (p: string) => `scrape_off_${p}`;
export const scrapeCounter = (what: "ok" | "blocked" | "changed" | "requests" | "error" | "cut", platform: string) => `scrape_${what}_${platform}`;
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

/** This deployment's code, as a number: a "changed" stop holds until a deploy of a new commit, which has another (a redeploy of the same commit keeps it). FNV-1a, 32 bits. Pure. */
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

/** A zone we know, or null: never "UTC" in place of one nobody gave. */
const zoneOf = (tz: string | null | undefined): string | null => (tz && isValidTimeZone(tz) ? tz : null);

const nextDay = (day: string) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + 1)).toISOString().slice(0, 10);

/**
 * A reader's slots as the cache keeps them. A platform lists one free start for each length it offers
 * (Playtomic: 60, 90 and 120 minutes, a new start every 30), so one free hour of one court comes as
 * several rows that overlap. The cache keeps, for each court, the union of its free time; cuts that on
 * the platform's grid (wherever a court becomes free or busy, which on Playtomic and MATCHi is the half
 * hour) and at each of the club's midnights; and counts the courts free for the whole of each piece.
 * Neighbours with the same count on the same day merge. So the rows never overlap, every start is
 * unique, and `free x length` adds up to the true court-hours (DECIDING rule 35; the decision of 10
 * October 2026 on the review of this reader).
 *
 * Only `{ start, end, free }` is kept: a link, a price or a court name for each row was most of the
 * bytes on a row every list reads, and nothing shows them (AGENTS.md rule 12). A booked court counts for
 * nothing. Time past the last day the read covers is cut off, so the cache never claims a day it did not
 * read. Pure.
 */
export function freeSlotsFromScrape(slots: readonly ScrapedSlot[], o: { tz: string; now: Date; days: readonly string[] }): ClubFreeSlot[] {
  if (!o.days.length || !isValidTimeZone(o.tz)) return [];
  // The club's midnights: the start of each day read, and the end of the last.
  const cuts = [...o.days, nextDay(o.days[o.days.length - 1])].map((d) => zonedTimeToUtc(d, "00:00", o.tz).getTime());
  const from = cuts[0];
  const until = cuts[cuts.length - 1];
  const byCourt = new Map<string, [number, number][]>();
  let unnamed = 0;
  for (const s of slots.slice(0, 5_000)) {
    if (!s || s.free !== true) continue;
    const a = Date.parse(s.start);
    const b = Date.parse(s.end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || b - a > 6 * 3600_000 || b <= o.now.getTime()) continue;
    const lo = Math.max(a, from);
    const hi = Math.min(b, until);
    if (hi <= lo) continue;
    // The platform's id for the court, else its name. A court with neither counts as a court of its own: two such rows at one time are two courts.
    const id = clip(s.courtId, 80);
    const key = id ? `id:${id}` : (clip(s.court, 80) ?? `\u0000${unnamed++}`);
    const list = byCourt.get(key) ?? [];
    list.push([lo, hi]);
    byCourt.set(key, list);
  }
  // A sweep over the edges of each court's union: +1 where a court becomes free, -1 where it stops.
  const delta = new Map<number, number>(cuts.map((c) => [c, 0]));
  const add = (t: number, d: number) => delta.set(t, (delta.get(t) ?? 0) + d);
  for (const list of byCourt.values()) {
    list.sort((x, y) => x[0] - y[0]);
    let [lo, hi] = list[0];
    for (const [a, b] of list.slice(1)) {
      if (a <= hi) hi = Math.max(hi, b);
      else {
        add(lo, 1);
        add(hi, -1);
        [lo, hi] = [a, b];
      }
    }
    add(lo, 1);
    add(hi, -1);
  }
  const midnight = new Set(cuts);
  const times = [...delta.keys()].sort((x, y) => x - y);
  const out: ClubFreeSlot[] = [];
  let free = 0;
  for (let i = 0; i < times.length - 1 && out.length < SCRAPE.maxSlots; i++) {
    free += delta.get(times[i])!;
    if (free <= 0) continue;
    const n = Math.min(64, free);
    const last = out[out.length - 1];
    if (last && last.free === n && Date.parse(last.end) === times[i] && !midnight.has(times[i])) last.end = new Date(times[i + 1]).toISOString();
    else out.push({ start: new Date(times[i]).toISOString(), end: new Date(times[i + 1]).toISOString(), free: n });
  }
  return out;
}

/** No feed the club shared: a shared feed always wins over a read (`refreshAllAvailability` keeps those rows). */
const noFeed = () => or(isNull(clubs.availabilityUrl), isNull(clubs.availabilityKind), notInArray(clubs.availabilityKind, [...AVAILABILITY_KINDS]));

/** What a run needs of a club, and nothing more: never the cache itself, which is the one large column (AGENTS.md rule 12). */
export type DueClub = Pick<Club, "slug" | "bookingUrl" | "bookingPlatform" | "website" | "tz" | "availabilityAt"> & {
  used: boolean;
  /** The last cache without its slots or `why`: where it came from, whether it read clean, the days it covers. */
  prev: Omit<ClubAvailability, "slots" | "why"> | null;
};

/**
 * The link a reader reads: the booking link, else the website. The directory lists a club with the
 * platform's page as its website and no booking link (`scripts/import-clubs.mjs`), and those are most
 * of the clubs on a platform (the decision of 10 October 2026 on this reader's review).
 */
export const readLink = (c: Pick<Club, "bookingUrl" | "website">): string | null => c.bookingUrl ?? c.website;

/** A link on one of the platform's hosts, as a Postgres regular expression. Null for a platform we cannot name. */
function hostPattern(platform: string): string | null {
  const hosts = platformById(platform)?.hosts;
  if (!hosts?.length) return null;
  return `^https?://([^/?#]*\\.)?(${hosts.map((h) => h.replace(/\./g, "\\.")).join("|")})([/?#:]|$)`;
}

/**
 * The clubs one platform's lane reads in this run: listed, not refused, no feed of their own, and a link
 * on that platform: the booking link, or, with none, the website. A club people use (a crew's match there
 * in the last four weeks, a match there in the next two, a player's want there) is due after 14 minutes,
 * any other after an hour; the oldest cache goes first. One query a platform, bounded; `clubs` is small
 * and the two subqueries use their venue indexes. It selects six columns and the cache's header, never
 * the slots.
 */
export async function dueClubs(db: Db, now: Date, platform: string, limit: number): Promise<DueClub[]> {
  if (limit <= 0) return [];
  const back = new Date(now.getTime() - SCRAPE.usedBackMs).toISOString();
  const nowIso = now.toISOString();
  const ahead = new Date(now.getTime() + SCRAPE.usedAheadMs).toISOString();
  const used = sql<boolean>`(exists (select 1 from ${events} e where e.venue_slug = ${clubs}.slug and ((e.group_id is not null and e.starts_at >= ${back}::timestamptz and e.starts_at < ${nowIso}::timestamptz) or (e.starts_at >= ${nowIso}::timestamptz and e.starts_at < ${ahead}::timestamptz))) or exists (select 1 from ${demandSignals} d where d.venue_slug = ${clubs}.slug and d.expires_at > ${nowIso}::timestamptz))`;
  const host = hostPattern(platform);
  const onPlatform = or(
    and(isNotNull(clubs.bookingUrl), or(eq(clubs.bookingPlatform, platform), host ? and(isNull(clubs.bookingPlatform), sql`${clubs.bookingUrl} ~* ${host}`) : undefined)),
    host ? and(isNull(clubs.bookingUrl), sql`${clubs.website} ~* ${host}`) : undefined,
  );
  const rows = await db
    .select({
      slug: clubs.slug,
      bookingUrl: clubs.bookingUrl,
      bookingPlatform: clubs.bookingPlatform,
      website: clubs.website,
      tz: clubs.tz,
      availabilityAt: clubs.availabilityAt,
      used,
      prev: sql<Omit<ClubAvailability, "slots" | "why"> | null>`(${clubs.availability} - 'slots' - 'why')`.mapWith(clubs.availability),
    })
    .from(clubs)
    .where(
      and(
        isNull(clubs.rejectedAt),
        or(isNotNull(clubs.approvedAt), inArray(clubs.source, [...LISTED_SOURCES])),
        onPlatform,
        noFeed(),
        or(isNull(clubs.availabilityAt), lt(clubs.availabilityAt, new Date(now.getTime() - SCRAPE.clubDueMs)), and(used, lt(clubs.availabilityAt, new Date(now.getTime() - SCRAPE.usedDueMs)))),
      ),
    )
    .orderBy(sql`${clubs.availabilityAt} asc nulls first`, clubs.slug)
    .limit(limit);
  return rows.map((r) => ({ ...r, used: Boolean(r.used), prev: (r.prev as Omit<ClubAvailability, "slots" | "why"> | null) ?? null }));
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

/**
 * One platform's lane for a run: its pace, its block, its cache and its request count. `changedAt` holds
 * the clubs that said "changed" in this run: one club alone is that club's error, and the platform stops
 * only at a second club, or at a club that read clean before.
 */
type Lane = { platform: string; lastAt: number; blocked: number | null; changed: boolean; changedAt: Set<string>; outOfTime: boolean; cut: number; requests: number; cache: Map<string, { status: number; body: string; type: string | null; url: string }> };

/** Does one more request fit before the deadline, after the platform's second between requests? */
const fits = (lane: Lane, o: { clock: Clock; deadline: number }) => o.clock.now() + Math.max(0, lane.lastAt + SCRAPE.gapMs - o.clock.now()) + SCRAPE.minRequestMs <= o.deadline;

/** What the frame itself did to one club's read: a stop it threw, and whether its own timer aborted a request. */
type LaneFetch = { fetch: typeof fetch; count: () => number; stop: () => ScrapeStop["why"] | null; timedOut: () => boolean };

/** The only fetch a reader gets. Every limit that stays is enforced here, not trusted to the reader. */
function laneFetch(lane: Lane, o: { fetchImpl: typeof fetch; clock: Clock; deadline: number }): LaneFetch {
  let n = 0;
  let stopped: ScrapeStop["why"] | null = null;
  let timedOut = false;
  const stop = (why: ScrapeStop["why"]) => {
    stopped = why;
    if (why === "budget") lane.outOfTime = true;
    return new ScrapeStop(why);
  };
  const f = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = typeof input === "object" && "url" in input && !(input instanceof URL) ? input : null;
    const url = req ? req.url : String(input);
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw stop("method");
    const given = new Headers(init?.headers ?? req?.headers);
    if (given.has("authorization") || given.has("cookie")) throw stop("credentials");
    if (lane.blocked !== null) throw stop("blocked");
    const hit = method === "GET" ? lane.cache.get(url) : undefined;
    if (hit) return withUrl(new Response(hit.body, { status: hit.status, headers: hit.type ? { "content-type": hit.type } : {} }), hit.url);
    if (n >= SCRAPE.perClub) throw stop("cap");
    if (!fits(lane, o)) throw stop("budget");
    const wait = Math.max(0, lane.lastAt + SCRAPE.gapMs - o.clock.now());
    if (wait > 0) await o.clock.sleep(wait);
    // The run's clock is performance.now(), which carries a fraction, and AbortSignal.timeout throws on
    // anything but a whole number of milliseconds: before 10 October 2026 that threw for every request
    // that started in a lane's last ten seconds, and the club was written as a bare "error".
    const left = Math.floor(o.deadline - o.clock.now());
    if (left < SCRAPE.minRequestMs) throw stop("budget");
    lane.lastAt = o.clock.now();
    n++;
    lane.requests++;
    const headers = new Headers(given);
    headers.set("user-agent", SCRAPE.userAgent);
    if (!headers.has("accept")) headers.set("accept", "text/html,application/json;q=0.9,*/*;q=0.8");
    const timeout = Math.min(SCRAPE.requestTimeoutMs, left);
    const signal = AbortSignal.timeout(timeout);
    let res: Response;
    let body: string | null = null;
    // The signal aborts the body download too, so the body is read inside the same catch: a page whose
    // headers came in time and whose body did not is the same cut as one that never answered.
    try {
      res = await o.fetchImpl(url, { method, headers, redirect: "follow", signal });
      if (!isBlock(method, res) && method === "GET" && res.status === 200) body = (await res.text()).slice(0, SCRAPE.maxBytes);
    } catch (e) {
      if (signal.aborted) {
        timedOut = true;
        // Cut by the run's deadline, not by the platform's ten seconds: the club stays due, unwritten.
        if (timeout < SCRAPE.requestTimeoutMs) lane.outOfTime = true;
      }
      throw e;
    }
    if (isBlock(method, res)) {
      lane.blocked = res.status;
      return res;
    }
    if (body === null) return res;
    const type = res.headers.get("content-type");
    // Where a redirect ended: a reader reads `url` to tell a sign-in page or a "no such club" index from the page it asked for.
    const final = res.url || url;
    lane.cache.set(url, { status: 200, body, type, url: final });
    return withUrl(new Response(body, { status: 200, headers: type ? { "content-type": type } : {} }), final);
  };
  return { fetch: f as typeof fetch, count: () => n, stop: () => stopped, timedOut: () => timedOut };
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

/** A club a lane will read, the reader for it, and the link it reads. */
type Picked = { club: DueClub; adapter: AvailabilityAdapter; link: string };
type Outcome = { club: DueClub; platform: string; result: ScrapeResult; todayOnly: boolean };

/**
 * Is a read of today alone enough for this club? Only when its last read covered all three days, read
 * clean on this platform less than `fullDueMs` ago, and still covers the next two days in the zone it was
 * read in (a midnight since then means a day it never read). Pure.
 */
export function todayOnlyRead(prev: DueClub["prev"], platform: string, now: Date): boolean {
  if (!prev || prev.error !== null || prev.source !== `scrape:${platform}` || !prev.fullAt || !Array.isArray(prev.days)) return false;
  const full = Date.parse(prev.fullAt);
  if (!Number.isFinite(full) || full > now.getTime() || now.getTime() - full >= SCRAPE.fullDueMs) return false;
  const zone = zoneOf(prev.tz);
  return Boolean(zone) && scrapeDays(now, zone!).slice(1).every((d) => prev.days!.includes(d));
}

/** One platform's clubs, one after another, until the platform blocks, changes, or the time runs out. */
async function runLane(lane: Lane, queue: readonly Picked[], o: { fetchImpl: typeof fetch; clock: Clock; deadline: number; now: Date; full: boolean }): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const { club, adapter, link } of queue) {
    if (lane.blocked !== null || lane.changed || lane.outOfTime) break;
    // Not even one request fits before the deadline: leave the club due for the next run.
    if (!fits(lane, o)) {
      lane.outOfTime = true;
      break;
    }
    // The club's zone as the row has it: never "UTC" in place of a zone nobody gave (readers F2).
    const todayOnly = todayOnlyRead(club.prev, lane.platform, o.now);
    const target: ScrapeTarget = { clubSlug: club.slug, platform: lane.platform, bookingUrl: link, tz: club.tz, days: todayOnly ? 1 : SCRAPE.days };
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
    // A reader may catch what the frame threw and call it an error; the frame knows what it was.
    if (!result.ok && result.reason === "error") {
      const stop = lf.stop();
      if (lf.timedOut()) result = { ...result, reason: "timeout" };
      else if (stop) result = { ...result, detail: `frame: ${stop}` };
    }
    if (lane.blocked !== null) result = { ok: false, status: lane.blocked, reason: "blocked", requests: lf.count(), detail: null };
    // Cut short by the deadline, and counted (`scrape_cut_<platform>`). A cut club is not written and
    // stays due, so the next run starts with it and its last good read keeps showing. One exception: the
    // lane's first club in a run that had the whole budget (45 s) did not fit even then, and a later run
    // would do the same, so no club behind it would ever be read. Only then is it written as a timeout,
    // which sends it to the back. A busy push tick passes less than the whole budget, and a first club
    // cut in such a run keeps its cache: a full run reads it.
    if (lane.outOfTime && lane.blocked === null) {
      lane.cut++;
      if (out.length > 0 || !o.full) break;
      result = { ok: false, status: null, reason: "timeout", requests: lf.count(), detail: "frame: budget" };
      out.push({ club, platform: lane.platform, result, todayOnly });
      break;
    }
    out.push({ club, platform: lane.platform, result, todayOnly });
    if (!result.ok && result.reason === "blocked") lane.blocked ??= result.status ?? 0;
    if (!result.ok && result.reason === "changed") {
      // One stale or mistyped link is that club's error. The platform stops when a second club in the
      // run says the same, or when this club read clean last time: then it is the page, not the link.
      const readClean = club.prev !== null && club.prev.error === null && club.prev.source === `scrape:${lane.platform}`;
      lane.changedAt.add(club.slug);
      if (readClean || lane.changedAt.size >= 2) lane.changed = true;
    }
  }
  return out;
}

export type PlatformRun = { requests: number; ok: number; errors: number; blocked: boolean; changed: boolean; restUntil: string | null };
/** A club this run wrote as failed: its slug, the error the cache shows, and the short cause (`failureWhy`). */
export type FailedClub = { slug: string; platform: string; error: string; why: string | null };
/**
 * `writeErrors`: club rows the database refused; the run goes on, and the push job reports the count.
 * `failed`: every club written as failed, at most a lane's eight a platform. The push job answers with
 * the run, and pg_net keeps that answer for about six hours (`net._http_response`), which is longer
 * than Vercel keeps a log; that is where a failure's cause is read afterwards.
 */
export type ScrapeRun = { clubs: number; fresh: number; requests: number; outOfTime: boolean; writeErrors: number; platforms: Record<string, PlatformRun>; failed: FailedClub[] };
export type ScrapeOptions = { adapters?: readonly AvailabilityAdapter[]; fetchImpl?: typeof fetch; clock?: Clock; budgetMs?: number; perLane?: number; disabled?: string };

/**
 * The cache of a read that gave nothing to show: no slots and the reason. Its zone is the club's when it
 * has one; with none, the error row is dated in UTC, which no reader uses, because an error shows no time.
 */
function failedCache(platform: string, now: Date, error: string, tz: string | null = null): ClubAvailability {
  return { ...availabilityFrom({ ok: false, status: null, reason: "error", requests: 0, detail: null }, { platform, tz: tz ?? "UTC", now }), error };
}

/**
 * A clean read of today alone, as the part of the cache it replaces: today's pieces, the three days the
 * cache still covers, and the time of the last full read. `keepFrom` is the club's next midnight: the
 * row keeps its own pieces from there on (`writeToday` in `runScrape`). Pure.
 */
export function todayCache(result: Extract<ScrapeResult, { ok: true }>, o: { platform: string; tz: string; now: Date; fullAt: string }): { availability: ClubAvailability; keepFrom: string } {
  const days = scrapeDays(o.now, o.tz);
  const slots = freeSlotsFromScrape(result.slots, { tz: o.tz, now: o.now, days: days.slice(0, 1) });
  const availability: ClubAvailability = { fetchedAt: o.now.toISOString(), day: days[0], days, tz: o.tz, source: `scrape:${o.platform}`, platform: o.platform, slots, error: null, fullAt: o.fullAt };
  return { availability, keepFrom: zonedTimeToUtc(days[1], "00:00", o.tz).toISOString() };
}

/** The steps a reader names in its `detail` before the colon ("club page: HTTP 500"); `failureWhy` keeps no other. */
const WHY_STEP = /^(club page|availability \d{4}-\d{2}-\d{2}|locations|frame)$/;
/**
 * An error's class ("TypeError"): a capital, then letters. A word of a message is not one: Playtomic's
 * "club page: no answer in 10 s" once kept "no".
 */
const WHY_CLASS = /^[A-Z][A-Za-z]{0,39}$/;
/** After the step "frame", only the frame's own stops (`ScrapeStop`). */
const WHY_FRAME = /^(blocked|cap|budget|method|credentials)$/;
/** The network's code on an error's cause, as undici gives it ("ECONNRESET", "UND_ERR_CONNECT_TIMEOUT"). */
const WHY_CODE = /^[A-Z_]{1,30}$/;

/**
 * A failure's cause in a few words that are safe to keep, built only from parts of a known shape: one of
 * the readers' fixed steps (`WHY_STEP`), then either an HTTP status ("HTTP 500") or an error's class with,
 * at most, the network's code ("TypeError ECONNRESET"); after "frame", only one of the frame's own stops
 * ("frame: budget"). Everything after those parts is dropped, and a
 * detail that does not start with them gives null. So no link, path, query string, body, address or
 * token reaches the cache, whatever a message held. Pure.
 */
export function failureWhy(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const colon = detail.indexOf(": ");
  if (colon < 0) return null;
  const step = detail.slice(0, colon);
  if (!WHY_STEP.test(step)) return null;
  const [first, second] = detail.slice(colon + 2).split(" ");
  if (step === "frame") return WHY_FRAME.test(first) ? `frame: ${first}` : null;
  if (first === "HTTP") return /^[1-5]\d\d$/.test(second ?? "") ? `${step}: HTTP ${second}` : null;
  if (!WHY_CLASS.test(first)) return null;
  return second !== undefined && WHY_CODE.test(second) ? `${step}: ${first} ${second}` : `${step}: ${first}`;
}

/** What a reader's answer becomes on the club row. `tz` is a zone we know. Pure. */
export function availabilityFrom(result: ScrapeResult, o: { platform: string; tz: string; now: Date }): ClubAvailability {
  const days = scrapeDays(o.now, o.tz);
  const base = { fetchedAt: o.now.toISOString(), day: days[0], days, tz: o.tz, source: `scrape:${o.platform}`, platform: o.platform };
  if (result.ok) return { ...base, slots: freeSlotsFromScrape(result.slots, { tz: o.tz, now: o.now, days }), error: null, fullAt: base.fetchedAt };
  // `error` stays the reason and the status, which the pages and the counters read; `why` is for us.
  const why = failureWhy(result.detail);
  return { ...base, slots: [], error: `${result.reason}${result.status ? ` ${result.status}` : ""}`, ...(why ? { why } : {}) };
}

/**
 * One run: for each platform that may be read now, its own slice of due clubs (`dueClubs`, at most
 * `perLane`), read in its own lane at one request a second; all lanes at once, each inside the same 45
 * seconds. Then the rests, the stops and the day's counters, and only then the club rows, one after
 * another (never a burst on the pool), so a row the database refuses cannot lose a block. A club whose
 * link no reader can read is written as an error with no request, so it moves to the back of the queue.
 * Returns what it did; never throws for a reader's failure or a club row's.
 */
export async function runScrape(db: Db, now = new Date(), o: ScrapeOptions = {}): Promise<ScrapeRun> {
  const adapters = o.adapters ?? ADAPTERS;
  const clock = o.clock ?? realClock;
  const budget = Math.min(o.budgetMs ?? SCRAPE.budgetMs, SCRAPE.budgetMs);
  const deadline = clock.now() + budget;
  const run: ScrapeRun = { clubs: 0, fresh: 0, requests: 0, outOfTime: false, writeErrors: 0, platforms: {}, failed: [] };
  const day = dayKey(now);
  await setMetric(db, SCRAPE_RUN_AT, Math.floor(now.getTime() / 1000), day);

  const ids = [...new Set(adapters.map((a) => a.platform))];
  const states = await readPlatformStates(db, ids, now, disabledPlatforms(o.disabled ?? process.env.SCRAPE_DISABLED));
  const open = states.filter((s) => usable(s, now));
  if (!open.length) return run;

  // One bounded query a platform, one after another (rule 8).
  const perLane = o.perLane ?? SCRAPE.perLane;
  const lanes: { lane: Lane; queue: Picked[] }[] = [];
  const unreadable: { club: DueClub; platform: string }[] = [];
  for (const s of open) {
    const mine = adapters.filter((a) => a.platform === s.platform);
    const queue: Picked[] = [];
    for (const club of await dueClubs(db, now, s.platform, perLane)) {
      const link = readLink(club);
      // The platform the row names goes with its booking link; a website is read by whichever reader takes it.
      const adapter = adapterFor(link, club.bookingUrl ? club.bookingPlatform : null, mine);
      if (link && adapter) queue.push({ club, adapter, link });
      else unreadable.push({ club, platform: s.platform });
    }
    if (queue.length) lanes.push({ lane: { platform: s.platform, lastAt: -Infinity, blocked: null, changed: false, changedAt: new Set(), outOfTime: false, cut: 0, requests: 0, cache: new Map() }, queue });
  }

  const fetchImpl = o.fetchImpl ?? fetch;
  const outcomes = (await Promise.all(lanes.map(({ lane, queue }) => runLane(lane, queue, { fetchImpl, clock, deadline, now, full: budget >= SCRAPE.budgetMs })))).flat();

  const tally = (platform: string) => (run.platforms[platform] ??= { requests: 0, ok: 0, errors: 0, blocked: false, changed: false, restUntil: null });
  for (const { platform, result } of outcomes) {
    const p = tally(platform);
    if (result.ok) p.ok++;
    else if (result.reason !== "blocked" && result.reason !== "changed") p.errors++;
  }
  for (const { platform } of unreadable) tally(platform).errors++;

  for (const { lane } of lanes) {
    const s = states.find((x) => x.platform === lane.platform)!;
    const p = tally(lane.platform);
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
    }
    // Every club that said "changed", whether or not the platform stopped for it.
    if (lane.changedAt.size) await bumpMetric(db, scrapeCounter("changed", lane.platform), lane.changedAt.size, day);
    if (p.ok) await bumpMetric(db, scrapeCounter("ok", lane.platform), p.ok, day);
    if (lane.requests) await bumpMetric(db, scrapeCounter("requests", lane.platform), lane.requests, day);
    if (lane.cut) await bumpMetric(db, scrapeCounter("cut", lane.platform), lane.cut, day);
  }
  for (const [platform, p] of Object.entries(run.platforms)) if (p.errors) await bumpMetric(db, scrapeCounter("error", platform), p.errors, day);

  // The club rows last. A feed the club shared since the pick still wins (`noFeed`).
  const write = async (slug: string, availability: ClubAvailability | SQL): Promise<boolean> => {
    run.clubs++;
    try {
      const written = await db.update(clubs).set({ availability, availabilityAt: now }).where(and(eq(clubs.slug, slug), noFeed())).returning({ slug: clubs.slug });
      return written.length > 0;
    } catch {
      run.writeErrors++;
      return false;
    }
  };
  /**
   * A read of today alone: today's pieces from this read, and the later days' pieces from the cache
   * already on the row, joined in the database so no old slot travels (AGENTS.md rule 12). Today's
   * pieces end at the club's midnight and the kept ones start there, so they never overlap.
   */
  const writeToday = (slug: string, t: { availability: ClubAvailability; keepFrom: string }) =>
    write(
      slug,
      sql`jsonb_set(${JSON.stringify(t.availability)}::jsonb, '{slots}', ${JSON.stringify(t.availability.slots)}::jsonb || coalesce((select jsonb_agg(s order by s->>'start') from jsonb_array_elements(case when jsonb_typeof(${clubs.availability}->'slots') = 'array' then ${clubs.availability}->'slots' else '[]'::jsonb end) s where s->>'start' >= ${t.keepFrom}), '[]'::jsonb))`,
    );
  for (const { club, platform, result, todayOnly } of outcomes) {
    // The zone the reader read the days in, else the club's own; a clean read in no known zone is an error.
    const zone = result.ok && result.tz && isValidTimeZone(result.tz) ? result.tz : zoneOf(club.tz);
    if (result.ok && zone && todayOnly && club.prev?.fullAt) {
      if (await writeToday(club.slug, todayCache(result, { platform, tz: zone, now, fullAt: club.prev.fullAt }))) run.fresh++;
      continue;
    }
    const availability = !zone && result.ok ? failedCache(platform, now, "no time zone") : availabilityFrom(result, { platform, tz: zone ?? "UTC", now });
    const written = await write(club.slug, availability);
    if (written && result.ok && zone) run.fresh++;
    if (written && availability.error) run.failed.push({ slug: club.slug, platform, error: availability.error, why: availability.why ?? null });
  }
  for (const { club, platform } of unreadable) {
    const availability = failedCache(platform, now, "unreadable link", zoneOf(club.tz));
    if (await write(club.slug, availability)) run.failed.push({ slug: club.slug, platform, error: availability.error!, why: null });
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
