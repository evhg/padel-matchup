import { execFileSync } from "node:child_process";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, metricsDaily, type Club } from "@/db/schema";
import { adapterFor, type AvailabilityAdapter, type ScrapedSlot, type ScrapeResult, type ScrapeTarget } from "@/lib/booking/adapters";
import { createMatchiAdapter, matchiAdapter } from "@/lib/booking/adapters/matchi";
import { playtomicAdapter } from "@/lib/booking/adapters/playtomic";
import { clubToPublic } from "@/lib/api/serialize";
import { freeCourtsCardShown, freeCourtsState } from "@/lib/booking/availability";
import { freeCourtHours, listClubsForPicking, listLiveClubs, listShownClubs } from "@/lib/domain/clubs";
import { createEvent } from "@/lib/domain/events";
import { setMetric } from "@/lib/domain/metrics";
import { SCRAPE, disabledPlatforms, freeSlotsFromScrape, readPlatformStates, runScrape, scrapeBoard, scrapeIfDue, type Clock } from "@/lib/booking/scrape";
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
function world(answer: (url: string) => Answer = () => ({ status: 200, body: { slots: [] } }), costMs = 200) {
  let t = 0;
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
const reader = (platform = "playtomic", o: { method?: string; cookie?: boolean; requests?: number; onRead?: (slug: string) => Promise<void>; seen?: ScrapeTarget[] } = {}): AvailabilityAdapter => ({
  platform,
  matches: (url) => url.includes(`${platform}.`),
  async scrape(target, fetchImpl): Promise<ScrapeResult> {
    o.seen?.push(target);
    await o.onRead?.(target.clubSlug);
    let res: Response | null = null;
    for (let i = 0; i < (o.requests ?? 1); i++) {
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

  it("a club whose read the deadline cuts short is not written, and stays due", async () => {
    await club("slow-pages");
    const w = world(undefined, 10_000);
    const run = await runScrape(db, NOW, { adapters: [reader("playtomic", { requests: 5 })], fetchImpl: w.fetchImpl, clock: w.clock, budgetMs: 25_000 });
    expect(w.calls.length).toBe(3);
    expect(run.outOfTime).toBe(true);
    expect(run.clubs).toBe(0);
    expect((await row("slow-pages")).availabilityAt).toBeNull();
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
