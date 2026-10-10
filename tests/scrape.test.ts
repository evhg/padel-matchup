import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, metricsDaily, type Club } from "@/db/schema";
import { adapterFor, type AvailabilityAdapter, type ScrapedSlot, type ScrapeResult, type ScrapeTarget } from "@/lib/booking/adapters";
import { createMatchiAdapter, matchiAdapter } from "@/lib/booking/adapters/matchi";
import { playtomicAdapter, resetPlaytomicState } from "@/lib/booking/adapters/playtomic";
import { createBookandgoAdapter } from "@/lib/booking/adapters/bookandgo";
import { clubToPublic } from "@/lib/api/serialize";
import { freeCourtsCardShown, freeCourtsState } from "@/lib/booking/availability";
import { freeCourtHours, listClubsForPicking, listLiveClubs, listShownClubs } from "@/lib/domain/clubs";
import { createEvent } from "@/lib/domain/events";
import { setMetric } from "@/lib/domain/metrics";
import { SCRAPE, disabledPlatforms, dueClubs, failureWhy, freeSlotsFromScrape, readPlatformStates, runScrape, scrapeBoard, scrapeIfDue, type Clock } from "@/lib/booking/scrape";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * The fifteen-minute read of free court times (DECIDING rule 35), on a reader that exists only here.
 *
 * NOW is Saturday 10 October 2026, 03:00 UTC — 10:00 in Bangkok (UTC+7). Every time below comes off
 * NOW (rule 11):
 *   05:00 UTC = 12:00 Bangkok today        (kept)
 *   NOW + 1 day, 05:00 UTC = tomorrow noon   (kept: the read covers three days)
 *   NOW + 2 days                             (kept)
 *   NOW + 3 days                             (dropped: outside the three days)
 *   02:00 UTC = 09:00 Bangkok, already over  (dropped)
 * The run's own clock is a fake one: `sleep` moves it, and each request costs 200 ms of it, so the
 * pace and the time budget are tested without waiting.
 */
const NOW = new Date("2026-10-10T03:00:00.000Z");
freezeClock(NOW);
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const iso = (ms: number) => at(ms).toISOString();

type Call = { url: string; at: number; headers: Headers; method: string };

/** What the stubbed network answers: JSON (`body`) or HTML (`text`), extra headers, and the URL a redirect ended on. */
type Answer = { status: number; body?: unknown; text?: string; headers?: Record<string, string>; url?: string };

/** A fake clock for the run, and a stubbed network that answers by URL. */
function world(answer: (url: string) => Answer = () => ({ status: 200, body: { slots: [] } }), costMs = 200, start = 0) {
  let t = start;
  const calls: Call[] = [];
  const clock: Clock = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, at: t, headers: new Headers(init?.headers), method: init?.method ?? "GET" });
    t += costMs;
    const a = answer(url);
    const res = new Response(a.text ?? (a.body === undefined ? "" : JSON.stringify(a.body)), { status: a.status, headers: { "content-type": a.text ? "text/html" : "application/json", ...a.headers } });
    if (a.url) Object.defineProperty(res, "url", { value: a.url });
    return res;
  }) as typeof fetch;
  return { clock, fetchImpl, calls, advance: (ms: number) => (t += ms), time: () => t };
}

/** The test's reader: GETs the booking link and takes the JSON as it is. Parses nothing a real page would have. */
const reader = (platform = "playtomic", o: { method?: string; cookie?: boolean; requests?: number | ((slug: string) => number); onRead?: (slug: string) => Promise<void>; seen?: ScrapeTarget[] } = {}): AvailabilityAdapter => ({
  platform,
  matches: (url) => url.includes(`${platform}.`),
  async scrape(target, fetchImpl): Promise<ScrapeResult> {
    o.seen?.push(target);
    await o.onRead?.(target.clubSlug);
    let res: Response | null = null;
    const requests = typeof o.requests === "function" ? o.requests(target.clubSlug) : (o.requests ?? 1);
    for (let i = 0; i < requests; i++) {
      res = await fetchImpl(i ? `${target.bookingUrl}?day=${i}` : target.bookingUrl, { method: o.method ?? "GET", headers: o.cookie ? { cookie: "session=abc" } : {} });
    }
    if (!res) return { ok: false, status: null, reason: "error", requests: 0, detail: null };
    if (res.status === 403 || res.status === 429 || res.status === 401) return { ok: false, status: res.status, reason: "blocked", requests: 1, detail: null };
    if (res.status === 404) return { ok: false, status: 404, reason: "not_found", requests: 1, detail: null };
    const json = (await res.json()) as { slots?: ScrapedSlot[]; changed?: boolean; tz?: string };
    if (json.changed) return { ok: false, status: 200, reason: "changed", requests: 1, detail: "no slot table" };
    // A reader that found the club's zone on the page says so; with none, the frame uses the club's.
    return { ok: true, slots: json.slots ?? [], requests: 1, ...(json.tz ? { tz: json.tz } : {}) };
  },
});

let db: Db;
beforeEach(async () => {
  ({ db } = await createTestDb());
  delete process.env.SCRAPE_DISABLED;
  delete process.env.VERCEL_GIT_COMMIT_SHA;
});

let n = 0;
async function club(slug: string, o: Partial<typeof clubs.$inferInsert> = {}): Promise<Club> {
  const [row] = await db
    .insert(clubs)
    .values({ slug, name: slug.replace(/-/g, " "), manageToken: `tok-${slug}-${n++}-abcdefghijklmnop`, source: "directory", tz: "Asia/Bangkok", bookingUrl: `https://playtomic.io/${slug}`, bookingPlatform: "playtomic", ...o })
    .returning();
  return row;
}
const row = async (slug: string) => (await db.select().from(clubs).where(eq(clubs.slug, slug)))[0];
const metric = async (key: string) => Number((await db.select().from(metricsDaily).where(and(eq(metricsDaily.key, key), eq(metricsDaily.day, "2026-10-10"))))[0]?.value ?? 0);

describe("the slice: which clubs a run reads", () => {
  it("reads the oldest cache first, at most N a platform, one request a second", async () => {
    const org = await makePlayer(db, "Org");
    await club("old-cache", { availabilityAt: at(-2 * HOUR) });
    await club("never-read");
    await club("used-club", { availabilityAt: at(-20 * 60_000) }); // used, so due after 14 minutes
    await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(2 * DAY), tz: "Asia/Bangkok", venueName: "used club", whenFull: "waitlist" });
    await club("quiet-club", { availabilityAt: at(-30 * 60_000) }); // nobody uses it: due after an hour
    await club("read-just-now", { availabilityAt: at(-5 * 60_000) }); // not due
    await club("own-feed", { availabilityUrl: "https://own-feed.example/b.ics", availabilityKind: "ics_bookings" }); // its feed wins
    await club("refused", { rejectedAt: at(-DAY) });
    await club("pending-claim", { source: "claim" }); // a claim nobody approved yet is not listed
    await club("no-reader", { bookingUrl: "https://matchi.se/x", bookingPlatform: "matchi" });

    const w = world();
    const run = await runScrape(db, NOW, { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock, perLane: 2 });
    expect(w.calls.map((c) => c.url)).toEqual(["https://playtomic.io/never-read", "https://playtomic.io/old-cache"]);
    expect(run.clubs).toBe(2);
    // One request a second for the platform, and an honest name on each.
    expect(w.calls[1].at - w.calls[0].at).toBeGreaterThanOrEqual(SCRAPE.gapMs);
    expect(w.calls[0].headers.get("user-agent")).toBe("KicksmashBot/1.0 (+https://kicksma.sh/about)");

    // The rest at the default cap; the clubs just read wait, and the quiet club waits its hour.
    const w2 = world();
    await runScrape(db, at(60_000), { adapters: [reader()], fetchImpl: w2.fetchImpl, clock: w2.clock });
    expect(w2.calls.map((c) => c.url)).toEqual(["https://playtomic.io/used-club"]);
  });

  it("reads a used club every 15 minutes and any other club once an hour, whatever the order", async () => {
    const org = await makePlayer(db, "Org");
    await club("busy-club");
    await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(DAY), tz: "Asia/Bangkok", venueName: "busy club", whenFull: "waitlist" });
    await club("quiet-club");
    const urls = async (t: number) => {
      const w = world();
      await runScrape(db, at(t), { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
      return w.calls.map((c) => new URL(c.url).pathname).sort();
    };
    expect(await urls(0)).toEqual(["/busy-club", "/quiet-club"]);
    expect(await urls(15 * 60_000)).toEqual(["/busy-club"]);
    expect(await urls(30 * 60_000)).toEqual(["/busy-club"]);
    expect(await urls(61 * 60_000)).toEqual(["/busy-club", "/quiet-club"]);
  });

  it("a quiet club read in full is read in full again at its next due run, never today alone", async () => {
    // Nobody uses this club, so it is due once an hour, and its next read must cover all three days:
    // its cache and its full read are the same instant. The ticks drift a second earlier each time, as
    // real ones do. Run k is at k × 15 minutes − k seconds:
    //   k = 0   0:00:00   full read
    //   k = 4   0:59:56   not an hour since 0:00:00: not due
    //   k = 5   1:14:55   due, and a full read (an hour since the full read)
    //   k = 10  2:29:50   due, and a full read
    await club("quiet-club");
    const seen: ScrapeTarget[] = [];
    const readAt: number[] = [];
    for (let k = 0; k <= 10; k++) {
      const t = k * 15 * 60_000 - k * 1_000;
      const w = world();
      await runScrape(db, at(t), { adapters: [reader("playtomic", { seen })], fetchImpl: w.fetchImpl, clock: w.clock });
      if (w.calls.length) readAt.push(k);
    }
    expect(readAt).toEqual([0, 5, 10]);
    expect(seen.map((s) => s.days)).toEqual([SCRAPE.days, SCRAPE.days, SCRAPE.days]);
  });

  it("gives each platform its own slice, so one platform's clubs never crowd out another's", async () => {
    for (let i = 0; i < 10; i++) await club(`pt-${i}`, { availabilityAt: at(-DAY + i * 60_000) });
    await club("mt-a", { bookingUrl: "https://matchi.se/mt-a", bookingPlatform: "matchi" });
    await club("mt-b", { bookingUrl: "https://matchi.se/mt-b", bookingPlatform: "matchi", availabilityAt: at(-HOUR * 3) });
    const w = world(undefined, 10);
    const run = await runScrape(db, NOW, { adapters: [reader(), reader("matchi")], fetchImpl: w.fetchImpl, clock: w.clock });
    const hosts = w.calls.map((c) => new URL(c.url).hostname);
    expect(hosts.filter((h) => h === "playtomic.io")).toHaveLength(SCRAPE.perLane);
    expect(hosts.filter((h) => h === "matchi.se")).toHaveLength(2);
    expect(run.platforms.matchi.ok).toBe(2);
  });

  it("writes a link no reader can read as an error, with no request, so it moves to the back", async () => {
    // The club says Playtomic, but its link is the app's home page: no reader can read it.
    await club("app-link", { bookingUrl: "https://playtomic.com/", bookingPlatform: "playtomic" });
    await club("next-one", { availabilityAt: at(-30 * HOUR) });
    const strict = { ...reader(), matches: (url: string) => /^https:\/\/playtomic\.io\/[a-z-]+$/.test(url) };
    const w = world();
    await runScrape(db, NOW, { adapters: [strict], fetchImpl: w.fetchImpl, clock: w.clock, perLane: 1 });
    expect(w.calls).toEqual([]);
    const bad = await row("app-link");
    expect(bad.availability).toMatchObject({ error: "unreadable link", source: "scrape:playtomic", slots: [] });
    expect(bad.availabilityAt?.toISOString()).toBe(NOW.toISOString());
    // An hour on, the club that waited longest goes first; the unreadable one waits its turn behind it.
    const w2 = world();
    await runScrape(db, at(61 * 60_000), { adapters: [strict], fetchImpl: w2.fetchImpl, clock: w2.clock, perLane: 1 });
    expect(w2.calls.map((c) => c.url)).toEqual(["https://playtomic.io/next-one"]);
  });

  it("names a link no reader can read among the run's failed clubs", async () => {
    await club("app-link", { bookingUrl: "https://playtomic.com/", bookingPlatform: "playtomic" });
    const strict = { ...reader(), matches: (url: string) => /^https:\/\/playtomic\.io\/[a-z-]+$/.test(url) };
    const w = world();
    const run = await runScrape(db, NOW, { adapters: [strict], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(w.calls).toEqual([]);
    expect(run.failed).toEqual([{ slug: "app-link", platform: "playtomic", error: "unreadable link", why: null }]);
  });

  it("reads the directory's clubs as the import writes them: the booking link on the platform", async () => {
    // The import's own statement: `source = 'directory'`, and the booking link and platform the file
    // names (migration 0097 wrote the same to production's rows). Blue Tree books on MATCHi and has no website.
    await db.execute(sql.raw(execFileSync("node", [path.resolve("scripts/import-clubs.mjs"), "--sql"], { encoding: "utf8" })));
    const listed = await db.select({ slug: clubs.slug, website: clubs.website, bookingUrl: clubs.bookingUrl, bookingPlatform: clubs.bookingPlatform, source: clubs.source }).from(clubs).where(eq(clubs.slug, "blue-tree"));
    expect(listed).toEqual([{ slug: "blue-tree", website: null, bookingUrl: "https://www.matchi.se/facilities/bluetree", bookingPlatform: "matchi", source: "directory" }]);
    const real = (r: AvailabilityAdapter, matches: (url: string) => boolean): AvailabilityAdapter => ({ ...r, matches });
    const w = world(undefined, 10);
    const run = await runScrape(db, NOW, { adapters: [real(reader(), playtomicAdapter.matches), real(reader("matchi"), matchiAdapter.matches)], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(w.calls.filter((c) => c.url.startsWith("https://playtomic.com/clubs/"))).toHaveLength(SCRAPE.perLane);
    expect(w.calls.filter((c) => c.url === "https://www.matchi.se/facilities/bluetree")).toHaveLength(1);
    expect(run.platforms.playtomic.ok).toBe(SCRAPE.perLane);
    expect((await row("blue-tree")).availability?.source).toBe("scrape:matchi");
    // A club whose website is its own site is never read.
    expect(w.calls.every((c) => /playtomic\.com|matchi\.se/.test(c.url))).toBe(true);
  });

  it("records a block before it writes the clubs, and a club it cannot write does not end the run", async () => {
    await club("first");
    await club("second", { availabilityAt: at(-HOUR * 2) });
    // The pool times out on every club write; the metrics rows still go through.
    const failing = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "update")
          return () => {
            throw new Error("pool timeout");
          };
        return Reflect.get(target, key, receiver);
      },
    });
    const w = world(() => ({ status: 403 }));
    const run = await runScrape(failing, NOW, { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(run.platforms.playtomic.blocked).toBe(true);
    const [state] = await readPlatformStates(db, ["playtomic"], NOW);
    expect(state.restUntil?.toISOString()).toBe(iso(6 * HOUR));
    expect(await metric("scrape_blocked_playtomic")).toBe(1);
  });

  it("stops before the time budget and leaves the unread clubs due", async () => {
    for (const s of ["a-club", "b-club", "c-club", "d-club", "e-club"]) await club(s);
    const w = world(undefined, 10_000); // each request takes ten seconds
    const started: string[] = [];
    const run = await runScrape(db, NOW, { adapters: [reader("playtomic", { onRead: async (s) => void started.push(s) })], fetchImpl: w.fetchImpl, clock: w.clock, budgetMs: 25_000 });
    expect(run.outOfTime).toBe(true);
    expect(started).toHaveLength(3); // no read starts once not one request fits
    expect(w.time()).toBeLessThan(25_000 + SCRAPE.requestTimeoutMs);
    expect(w.calls.length).toBe(3);
    const read = (await db.select().from(clubs)).filter((c) => c.availabilityAt).map((c) => c.slug);
    expect(read.sort()).toEqual(["a-club", "b-club", "c-club"]);
  });

  // A club after the lane's first: the first one (`a-quick`, one request) is read, then the deadline
  // cuts `slow-pages` (five requests) after two. A lone first club is the next test's case.
  const slowAfterQuick = { requests: (slug: string) => (slug === "slow-pages" ? 5 : 1) };

  it("a club whose read the deadline cuts short is not written, and stays due", async () => {
    await club("a-quick");
    await club("slow-pages");
    const w = world(undefined, 10_000);
    const run = await runScrape(db, NOW, { adapters: [reader("playtomic", slowAfterQuick)], fetchImpl: w.fetchImpl, clock: w.clock, budgetMs: 25_000 });
    expect(w.calls.length).toBe(3);
    expect(run.outOfTime).toBe(true);
    expect(run.clubs).toBe(1);
    expect(run.failed).toEqual([]);
    expect((await row("slow-pages")).availabilityAt).toBeNull();
  });

  it("a lane's first club that the deadline cuts is written as a timeout, so it never starves the clubs behind it", async () => {
    // slow-head has the oldest cache and needs five requests at 4 s each; 15 s of budget fits four. It
    // had the run's whole budget and did not fit: a later run would only do the same, and fast-a,
    // fast-b and fast-c behind it would never be read.
    await club("slow-head", { availabilityAt: at(-3 * HOUR) });
    for (const s of ["fast-a", "fast-b", "fast-c"]) await club(s, { availabilityAt: at(-2 * HOUR) });
    const r = reader("playtomic", { requests: (slug) => (slug === "slow-head" ? 5 : 1) });
    const w = world(undefined, 4_000);
    const first = await runScrape(db, NOW, { adapters: [r], fetchImpl: w.fetchImpl, clock: w.clock, budgetMs: 15_000 });
    expect(w.calls.map((c) => c.url.replace(/\?.*/, ""))).toEqual(Array(4).fill("https://playtomic.io/slow-head"));
    expect(first.outOfTime).toBe(true);
    expect((await row("slow-head")).availability).toMatchObject({ error: "timeout", why: "frame: budget", slots: [] });
    expect(first.failed).toEqual([{ slug: "slow-head", platform: "playtomic", error: "timeout", why: "frame: budget" }]);
    expect(await metric("scrape_cut_playtomic")).toBe(1);

    // Fifteen minutes on, slow-head is at the back and not yet due again: the three behind it are read.
    const w2 = world(undefined, 4_000);
    const next = await runScrape(db, at(15 * 60_000), { adapters: [r], fetchImpl: w2.fetchImpl, clock: w2.clock, budgetMs: 15_000 });
    expect(w2.calls.map((c) => c.url)).toEqual(["https://playtomic.io/fast-a", "https://playtomic.io/fast-b", "https://playtomic.io/fast-c"]);
    expect(next.platforms.playtomic).toMatchObject({ ok: 3, errors: 0 });
    for (const s of ["fast-a", "fast-b", "fast-c"]) expect((await row(s)).availabilityAt?.toISOString()).toBe(iso(15 * 60_000));
  });

  it("counts each club the deadline cuts short, whether it stays due or is the lane's first and is written", async () => {
    await club("a-quick");
    await club("slow-pages");
    // First run: a-quick is read, slow-pages is cut after it and stays due. Second run: a-quick is not
    // due yet, so slow-pages is the lane's first club, is cut again, and is written as a timeout.
    for (const t of [0, 15 * 60_000]) {
      const w = world(undefined, 10_000);
      await runScrape(db, at(t), { adapters: [reader("playtomic", slowAfterQuick)], fetchImpl: w.fetchImpl, clock: w.clock, budgetMs: 25_000 });
      if (t === 0) expect((await row("slow-pages")).availabilityAt).toBeNull();
    }
    expect((await row("slow-pages")).availability).toMatchObject({ error: "timeout", why: "frame: budget" });
    expect(await metric("scrape_cut_playtomic")).toBe(2);
    // A club that never started is not cut: it only waits for the next run.
    await db.update(clubs).set({ bookingUrl: null, bookingPlatform: null }).where(inArray(clubs.slug, ["a-quick", "slow-pages"]));
    for (const s of ["a-club", "b-club", "c-club", "d-club"]) await club(s);
    const w = world(undefined, 10_000);
    const run = await runScrape(db, at(30 * 60_000), { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock, budgetMs: 25_000 });
    expect(run.outOfTime).toBe(true);
    expect(w.calls).toHaveLength(3);
    expect(await metric("scrape_cut_playtomic")).toBe(2);
  });

  it("caps one club's read at eight requests, and refuses anything but a GET without a cookie", async () => {
    await club("greedy");
    const w = world();
    await runScrape(db, NOW, { adapters: [reader("playtomic", { requests: 12 })], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(w.calls.length).toBe(SCRAPE.perClub);

    await club("poster");
    const w2 = world();
    const posted = await runScrape(db, at(20 * 60_000), { adapters: [reader("playtomic", { method: "POST" })], fetchImpl: w2.fetchImpl, clock: w2.clock });
    expect(w2.calls).toEqual([]);
    expect(posted.platforms.playtomic.errors).toBeGreaterThan(0);
    expect((await row("poster")).availability?.error).toBe("error");

    const w3 = world();
    await runScrape(db, at(2 * HOUR), { adapters: [reader("playtomic", { cookie: true })], fetchImpl: w3.fetchImpl, clock: w3.clock });
    expect(w3.calls).toEqual([]);
  });

  it("finds a reader by the club's platform, else by its link", () => {
    const r = reader();
    expect(adapterFor("https://playtomic.io/x", "playtomic", [r])).toBe(r);
    expect(adapterFor("https://playtomic.io/x", "matchi", [r])).toBeNull();
    expect(adapterFor("https://playtomic.io/x", null, [r])).toBe(r);
    expect(adapterFor(null, "playtomic", [r])).toBeNull();
  });
});

describe("back-off and switches", () => {
  it("rests a blocked platform six hours, never retries inside the rest, then rests a day", async () => {
    await club("first");
    await club("second");
    const blocked = () => ({ status: 403 });
    const w = world(blocked);
    const run = await runScrape(db, NOW, { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(w.calls.length).toBe(1); // the second club is not tried after a 403
    expect(run.platforms.playtomic.blocked).toBe(true);
    expect(run.platforms.playtomic.restUntil).toBe(iso(6 * HOUR));
    expect((await row("first")).availability?.error).toBe("blocked 403");
    expect(await metric("scrape_blocked_playtomic")).toBe(1);

    // Inside the rest: not one request, whatever the clubs' caches say.
    for (const t of [20 * 60_000, 3 * HOUR, 6 * HOUR - 60_000]) {
      const wi = world(blocked);
      await runScrape(db, at(t), { adapters: [reader()], fetchImpl: wi.fetchImpl, clock: wi.clock });
      expect(wi.calls).toEqual([]);
    }

    // After it: one try, blocked again, and the next rest is a day.
    const w2 = world(blocked);
    const again = await runScrape(db, at(6 * HOUR + 60_000), { adapters: [reader()], fetchImpl: w2.fetchImpl, clock: w2.clock });
    expect(w2.calls.length).toBe(1);
    expect(again.platforms.playtomic.restUntil).toBe(iso(6 * HOUR + 60_000 + 24 * HOUR));

    // A clean read after that starts the ladder again from six hours.
    const w3 = world(() => ({ status: 200, body: { slots: [] } }));
    await runScrape(db, at(31 * HOUR), { adapters: [reader()], fetchImpl: w3.fetchImpl, clock: w3.clock });
    expect(w3.calls.length).toBeGreaterThan(0);
    const [state] = await readPlatformStates(db, ["playtomic"], at(31 * HOUR));
    expect(state.level).toBe(0);
  });

  it("stops at a 429 even when the reader calls it something else", async () => {
    await club("busy");
    await club("busy-two");
    const w = world(() => ({ status: 429 }));
    const liar: AvailabilityAdapter = { ...reader(), scrape: async (t, f) => ((await f(t.bookingUrl)), { ok: false, status: null, reason: "error", requests: 1, detail: null }) };
    const run = await runScrape(db, NOW, { adapters: [liar], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(w.calls.length).toBe(1);
    expect(run.platforms.playtomic.blocked).toBe(true);
  });

  it("SCRAPE_DISABLED turns a platform off, or all of them, with no deploy", async () => {
    await club("switch");
    expect(disabledPlatforms(" Playtomic, matchi ")).toEqual(new Set(["playtomic", "matchi"]));
    expect(disabledPlatforms("matchi,all")).toBe("all");

    process.env.SCRAPE_DISABLED = "playtomic";
    const w = world();
    await runScrape(db, NOW, { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(w.calls).toEqual([]);
    expect((await scrapeBoard(db, NOW, [reader()]))[0].state).toBe("off");

    process.env.SCRAPE_DISABLED = "all";
    expect(await scrapeIfDue(db, at(HOUR), { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock })).toEqual({ skipped: "off" });

    process.env.SCRAPE_DISABLED = "matchi";
    await runScrape(db, at(2 * HOUR), { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(w.calls.length).toBe(1);

    // The switch that needs no deploy at all: a row the operator door writes, read at the next run.
    await setMetric(db, "scrape_off_playtomic", 1, "2026-08-01"); // older than the sixty days the other rows count for
    await runScrape(db, at(3 * HOUR), { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(w.calls.length).toBe(1);
    await setMetric(db, "scrape_off_playtomic", 0, "2026-10-10");
    await setMetric(db, "scrape_off_all", 1, "2026-10-10");
    await runScrape(db, at(4 * HOUR), { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(w.calls.length).toBe(1);
    await setMetric(db, "scrape_off_all", 0, "2026-10-10");
    await runScrape(db, at(5 * HOUR), { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(w.calls.length).toBe(2);
  });

  it("a page changed at two clubs in one run stops the platform until a deploy of new code, and is counted", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "aaaaaaa";
    await club("moved");
    await club("moved-two");
    await club("moved-three", { availabilityAt: at(-HOUR * 2) });
    const w = world(() => ({ status: 200, body: { changed: true } }));
    const run = await runScrape(db, NOW, { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(run.platforms.playtomic.changed).toBe(true);
    expect(w.calls.length).toBe(2); // the second club that says "changed" stops the lane; the third is not read
    expect(await metric("scrape_changed_playtomic")).toBe(2);
    expect((await scrapeBoard(db, NOW, [reader()]))[0].state).toBe("stopped");

    const w2 = world();
    await runScrape(db, at(HOUR), { adapters: [reader()], fetchImpl: w2.fetchImpl, clock: w2.clock });
    expect(w2.calls).toEqual([]);

    process.env.VERCEL_GIT_COMMIT_SHA = "bbbbbbb"; // the next deploy
    await runScrape(db, at(2 * HOUR), { adapters: [reader()], fetchImpl: w2.fetchImpl, clock: w2.clock });
    expect(w2.calls.length).toBeGreaterThan(0);
  });

  it("one club's odd page is that club's error, never the platform's stop", async () => {
    await club("typo-link");
    await club("good-club", { availabilityAt: at(-HOUR * 2) });
    const w = world((url) => ({ status: 200, body: url.endsWith("/typo-link") ? { changed: true } : { slots: [] } }));
    const run = await runScrape(db, NOW, { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(run.platforms.playtomic.changed).toBe(false);
    expect(w.calls.map((c) => new URL(c.url).pathname)).toEqual(["/typo-link", "/good-club"]);
    expect((await row("typo-link")).availability?.error).toBe("changed 200");
    expect((await scrapeBoard(db, NOW, [reader()]))[0].state).toBe("fresh");
  });

  it("a club that read clean before and now says 'changed' stops the platform on its own", async () => {
    await club("was-fine");
    const clean = world(() => ({ status: 200, body: { slots: [] } }));
    await runScrape(db, NOW, { adapters: [reader()], fetchImpl: clean.fetchImpl, clock: clean.clock });
    expect((await row("was-fine")).availability?.error).toBeNull();
    const w = world(() => ({ status: 200, body: { changed: true } }));
    const run = await runScrape(db, at(2 * HOUR), { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(run.platforms.playtomic.changed).toBe(true);
    expect((await scrapeBoard(db, at(2 * HOUR), [reader()]))[0].state).toBe("stopped");
  });

  it("calls a challenge or a captcha a block: a WAF header, a 202 or a 405 on a GET", async () => {
    const answers: { status: number; headers?: Record<string, string> }[] = [{ status: 202 }, { status: 405 }, { status: 200, headers: { "x-amzn-waf-action": "challenge" } }, { status: 200, headers: { "cf-mitigated": "challenge" } }];
    for (const [i, answer] of answers.entries()) {
      const slug = `waf-${i}`;
      await club(slug);
      await club(`${slug}-next`, { availabilityAt: at(-HOUR * 2) });
      const w = world(() => ({ ...answer, body: { slots: [] } }));
      const run = await runScrape(db, at(i * 7 * DAY), { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
      expect([JSON.stringify(answer), run.platforms.playtomic.blocked]).toEqual([JSON.stringify(answer), true]);
      expect(w.calls.length).toBe(1); // nothing more is asked of a platform that challenged us
      expect((await row(slug)).availability?.error).toBe(`blocked ${answer.status}`);
      await db.delete(metricsDaily).where(like(metricsDaily.key, "scrape_rest_%"));
      await db.delete(clubs);
    }
  });

  it("MATCHi through the frame: a redirect to sign in is a block, a club MATCHi no longer has is not found", async () => {
    const matchi = createMatchiAdapter({ sleep: async () => undefined, clock: () => 0 });
    const page = (path: string, final: string) => ({ status: 200, text: `<html>${path}</html>`, url: `https://www.matchi.se${final}` });
    // A club that left MATCHi: /facilities/<slug> answers 200 from /facilities/index, which names no facility.
    await club("left-matchi", { bookingUrl: "https://www.matchi.se/facilities/leftmatchi", bookingPlatform: "matchi" });
    const gone = world(() => page("index", "/facilities/index"));
    const r1 = await runScrape(db, NOW, { adapters: [matchi], fetchImpl: gone.fetchImpl, clock: gone.clock });
    expect(r1.platforms.matchi).toMatchObject({ changed: false, blocked: false, errors: 1 });
    expect((await row("left-matchi")).availability?.error).toBe("not_found 200");
    await db.delete(clubs);
    // A login wall: the reader stops, and the platform rests.
    await club("walled", { bookingUrl: "https://www.matchi.se/facilities/walled", bookingPlatform: "matchi" });
    const wall = world(() => page("login", "/login/auth?returnUrl=%2Ffacilities%2Fwalled"));
    const r2 = await runScrape(db, NOW, { adapters: [matchi], fetchImpl: wall.fetchImpl, clock: wall.clock });
    expect(r2.platforms.matchi.blocked).toBe(true);
    expect(r2.platforms.matchi.restUntil).toBe(iso(6 * HOUR));
  });

  it("runs every third push tick, and costs nothing while no reader exists", async () => {
    await club("ticks");
    const w = world();
    expect(await scrapeIfDue(db, NOW, { adapters: [], fetchImpl: w.fetchImpl, clock: w.clock })).toEqual({ skipped: "no_reader" });
    expect(await metric("cron_scrape_at")).toBe(0); // not even a write
    const first = await scrapeIfDue(db, NOW, { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
    expect("clubs" in first && first.clubs).toBe(1);
    expect(await scrapeIfDue(db, at(5 * 60_000), { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock })).toEqual({ skipped: "not_due" });
    expect(await scrapeIfDue(db, at(10 * 60_000), { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock })).toEqual({ skipped: "not_due" });
    const third = await scrapeIfDue(db, at(15 * 60_000), { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
    expect("clubs" in third).toBe(true);
  });
});

/**
 * The run's clock in production is `performance.now()`, which always carries a fraction. On 10 October
 * 2026 four Playtomic clubs a run wrote a cache whose whole error was "error": the request timeout was
 * the time left to the deadline, a fraction, and `AbortSignal.timeout` throws on anything but a whole
 * number, so the last one or two clubs of an eight-club lane failed before a request left. Every clock
 * above counts in whole milliseconds, which is why no test saw it. These start and step with fractions.
 */
describe("a clock with fractions, as performance.now() gives it", () => {
  const fixture = (dir: string, name: string) => readFileSync(path.join(import.meta.dirname, "fixtures/scrape", dir, name), "utf8");
  const PT_PAGE = fixture("playtomic", "club-the-padel-co.html");
  const PT_DAY = fixture("playtomic", "availability-the-padel-co-2026-10-11.json");
  /** Each club its own tenant, so the run's page cache never serves one club's days to another. */
  const ptPage = (pathname: string) => PT_PAGE.replaceAll("b692a586-2e22-4fca-add7-272f73c98aa7", `b692a586-2e22-4fca-add7-${createHash("md5").update(pathname).digest("hex").slice(0, 12)}`);
  const playtomic = (url: string): Answer => {
    const u = new URL(url);
    if (u.pathname.startsWith("/clubs/")) return { status: 200, text: ptPage(u.pathname) };
    if (u.pathname === "/api/clubs/availability") return { status: 200, text: PT_DAY, headers: { "content-type": "application/json" } };
    return { status: 404 };
  };
  /** The Playtomic reader keeps its own second between requests on `Date.now()`: move that clock on, so no real second passes. */
  const wallClock = () => {
    let wall = NOW.getTime();
    return vi.spyOn(Date, "now").mockImplementation(() => (wall += 5_000));
  };
  const ptClub = (slug: string) => club(slug, { bookingUrl: `https://playtomic.com/clubs/${slug}`, website: `https://playtomic.com/clubs/${slug}`, availabilityAt: at(-61 * 60_000) });

  // The runs of 10 October: at 1.19 s a request (10:50) the lane's eighth club wrote "error"; at 1.43 s
  // (11:50 and 12:20) its seventh and eighth did. At 1.43 s thirty-two requests no longer fit in 45
  // seconds, so the eighth club is cut short and stays due for the next run, unwritten.
  for (const c of [
    { cost: 1190.123, requests: 32, ok: 8, outOfTime: false, unread: [] as string[] },
    { cost: 1430.123, requests: 31, ok: 7, outOfTime: true, unread: ["padel-cnx"] },
  ]) {
    it(`reads every Playtomic club of a lane clean at ${c.cost} ms a request, the last ones too`, async () => {
      resetPlaytomicState();
      const slugs = ["baan-padel", "bangkok-padel", "bel-club-padel", "destination-padel-club", "koh-tao-athletic-club", "love-all-sports", "madison-house-padel", "padel-cnx"];
      for (const s of slugs) await ptClub(s);
      const w = world(playtomic, c.cost, 1234.567);
      const spy = wallClock();
      try {
        const run = await runScrape(db, NOW, { adapters: [playtomicAdapter], fetchImpl: w.fetchImpl, clock: w.clock });
        expect(run.platforms.playtomic).toMatchObject({ requests: c.requests, ok: c.ok, errors: 0 });
        expect(run.outOfTime).toBe(c.outOfTime);
        expect(run.failed).toEqual([]);
        // Every request the frame counted went out: none died before it left.
        expect(w.calls).toHaveLength(c.requests);
        const rows = await db.select({ slug: clubs.slug, a: clubs.availability, at: clubs.availabilityAt }).from(clubs);
        expect(rows.filter((r) => r.a !== null && r.a.error !== null).map((r) => [r.slug, r.a?.error])).toEqual([]);
        expect(rows.filter((r) => r.at!.getTime() < NOW.getTime()).map((r) => r.slug)).toEqual(c.unread);
      } finally {
        spy.mockRestore();
        resetPlaytomicState();
      }
    });
  }

  it("never starts a request with under a second left, and a request the deadline cuts short is not written", async () => {
    resetPlaytomicState();
    await ptClub("padel-cnx");
    const spy = wallClock();
    try {
      // 0.9 s of budget: not one request fits, so none starts.
      const none = world(playtomic, 300, 0.25);
      const short = await runScrape(db, NOW, { adapters: [playtomicAdapter], fetchImpl: none.fetchImpl, clock: none.clock, budgetMs: 900.5 });
      expect(none.calls).toEqual([]);
      expect(short.outOfTime).toBe(true);
      expect((await row("padel-cnx")).availability).toBeNull();

      // 2.5 s of budget. baan-padel goes first and is one request (a club page the platform does not
      // know). Then the platform never answers for padel-cnx, which starts with 1.5 s left: the frame's
      // own deadline aborts that request (a real 1.5 s). The club is cut short, never written as an
      // error, and stays due for the next run. (A lane's first club is written: see "never starves" above.)
      await ptClub("baan-padel");
      const hang = world(() => ({ status: 404 }), 0, 0.25);
      const hanging = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).includes("padel-cnx")) return hang.fetchImpl(input, init);
        void hang.fetchImpl(input, init);
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      }) as typeof fetch;
      const cut = await runScrape(db, at(60_000), { adapters: [playtomicAdapter], fetchImpl: hanging, clock: hang.clock, budgetMs: 2_500.5 });
      expect(hang.calls).toHaveLength(2);
      expect(cut.outOfTime).toBe(true);
      expect(cut.clubs).toBe(1);
      expect(cut.failed.map((f) => f.slug)).toEqual(["baan-padel"]);
      expect((await row("padel-cnx")).availability).toBeNull();
    } finally {
      spy.mockRestore();
      resetPlaytomicState();
    }
  });

  // The deadline's signal also aborts the body download. A real club page is large, so its headers can
  // arrive in time and its body not: that cut is the run's too, and the club stays due, unwritten.
  for (const p of ["playtomic", "matchi"] as const) {
    it(`a ${p} body that the deadline cuts after the headers came is not written either`, async () => {
      resetPlaytomicState();
      // A club goes first (one request, a page the platform does not know), so padel-cnx is not the
      // lane's first: a lane's first club that the deadline cuts is written (see "never starves" above).
      if (p === "playtomic") await ptClub("baan-padel");
      else await club("a-head", { bookingUrl: "https://www.matchi.se/facilities/ahead", bookingPlatform: "matchi" });
      if (p === "playtomic") await ptClub("padel-cnx");
      else await club("padel-cnx", { bookingUrl: "https://www.matchi.se/facilities/padelcnx", bookingPlatform: "matchi" });
      const spy = wallClock();
      try {
        const w = world(() => ({ status: 404 }), 0, 0.25);
        // Headers at once, then a body that never comes: it ends only when the frame's signal aborts it
        // (a real 1.5 s: padel-cnx starts one second in, with 1.5 s left).
        const stalling = (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (!/padel-?cnx/.test(String(input))) return w.fetchImpl(input, init);
          void w.fetchImpl(input, init);
          const signal = init!.signal!;
          const body = new ReadableStream<Uint8Array>({ start: (c) => signal.addEventListener("abort", () => c.error(signal.reason)) });
          return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
        }) as typeof fetch;
        const adapter = p === "playtomic" ? playtomicAdapter : createMatchiAdapter({ sleep: async () => undefined, clock: () => 0 });
        const run = await runScrape(db, at(60_000), { adapters: [adapter], fetchImpl: stalling, clock: w.clock, budgetMs: 2_500.5 });
        expect(w.calls).toHaveLength(2);
        expect(run.outOfTime).toBe(true);
        expect(run.clubs).toBe(1);
        expect(run.failed.map((f) => f.slug)).toEqual([p === "playtomic" ? "baan-padel" : "a-head"]);
        expect((await row("padel-cnx")).availability).toBeNull();
      } finally {
        spy.mockRestore();
        resetPlaytomicState();
      }
    });
  }

  it("a Playtomic request that times out keeps the error's class as its why, never a word of the message", async () => {
    resetPlaytomicState();
    await ptClub("slow-pt");
    const spy = wallClock();
    // The platform's ten seconds run out at once, while the run's deadline is far off: the club is written.
    const timer = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
    try {
      const w = world(playtomic, 200.123, 0.25);
      const aborting = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await w.fetchImpl(input, init);
        if (init?.signal?.aborted) throw init.signal.reason;
        return res;
      }) as typeof fetch;
      const run = await runScrape(db, NOW, { adapters: [playtomicAdapter], fetchImpl: aborting, clock: w.clock });
      expect((await row("slow-pt")).availability).toMatchObject({ error: "timeout", why: "club page: TimeoutError", slots: [] });
      expect(run.failed).toEqual([{ slug: "slow-pt", platform: "playtomic", error: "timeout", why: "club page: TimeoutError" }]);
    } finally {
      timer.mockRestore();
      spy.mockRestore();
      resetPlaytomicState();
    }
  });

  it("MATCHi reads clean when its first request starts with 8.5 s left", async () => {
    const page = (name: string) => fixture("matchi", name);
    await club("blue-tree", { bookingUrl: "https://www.matchi.se/facilities/bluetree", bookingPlatform: "matchi" });
    const w = world((url) => {
      const u = new URL(url);
      if (u.pathname === "/facilities/bluetree") return { status: 200, text: page("facility-bluetree.html") };
      if (u.pathname === "/book/listSlots") return { status: 200, text: page(u.searchParams.get("date") === "2026-10-10" ? "list-slots-bluetree-2026-10-10.html" : u.searchParams.get("date") === "2026-10-11" ? "list-slots-bluetree-2026-10-11.html" : "list-slots-empty.html") };
      return { status: 404 };
    }, 200.123, 0.25);
    const matchi = createMatchiAdapter({ sleep: async () => undefined, clock: () => 0 });
    const run = await runScrape(db, NOW, { adapters: [matchi], fetchImpl: w.fetchImpl, clock: w.clock, budgetMs: 8_500.5 });
    expect(run.platforms.matchi).toMatchObject({ ok: 1, errors: 0 });
    expect((await row("blue-tree")).availability).toMatchObject({ error: null, source: "scrape:matchi" });
  });

  it("Book & Go reads clean when its first request starts with 8.5 s left", async () => {
    const bg = (name: string) => fixture("bookandgo", name);
    await club("prime-padel-havelock", { bookingUrl: "https://app.primepadelsport.com/", bookingPlatform: "bookandgo", tz: "Asia/Singapore" });
    const w = world((url) => {
      const m = new URL(url).pathname.match(/^\/api\/v1\/apps\/39\/(locations|court-bookings)$/);
      if (!m) return { status: 404 };
      if (m[1] === "locations") return { status: 200, text: bg("locations-39.json"), headers: { "content-type": "application/json" } };
      const date = new URL(url).searchParams.get("date");
      return { status: 200, text: bg(`court-bookings-39-${date}.json`), headers: { "content-type": "application/json" } };
    }, 200.123, 0.25);
    const bookandgo = createBookandgoAdapter({ sleep: async () => undefined, clock: () => 0 });
    const run = await runScrape(db, NOW, { adapters: [bookandgo], fetchImpl: w.fetchImpl, clock: w.clock, budgetMs: 8_500.5 });
    expect(run.platforms.bookandgo).toMatchObject({ ok: 1, errors: 0 });
    expect((await row("prime-padel-havelock")).availability).toMatchObject({ error: null, source: "scrape:bookandgo" });
  });
});

describe("a failed read says why, in a few words that are safe to keep", () => {
  it("keeps a known step and the error's class or status, and drops everything else", () => {
    // What each reader gives, kept as it is.
    for (const kept of ["availability 2026-10-10: RangeError", "club page: HTTP 500", "club page: TypeError ECONNRESET", "club page: TypeError UND_ERR_CONNECT_TIMEOUT", "locations: HTTP 503", "frame: cap", "frame: budget", "club page: TimeoutError"]) expect(failureWhy(kept)).toBe(kept);
    // A word of a message is not a class: Playtomic's "no answer in 10 s" once kept "no".
    expect(failureWhy("club page: no answer in 10 s")).toBeNull();
    expect(failureWhy("availability 2026-10-10: no answer in 10 s")).toBeNull();
    expect(failureWhy("club page: localhost refused")).toBeNull();
    // The frame names only its own stops.
    expect(failureWhy("frame: TypeError")).toBeNull();
    expect(failureWhy("frame: localhost")).toBeNull();
    // A link, a token, an address and a body in the message: only the step and the class or status stay.
    expect(failureWhy("club page: TypeError https://playtomic.com/clubs/x?token=abc123")).toBe("club page: TypeError");
    expect(failureWhy("availability 2026-10-10: HTTP 500 Bearer eyJhbGciOi.e30.abc")).toBe("availability 2026-10-10: HTTP 500");
    expect(failureWhy("club page: TypeError ECONNREFUSED 10.0.0.12:443")).toBe("club page: TypeError ECONNREFUSED");
    expect(failureWhy("club page: sk7Live9abc123")).toBeNull(); // a token under 24 characters
    expect(failureWhy("club page: 10.0.0.12")).toBeNull();
    expect(failureWhy('club page: {"secret":"abc"}')).toBeNull();
    expect(failureWhy("club page: TypeError ec0nn.reset")).toBe("club page: TypeError"); // a code not in capitals is not a code
    expect(failureWhy("club page: HTTP 5000")).toBeNull();
    // A step that is not one of the readers' own is dropped with the rest.
    expect(failureWhy("500 on /book/listSlots?facility=2165&date=2026-10-10")).toBeNull();
    expect(failureWhy("https://x.example/a?k=1: TypeError")).toBeNull();
    expect(failureWhy("10.0.0.12: HTTP 500")).toBeNull();
    expect(failureWhy("frame: x".repeat(10))).toBeNull();
    expect(failureWhy(`club page: ${"x".repeat(41)}`)).toBeNull();
    expect(failureWhy(null)).toBeNull();
  });

  it("writes it beside the error, names the club in the run's answer, and never shows it in public", async () => {
    await club("broken");
    const leaky: AvailabilityAdapter = { ...reader(), scrape: async (t, f) => ((await f(t.bookingUrl)), { ok: false, status: 500, reason: "error", requests: 1, detail: `club page: HTTP 500 at ${t.bookingUrl}?key=abcdefabcdefabcdefabcdefabcdef` }) };
    const w = world(() => ({ status: 500 }));
    const run = await runScrape(db, NOW, { adapters: [leaky], fetchImpl: w.fetchImpl, clock: w.clock });
    const a = (await row("broken")).availability!;
    expect(a).toMatchObject({ error: "error 500", why: "club page: HTTP 500", slots: [] });
    expect(run.failed).toEqual([{ slug: "broken", platform: "playtomic", error: "error 500", why: "club page: HTTP 500" }]);
    expect(JSON.stringify(clubToPublic(await row("broken"), "https://kicksma.sh", undefined, NOW))).not.toContain("HTTP 500");
  });

  it("a reader that swallows the frame's own stop still gets the frame's word for it", async () => {
    await club("greedy-swallower");
    // A reader that catches everything, as the three real readers did with the frame's errors.
    const swallower: AvailabilityAdapter = {
      ...reader(),
      async scrape(t, f) {
        try {
          for (let i = 0; i < 12; i++) await f(`${t.bookingUrl}?day=${i}`);
          return { ok: true, slots: [], requests: 12 };
        } catch (e) {
          return { ok: false, status: null, reason: "error", requests: 0, detail: e instanceof Error ? e.message : String(e) };
        }
      },
    };
    const w = world();
    const run = await runScrape(db, NOW, { adapters: [swallower], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(w.calls).toHaveLength(SCRAPE.perClub);
    expect((await row("greedy-swallower")).availability).toMatchObject({ error: "error", why: "frame: cap" });
    expect(run.failed).toEqual([{ slug: "greedy-swallower", platform: "playtomic", error: "error", why: "frame: cap" }]);
  });

  it("a reader that swallows the frame's own abort still gets 'timeout', not 'error'", async () => {
    await club("abort-swallower");
    // A reader that catches everything and calls it an error.
    const swallower: AvailabilityAdapter = {
      ...reader(),
      async scrape(t, f) {
        try {
          await f(t.bookingUrl);
          return { ok: true, slots: [], requests: 1 };
        } catch (e) {
          return { ok: false, status: null, reason: "error", requests: 1, detail: e instanceof Error ? e.message : String(e) };
        }
      },
    };
    // The platform's own ten seconds run out at once (the run's deadline is far off, so the club is
    // written): the frame's timer aborts the request, as fetch does, with the signal's reason.
    const timeouts: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return AbortSignal.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    });
    try {
      const w = world();
      const aborting = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await w.fetchImpl(input, init);
        if (init?.signal?.aborted) throw init.signal.reason;
        return res;
      }) as typeof fetch;
      const run = await runScrape(db, NOW, { adapters: [swallower], fetchImpl: aborting, clock: w.clock });
      expect(timeouts).toEqual([SCRAPE.requestTimeoutMs]);
      expect(run.outOfTime).toBe(false);
      expect((await row("abort-swallower")).availability).toMatchObject({ error: "timeout", slots: [] });
      expect(run.failed).toEqual([{ slug: "abort-swallower", platform: "playtomic", error: "timeout", why: null }]);
    } finally {
      spy.mockRestore();
    }
  });

  it("no list and no pick carries `why`: only the row and the run's answer do (rule 12)", async () => {
    await club("broken-listed", { approvedAt: at(-DAY), source: "claim" });
    const leaky: AvailabilityAdapter = { ...reader(), scrape: async (t, f) => ((await f(t.bookingUrl)), { ok: false, status: 500, reason: "error", requests: 1, detail: "club page: HTTP 500" }) };
    const w = world(() => ({ status: 500 }));
    await runScrape(db, NOW, { adapters: [leaky], fetchImpl: w.fetchImpl, clock: w.clock });
    expect((await row("broken-listed")).availability).toMatchObject({ error: "error 500", why: "club page: HTTP 500" });
    const listed = [(await listShownClubs(db, null, 400, NOW)).find((c) => c.slug === "broken-listed")!, (await listLiveClubs(db, null, 200, NOW)).find((c) => c.slug === "broken-listed")!];
    for (const l of listed) {
      expect(l.availability).toMatchObject({ error: "error 500", source: "scrape:playtomic" });
      expect(l.availability).not.toHaveProperty("why");
    }
    const [due] = await dueClubs(db, at(2 * HOUR), "playtomic", 8);
    expect(due.slug).toBe("broken-listed");
    expect(due.prev).toMatchObject({ error: "error 500" });
    expect(due.prev).not.toHaveProperty("why");
  });
});

describe("what a read writes", () => {
  const slots: ScrapedSlot[] = [
    { start: iso(2 * HOUR), end: iso(3 * HOUR), court: "Court 1", free: true, priceText: " 1,200 ฿ ", bookUrl: "https://playtomic.io/book/1" },
    { start: iso(2 * HOUR), end: iso(3 * HOUR), court: "Court 2", free: true, priceText: null, bookUrl: "https://evil.example/phish" },
    { start: iso(2 * HOUR), end: iso(3 * HOUR), court: "Court 3", free: false, priceText: null, bookUrl: null },
    { start: iso(DAY + 2 * HOUR), end: iso(DAY + 3 * HOUR), court: null, free: true, priceText: null, bookUrl: null },
    { start: iso(2 * DAY + 2 * HOUR), end: iso(2 * DAY + 3 * HOUR), court: "Court 1", free: true, priceText: null, bookUrl: null },
    { start: iso(3 * DAY + 2 * HOUR), end: iso(3 * DAY + 3 * HOUR), court: "Court 1", free: true, priceText: null, bookUrl: null },
    { start: iso(-HOUR), end: iso(-1), court: "Court 1", free: true, priceText: null, bookUrl: null },
  ];

  it("keeps several days of free courts, counts the courts per time, and the counters move", async () => {
    await club("days");
    const w = world(() => ({ status: 200, body: { slots } }));
    const run = await runScrape(db, NOW, { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(run.fresh).toBe(1);
    const c = await row("days");
    const a = c.availability!;
    expect(a.source).toBe("scrape:playtomic");
    expect(a.days).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
    expect(a.slots.map((s) => [s.start, s.free])).toEqual([
      [iso(2 * HOUR), 2],
      [iso(DAY + 2 * HOUR), 1],
      [iso(2 * DAY + 2 * HOUR), 1],
    ]);
    // No link, price or court name for each slot: they were most of the bytes, and nothing reads them (job F2).
    expect(a.slots[0]).toEqual({ start: iso(2 * HOUR), end: iso(3 * HOUR), free: 2 });
    expect(c.availabilityAt?.toISOString()).toBe(NOW.toISOString());
    // Readers that say "today" see today only.
    expect(freeCourtHours(c, NOW)).toBe(2);
    expect(clubToPublic(c, "https://kicksma.sh").freeCourts?.slots).toEqual([{ start: iso(2 * HOUR), end: iso(3 * HOUR), free: 2 }]);
    // An old read is not shown as if it were now.
    expect(freeCourtHours(c, at(SCRAPE_SHOWN_HOURS * HOUR + 60_000))).toBeNull();

    expect(await metric("scrape_ok_playtomic")).toBe(1);
    expect(await metric("scrape_requests_playtomic")).toBe(1);
    expect(await metric("scrape_clubs_fresh")).toBe(1);
    expect((await scrapeBoard(db, NOW, [reader()]))[0]).toMatchObject({ state: "fresh", fresh: 1, requestsToday: 1 });
  });

  it("a list reads the next 26 hours of a club's slots and never the cache's later days (job F2)", async () => {
    await club("days", { approvedAt: at(-DAY), source: "claim" });
    const w = world(() => ({ status: 200, body: { slots } }));
    await runScrape(db, NOW, { adapters: [reader()], fetchImpl: w.fetchImpl, clock: w.clock });
    const full = await row("days");
    expect(full.availability!.slots).toHaveLength(3);
    for (const listed of [(await listShownClubs(db)).find((c) => c.slug === "days")!, (await listLiveClubs(db)).find((c) => c.slug === "days")!]) {
      // Today's 12:00 only: tomorrow's 12:00 starts 26 hours after NOW, the day after's later still.
      expect(listed.availability!.slots).toEqual([{ start: iso(2 * HOUR), end: iso(3 * HOUR), free: 2 }]);
      expect(listed.availability).toMatchObject({ source: "scrape:playtomic", tz: "Asia/Bangkok", days: full.availability!.days, fetchedAt: full.availability!.fetchedAt });
      expect(freeCourtHours(listed, NOW)).toBe(freeCourtHours(full, NOW));
      expect(clubToPublic(listed, "https://kicksma.sh").freeCourts).toEqual(clubToPublic(full, "https://kicksma.sh").freeCourts);
    }
    // A picker never reads the cache at all.
    const picked = (await listClubsForPicking(db)).find((c) => c.slug === "days")!;
    expect(picked).toBeDefined();
    expect("availability" in picked).toBe(false);
  });

  it("hands the reader the club's zone as it is, and keeps the zone the reader read in (readers F2)", async () => {
    await club("no-zone", { tz: null });
    const seen: ScrapeTarget[] = [];
    // 13:00 in Singapore tomorrow; NOW is 11:00 in Singapore on the 10th.
    const w = world(() => ({ status: 200, body: { slots: [{ start: iso(DAY + 2 * HOUR), end: iso(DAY + 3 * HOUR), court: "1", free: true, priceText: null, bookUrl: null }], tz: "Asia/Singapore" } }));
    await runScrape(db, NOW, { adapters: [reader("playtomic", { seen })], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(seen.map((t) => t.tz)).toEqual([null]); // never "UTC" in place of a zone nobody gave
    const a = (await row("no-zone")).availability!;
    expect(a).toMatchObject({ tz: "Asia/Singapore", day: "2026-10-10", days: ["2026-10-10", "2026-10-11", "2026-10-12"], error: null });
    expect(a.slots).toEqual([{ start: iso(DAY + 2 * HOUR), end: iso(DAY + 3 * HOUR), free: 1 }]);

    // A reader that found no zone either, for a club that has none: an error, never a guess.
    const w2 = world(() => ({ status: 200, body: { slots: [] } }));
    await runScrape(db, at(2 * HOUR), { adapters: [reader()], fetchImpl: w2.fetchImpl, clock: w2.clock });
    expect((await row("no-zone")).availability).toMatchObject({ error: "no time zone", slots: [] });
  });

  it("reads today every 15 minutes and the next two days at most hourly, and keeps those days in between", async () => {
    const org = await makePlayer(db, "Org");
    await club("busy-club");
    await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(DAY), tz: "Asia/Bangkok", venueName: "busy club", whenFull: "waitlist" });
    const seen: ScrapeTarget[] = [];
    const slot = (from: number, court: string): ScrapedSlot => ({ start: iso(from), end: iso(from + HOUR), court, free: true, priceText: null, bookUrl: null });
    const read = async (t: number, slots: ScrapedSlot[]) => {
      const w = world(() => ({ status: 200, body: { slots } }));
      await runScrape(db, at(t), { adapters: [reader("playtomic", { seen })], fetchImpl: w.fetchImpl, clock: w.clock });
      return (await row("busy-club")).availability!;
    };
    // NOW: all three days. Today 12:00 two courts, tomorrow and the day after one each.
    const first = await read(0, [slot(2 * HOUR, "1"), slot(2 * HOUR, "2"), slot(DAY + 2 * HOUR, "1"), slot(2 * DAY + 2 * HOUR, "1")]);
    expect(first.fullAt).toBe(iso(0));
    // 15 minutes on: today only. A court went at 12:00; tomorrow's and the day after's stay as the full read left them.
    const second = await read(15 * 60_000, [slot(2 * HOUR, "1"), slot(DAY + 5 * HOUR, "9")]);
    expect(second.slots).toEqual([
      { start: iso(2 * HOUR), end: iso(3 * HOUR), free: 1 },
      { start: iso(DAY + 2 * HOUR), end: iso(DAY + 3 * HOUR), free: 1 },
      { start: iso(2 * DAY + 2 * HOUR), end: iso(2 * DAY + 3 * HOUR), free: 1 },
    ]);
    expect(second).toMatchObject({ fetchedAt: iso(15 * 60_000), fullAt: iso(0), days: ["2026-10-10", "2026-10-11", "2026-10-12"], error: null });
    await read(30 * 60_000, [slot(2 * HOUR, "1")]);
    await read(45 * 60_000, [slot(2 * HOUR, "1")]);
    // An hour after the full read: all three days again.
    const fifth = await read(60 * 60_000, [slot(2 * HOUR, "1")]);
    expect(fifth.fullAt).toBe(iso(60 * 60_000));
    expect(fifth.slots).toHaveLength(1);
    expect(seen.map((t) => t.days)).toEqual([3, 1, 1, 1, 3]);
  });

  it("reads all three days again after a read that failed", async () => {
    const org = await makePlayer(db, "Org");
    await club("busy-club");
    await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(DAY), tz: "Asia/Bangkok", venueName: "busy club", whenFull: "waitlist" });
    const seen: ScrapeTarget[] = [];
    const run = async (t: number, status: number) => {
      const w = world(() => ({ status, body: { slots: [] } }));
      await runScrape(db, at(t), { adapters: [reader("playtomic", { seen })], fetchImpl: w.fetchImpl, clock: w.clock });
    };
    await run(0, 200);
    await run(15 * 60_000, 404);
    await run(30 * 60_000, 200);
    expect(seen.map((t) => t.days)).toEqual([3, 1, 3]);
  });

  it("a feed the club shared wins over a read, even one that started before the club shared it", async () => {
    await club("shares-late");
    const w = world(() => ({ status: 200, body: { slots } }));
    const sharer = reader("playtomic", {
      onRead: async (slug) => {
        await db.update(clubs).set({ availabilityUrl: "https://shares-late.example/free.json", availabilityKind: "json_free" }).where(eq(clubs.slug, slug));
      },
    });
    const run = await runScrape(db, NOW, { adapters: [sharer], fetchImpl: w.fetchImpl, clock: w.clock });
    expect(run.fresh).toBe(0);
    expect((await row("shares-late")).availability).toBeNull();
    // And from then on the club is never read.
    const w2 = world();
    await runScrape(db, at(HOUR), { adapters: [reader()], fetchImpl: w2.fetchImpl, clock: w2.clock });
    expect(w2.calls).toEqual([]);
  });

  it("keeps each court's free time once, cut where the count changes and at the club's midnight", () => {
    // Bangkok times: 11:00 is NOW+1h. Court A is listed at 11:00 for 60 and 120 minutes and at 12:00 for
    // 60 (one free stretch, 11:00-13:00); court B is free 12:00-13:00; court C 23:00-01:00 crosses
    // midnight; court D at 23:30 on the last day runs past the end of what the read covers.
    const s = (from: number, to: number, court: string): ScrapedSlot => ({ start: iso(from), end: iso(to), court, free: true, priceText: "x", bookUrl: "https://playtomic.io/book" });
    const out = freeSlotsFromScrape(
      [s(HOUR, 2 * HOUR, "A"), s(HOUR, 3 * HOUR, "A"), s(2 * HOUR, 3 * HOUR, "A"), s(2 * HOUR, 3 * HOUR, "B"), s(13 * HOUR, 15 * HOUR, "C"), s(DAY + 13.5 * HOUR, DAY + 14.5 * HOUR, "D")],
      { tz: "Asia/Bangkok", now: NOW, days: ["2026-10-10", "2026-10-11"] },
    );
    expect(out).toEqual([
      { start: iso(HOUR), end: iso(2 * HOUR), free: 1 },
      { start: iso(2 * HOUR), end: iso(3 * HOUR), free: 2 },
      { start: iso(13 * HOUR), end: iso(14 * HOUR), free: 1 }, // 23:00-00:00 on the 10th
      { start: iso(14 * HOUR), end: iso(15 * HOUR), free: 1 }, // 00:00-01:00 on the 11th: the same count, but another day
      { start: iso(DAY + 13.5 * HOUR), end: iso(DAY + 14 * HOUR), free: 1 }, // clipped at the end of the 11th
    ]);
  });

  it("keys a court on its id when the reader gives one: two courts with one name stay two", () => {
    const s = (court: string, courtId: string | undefined, from: number, to: number): ScrapedSlot => ({ start: iso(from), end: iso(to), court, courtId, free: true, priceText: null, bookUrl: null });
    const out = freeSlotsFromScrape([s("Court", "1", HOUR, 2 * HOUR), s("Court", "2", HOUR, 2 * HOUR), s("Court", "1", HOUR, 3 * HOUR)], { tz: "Asia/Bangkok", now: NOW, days: ["2026-10-10"] });
    expect(out).toEqual([
      { start: iso(HOUR), end: iso(2 * HOUR), free: 2 },
      { start: iso(2 * HOUR), end: iso(3 * HOUR), free: 1 },
    ]);
  });

  it("the service board has one line per platform", async () => {
    await db.delete(metricsDaily).where(like(metricsDaily.key, "scrape_%"));
    expect(await scrapeBoard(db, NOW, [])).toEqual([]);
    const lines = await scrapeBoard(db, NOW, [reader(), reader("matchi")]);
    expect(lines.map((l) => [l.platform, l.state])).toEqual([
      ["playtomic", "fresh"],
      ["matchi", "fresh"],
    ]);
  });
});

const SCRAPE_SHOWN_HOURS = 2;

describe("what a page and the API show of a read (decision 8: the source is named)", () => {
  const read = (o: Partial<NonNullable<Club["availability"]>> = {}): NonNullable<Club["availability"]> => ({
    fetchedAt: NOW.toISOString(),
    day: "2026-10-10",
    days: ["2026-10-10", "2026-10-11", "2026-10-12"],
    tz: "Asia/Bangkok",
    source: "scrape:playtomic",
    platform: "playtomic",
    error: null,
    fullAt: NOW.toISOString(),
    slots: [
      { start: iso(2 * HOUR), end: iso(4 * HOUR), free: 2 },
      { start: iso(DAY + 2 * HOUR), end: iso(DAY + 3 * HOUR), free: 1 },
    ],
    ...o,
  });
  const feed = { availabilityUrl: "https://club.example/b.ics", availabilityKind: "ics_bookings" };
  const none = { availabilityUrl: null, availabilityKind: null };

  it("names the platform a read came from, and says when it is not available rather than blaming the club", () => {
    expect(freeCourtsState({ ...none, availability: read() }, NOW)).toMatchObject({ kind: "platform", platform: "Playtomic" });
    // Old, or failed: the platform's times are not available just now; the club did nothing wrong (docs-rules F5).
    expect(freeCourtsState({ ...none, availability: read() }, at(3 * HOUR))).toEqual({ kind: "platformDown", platform: "Playtomic" });
    expect(freeCourtsState({ ...none, availability: read({ error: "blocked 429", slots: [] }) }, NOW)).toEqual({ kind: "platformDown", platform: "Playtomic" });
    // A club's own feed is the club's, whatever its cache says.
    expect(freeCourtsState({ ...feed, availability: { ...read(), source: "ics_bookings", platform: undefined } }, NOW)).toMatchObject({ kind: "feed" });
    expect(freeCourtsState({ ...feed, availability: null }, NOW)).toEqual({ kind: "feed", a: null });
    expect(freeCourtsState({ ...none, availability: null }, NOW)).toEqual({ kind: "none" });
  });

  it("a listed club's page shows the card while a read is fresh, as its row on /clubs does; a club that runs its page also hears when it is down (docs-rules F5, F6)", () => {
    const fresh = { ...none, availability: read() };
    const failed = { ...none, availability: read({ error: "blocked 403", slots: [] }) };
    expect([freeCourtsCardShown(fresh, false, NOW), freeCourtsCardShown(failed, false, NOW), freeCourtsCardShown(fresh, false, at(3 * HOUR))]).toEqual([true, false, false]);
    expect([freeCourtsCardShown(fresh, true, NOW), freeCourtsCardShown(failed, true, NOW), freeCourtsCardShown({ ...none, availability: null }, true, NOW)]).toEqual([true, true, false]);
    expect(freeCourtsCardShown({ ...feed, availability: null }, true, NOW)).toBe(true);
    // The hours a list row shows come with a card on the page: both read the same fresh read.
    expect(freeCourtHours(fresh, NOW)).toBe(4);
    expect(freeCourtHours(fresh, at(3 * HOUR))).toBeNull();
  });

  it("the API says where today's free courts come from, and never serves an old read as now (job F6, docs-rules F2-F4)", () => {
    const base = { slug: "x", name: "X", approvedAt: NOW, rejectedAt: null } as unknown as Club;
    const fresh = clubToPublic({ ...base, ...none, availability: read() }, "https://kicksma.sh", undefined, NOW).freeCourts;
    expect(fresh).toEqual({ day: "2026-10-10", tz: "Asia/Bangkok", fetchedAt: NOW.toISOString(), source: "platform", platform: "playtomic", slots: [{ start: iso(2 * HOUR), end: iso(4 * HOUR), free: 2 }] });
    // Three hours on, the platform rests: the API says nothing rather than yesterday's courts.
    expect(clubToPublic({ ...base, ...none, availability: read() }, "https://kicksma.sh", undefined, at(3 * HOUR)).freeCourts).toBeNull();
    const own = clubToPublic({ ...base, ...feed, availability: { ...read(), source: "ics_bookings", platform: undefined, days: undefined } }, "https://kicksma.sh", undefined, NOW).freeCourts;
    expect(own).toMatchObject({ source: "club", platform: null });
  });
});
