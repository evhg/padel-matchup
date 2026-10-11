import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, metricsDaily, type Club, type ClubAvailability } from "@/db/schema";
import type { AvailabilityAdapter, ScrapedSlot, ScrapeResult, ScrapeTarget } from "@/lib/booking/adapters/types";
import { chunkNumber, holdsCheckoutBuilder, huntOrder, playtomicAdapter, playtomicScripts, resetPlaytomicState } from "@/lib/booking/adapters/playtomic";
import { fnv1a, linkKey } from "@/lib/booking/linkKey";
import { offeredCourts, offersFromScrape, pickCourt } from "@/lib/booking/offers";
import { CHECKOUT, CHECKOUT_FRESH_MS, checkoutFor, prepareBooking, type CheckoutCache } from "@/lib/booking/prepare";
import { runScrape, scrapeBoard, type Clock } from "@/lib/booking/scrape";
import { zonedTimeToUtc } from "@/lib/dates";
import { getClubForBooking, getClubWithCache, listShownClubs } from "@/lib/domain/clubs";
import { setMetric } from "@/lib/domain/metrics";
import { freezeClock } from "./helpers/clock";
import { createTestDb } from "./helpers/db";

/**
 * "Book this court" opens Playtomic's own checkout, filled in (the owner's decision of 11 October 2026,
 * "Playtomic checkout, filled", DECIDING rule 36): the reader keeps the exact starts Playtomic lists
 * (`offers`), the match page builds the checkout link for the match's court, start and length when
 * Playtomic listed exactly that, else the day page, and a read of the club page checks that its script
 * still builds that link. No test calls Playtomic: every fetch is a stub, and nothing opens a checkout.
 *
 * NOW is Saturday 10 October 2026, 03:00 UTC, 10:00 in Bangkok. A read covers the 10th, 11th and 12th.
 * The match is Sunday the 11th, 18:00 to 19:30 in Bangkok (11:00 UTC), on "court 2".
 */
const NOW = new Date("2026-10-10T03:00:00.000Z");
freezeClock(NOW);
const TZ = "Asia/Bangkok";
const DAYS = ["2026-10-10", "2026-10-11", "2026-10-12"];
const MIN = 60_000;
const bkk = (date: string, time: string) => zonedTimeToUtc(date, time, TZ);
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN).toISOString();

const TENANT = "b692a586-2e22-4fca-add7-272f73c98aa7";
const PADEL1 = "30d9f634-9ef5-4ce2-b69b-037bb7d15701";
const PADEL2 = "27648c80-eebf-448c-b0de-2166165b00cc";
const LINK = "https://playtomic.com/clubs/the-padel-co";

/** One start Playtomic lists: a court, a start in Bangkok, a length. */
const offer = (court: string, name: string | null, date: string, time: string, minutes: number): ScrapedSlot => {
  const start = bkk(date, time);
  return { start: start.toISOString(), end: new Date(start.getTime() + minutes * MIN).toISOString(), court: name ?? court, courtId: court, free: true, priceText: "1500 THB", bookUrl: null };
};
/** Sunday: Padel 2 lists 18:00 for 60 and 90 minutes; Padel 1 lists 18:00 for 60 only, and 18:30 for 90. */
const SUNDAY = [offer(PADEL2, "Padel 2", "2026-10-11", "18:00", 60), offer(PADEL2, "Padel 2", "2026-10-11", "18:00", 90), offer(PADEL1, "Padel 1", "2026-10-11", "18:00", 60), offer(PADEL1, "Padel 1", "2026-10-11", "18:30", 90)];
const MATCH = { start: bkk("2026-10-11", "18:00"), minutes: 90, tz: TZ, court: "2" };

const directoryClub = { bookingUrl: null, bookingPlatform: "playtomic", website: LINK, tz: TZ, source: "directory", approvedAt: null, rejectedAt: null };
const cache = (o: Partial<CheckoutCache> = {}): CheckoutCache => ({
  fetchedAt: ago(10),
  day: "2026-10-10",
  days: DAYS,
  tz: TZ,
  source: "scrape:playtomic",
  error: null,
  fullAt: ago(30),
  ref: TENANT,
  linkKey: linkKey(LINK),
  offers: offersFromScrape(SUNDAY, { tz: TZ, days: DAYS, now: NOW })!,
  ...o,
});

describe("the offers a read keeps", () => {
  it("keeps exactly the starts and lengths Playtomic listed, court by court, with the courts' names", () => {
    const o = offersFromScrape(SUNDAY, { tz: TZ, days: DAYS, now: NOW })!;
    expect(o.courts).toEqual({ [PADEL2.slice(0, 8)]: [PADEL2, "Padel 2"], [PADEL1.slice(0, 8)]: [PADEL1, "Padel 1"] });
    // 18:00 is the 36th half hour from the club's midnight: Padel 2 has 60 + 90 (1 + 2) there.
    expect(o.days["2026-10-11"][PADEL2.slice(0, 8)]).toBe(`${"0".repeat(36)}3`);
    expect(o.days["2026-10-11"][PADEL1.slice(0, 8)]).toBe(`${"0".repeat(36)}12`);
    expect(offeredCourts(o, TZ, MATCH.start, 90)).toEqual([{ id: PADEL2, name: "Padel 2" }]);
    expect(offeredCourts(o, TZ, MATCH.start, 60).map((c) => c.name).sort()).toEqual(["Padel 1", "Padel 2"]);
    expect(offeredCourts(o, TZ, MATCH.start, 120)).toEqual([]);
    expect(offeredCourts(o, TZ, bkk("2026-10-11", "18:30"), 90)).toEqual([{ id: PADEL1, name: "Padel 1" }]);
  });

  it("keeps nothing it cannot hand to a checkout: another length, a start off the half hour, a start gone, a day not read, a court with no id", () => {
    const o = offersFromScrape(
      [
        offer(PADEL1, "Padel 1", "2026-10-11", "18:00", 75),
        offer(PADEL1, "Padel 1", "2026-10-11", "18:15", 60),
        offer(PADEL1, "Padel 1", "2026-10-10", "09:00", 60),
        offer(PADEL1, "Padel 1", "2026-10-14", "18:00", 60),
        { ...offer(PADEL2, "Padel 2", "2026-10-11", "18:00", 60), courtId: null },
      ],
      { tz: TZ, days: DAYS, now: NOW },
    );
    expect(o).toBeNull();
  });

  it("two courts whose ids start alike: the second keeps no offers, so its times open the day page", () => {
    const twin = `${PADEL1.slice(0, 8)}-0000-4000-8000-000000000000`;
    const o = offersFromScrape([offer(PADEL1, "Padel 1", "2026-10-11", "18:00", 90), offer(twin, "Padel 3", "2026-10-11", "19:00", 90)], { tz: TZ, days: DAYS, now: NOW })!;
    expect(Object.values(o.courts)).toEqual([[PADEL1, "Padel 1"]]);
    expect(offeredCourts(o, TZ, bkk("2026-10-11", "19:00"), 90)).toEqual([]);
  });

  it("the match's own court first ('2' is 'Padel 2'), else the first listed court by name", () => {
    const courts = [
      { id: PADEL1, name: "Padel 1" },
      { id: PADEL2, name: "Padel 2" },
    ];
    expect(pickCourt(courts, "2")?.id).toBe(PADEL2);
    expect(pickCourt(courts, "Padel 2")?.id).toBe(PADEL2);
    expect(pickCourt(courts, "Centre court")?.id).toBe(PADEL1);
    expect(pickCourt(courts, null)?.id).toBe(PADEL1);
    expect(pickCourt([], "2")).toBeNull();
  });

  it("never a court with no name: the page could not say which court the link holds, and it may be the match's own", () => {
    // A read of today alone sees no names; a row with no offers before it has none to lend (review, 11 October 2026).
    const unnamed = [
      { id: PADEL1, name: null },
      { id: PADEL2, name: null },
    ];
    expect(pickCourt(unnamed, "1")).toBeNull();
    expect(pickCourt(unnamed, null)).toBeNull();
    // One named, one not: the named one only when it is the match's court, or when the match names none.
    const half = [
      { id: PADEL1, name: "Padel 1" },
      { id: PADEL2, name: null },
    ];
    expect(pickCourt(half, "1")?.id).toBe(PADEL1);
    expect(pickCourt(half, null)?.id).toBe(PADEL1);
    expect(pickCourt(half, "2")).toBeNull();
  });
});

describe("\"Book this court\": Playtomic's checkout, else the day page", () => {
  it("fills Playtomic's own checkout with the court, the start and the length when Playtomic listed exactly that", () => {
    const b = prepareBooking(directoryClub, MATCH, { cache: cache(), now: NOW })!;
    expect(b).toMatchObject({ prepared: "checkout", platform: "playtomic", court: "Padel 2" });
    const u = new URL(b.url);
    expect(`${u.origin}${u.pathname}`).toBe("https://playtomic.com/api/web-app/payments");
    expect(Object.fromEntries(u.searchParams)).toEqual({ type: "CUSTOMER_MATCH", tenant_id: TENANT, resource_id: PADEL2, start: "2026-10-11T11:00:00.000Z", duration: "90", sport_id: "PADEL" });
  });

  it("books another listed court, and names it, when the match's own court is not listed then", () => {
    const b = prepareBooking(directoryClub, { ...MATCH, minutes: 60, court: "3" }, { cache: cache(), now: NOW })!;
    expect(b).toMatchObject({ prepared: "checkout", court: "Padel 1" });
    expect(new URL(b.url).searchParams.get("resource_id")).toBe(PADEL1);
  });

  const dayPage = "https://playtomic.com/clubs/the-padel-co?date=2026-10-11&sport=PADEL";
  const cases: [string, Parameters<typeof prepareBooking>[1], CheckoutCache | null][] = [
    ["no start of that length (120 minutes)", { ...MATCH, minutes: 120 }, cache()],
    ["no start at that time (18:30 for 60 minutes)", { ...MATCH, start: bkk("2026-10-11", "18:30"), minutes: 60 }, cache()],
    ["the later day's full read is older than the window", MATCH, cache({ fullAt: new Date(NOW.getTime() - CHECKOUT_FRESH_MS - MIN).toISOString() })],
    ["the cache was read from another link (the club moved)", MATCH, cache({ linkKey: linkKey("https://playtomic.com/clubs/another-club") })],
    ["the cache has no tenant id", MATCH, cache({ ref: undefined })],
    ["the last read failed", MATCH, cache({ error: "timeout" })],
    ["the times are not Playtomic's read", MATCH, cache({ source: "ics_bookings" })],
    ["the cache keeps no offers (the checkout was off, or its builder lost)", MATCH, cache({ offers: undefined })],
    ["no cache at all (the chat's card)", MATCH, null],
  ];
  for (const [why, slot, c] of cases) {
    it(`opens the club's day page when ${why}`, () => {
      expect(prepareBooking(directoryClub, slot, { cache: c, now: NOW })).toEqual({ url: dayPage, prepared: "slot", platform: "playtomic" });
    });
  }

  it("today's offers are as fresh as today's read, never as the full read", () => {
    const today = offersFromScrape([offer(PADEL1, "Padel 1", "2026-10-10", "18:00", 90)], { tz: TZ, days: DAYS, now: NOW })!;
    const slot = { ...MATCH, start: bkk("2026-10-10", "18:00"), court: null };
    expect(prepareBooking(directoryClub, slot, { cache: cache({ offers: today, fetchedAt: ago(20), fullAt: ago(200) }), now: NOW })?.prepared).toBe("checkout");
    expect(prepareBooking(directoryClub, slot, { cache: cache({ offers: today, fetchedAt: ago(91), fullAt: ago(5) }), now: NOW })?.prepared).toBe("slot");
  });

  it("a match already started gets the day page: nothing to book", () => {
    const later = new Date(MATCH.start.getTime() + MIN);
    expect(checkoutFor(directoryClub, cache({ fetchedAt: later.toISOString(), day: "2026-10-11", fullAt: later.toISOString() }), MATCH, later)).toBeNull();
  });

  it("the switch: off in the code, the day page everywhere", () => {
    const config = CHECKOUT.playtomic!;
    CHECKOUT.playtomic = { ...config, on: false };
    try {
      expect(prepareBooking(directoryClub, MATCH, { cache: cache(), now: NOW })?.prepared).toBe("slot");
    } finally {
      CHECKOUT.playtomic = config;
    }
  });

  it("a club nobody vetted gets nothing, checkout or not", () => {
    expect(prepareBooking({ ...directoryClub, source: "player" }, MATCH, { cache: cache(), now: NOW })).toBeNull();
  });
});

describe("the checkout builder on Playtomic's club page", () => {
  const BUILDER = readFileSync(path.join(import.meta.dirname, "fixtures/scrape/playtomic/checkout-builder.js"), "utf8");

  it("finds the builder as Playtomic wrote it on 11 October 2026, and nothing else", () => {
    expect(holdsCheckoutBuilder(BUILDER)).toBe(true);
    expect(holdsCheckoutBuilder(BUILDER.replace('"tenant_id"', '"tenantId"'))).toBe(false);
    expect(holdsCheckoutBuilder(BUILDER.replace("/api/web-app/payments", "/api/web-app/checkout"))).toBe(false);
    // The start written in the club's own zone would book another hour: that is a changed format too.
    expect(holdsCheckoutBuilder(BUILDER.replace("toUTC().toISO()", "toISO()"))).toBe(false);
    expect(holdsCheckoutBuilder("")).toBe(false);
  });

  it("lists the page's scripts in order, once each, and none from the page's data", () => {
    const html = `<script src="/_next/static/chunks/webpack-a5ebbac99cc22893.js" async=""></script><script src="/_next/static/chunks/7105-b679921c03870a3f.js" async=""></script><script src="/_next/static/chunks/7105-b679921c03870a3f.js"></script><script src="/_next/static/chunks/../../secret.js"></script><script>self.__next_f.push([1,"\\"static/chunks/9999-aaaaaaaaaaaaaaaa.js\\""])</script>`;
    expect(playtomicScripts(html)).toEqual(["/_next/static/chunks/webpack-a5ebbac99cc22893.js", "/_next/static/chunks/7105-b679921c03870a3f.js"]);
    expect(chunkNumber("/_next/static/chunks/7105-b679921c03870a3f.js")).toBe(7105);
    // The framework never builds a checkout; a script with the old figures goes first.
    expect(huntOrder(["/_next/static/chunks/webpack-a5ebbac99cc22893.js", "/_next/static/chunks/1403-c214edc856aac673.js", "/_next/static/chunks/7105-0000000000000000.js"], 7105, NOW)[0]).toBe("/_next/static/chunks/7105-0000000000000000.js");
  });

  describe("on a read of the club page", () => {
    const SG_PAGE = readFileSync(path.join(import.meta.dirname, "fixtures/scrape/playtomic/club-the-cage-padel-tribe.html"), "utf8");
    const SG_DAY = readFileSync(path.join(import.meta.dirname, "fixtures/scrape/playtomic/availability-the-cage-padel-tribe-2026-10-11.json"), "utf8");
    const KNOWN = "/_next/static/chunks/7105-b679921c03870a3f.js";
    const withScripts = (...paths: string[]) => SG_PAGE.replace("<body>", `<body>${paths.map((p) => `<script src="${p}" async=""></script>`).join("")}`);
    let calls: string[];
    const site = (page: string, scripts: Record<string, string> = {}) =>
      (async (input: RequestInfo | URL) => {
        const u = new URL(String(input));
        calls.push(u.pathname);
        if (u.pathname === "/clubs/the-cage-padel-tribe") return new Response(page, { status: 200 });
        if (u.pathname === "/api/clubs/availability") return new Response(u.searchParams.get("date") === "2026-10-11" ? SG_DAY : "[]", { status: 200 });
        if (u.pathname in scripts) return new Response(scripts[u.pathname], { status: 200 });
        return new Response("nope", { status: 404 });
      }) as typeof fetch;
    const target = (checkout: ScrapeTarget["checkout"], o: Partial<ScrapeTarget> = {}): ScrapeTarget => ({ clubSlug: "the-cage-padel-tribe", platform: "playtomic", bookingUrl: "https://playtomic.com/clubs/the-cage-padel-tribe", tz: "Asia/Singapore", days: 2, ...(checkout ? { checkout } : {}), ...o });
    const SG_NOW = new Date("2026-10-10T20:00:00Z");
    async function settle<T>(p: Promise<T>): Promise<T> {
      let done = false;
      p.then(
        () => (done = true),
        () => (done = true),
      );
      for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(250);
      return p;
    }
    beforeEach(() => {
      calls = [];
      resetPlaytomicState();
      vi.useFakeTimers();
      vi.setSystemTime(SG_NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
      resetPlaytomicState();
    });

    it("the known script still on the page: the same builder, and no request more", async () => {
      const r = await settle(playtomicAdapter.scrape(target({ builder: fnv1a(KNOWN), chunk: 7105, hunt: true }), site(withScripts("/_next/static/chunks/webpack-a5ebbac99cc22893.js", KNOWN)), SG_NOW));
      expect(r).toMatchObject({ ok: true, requests: 3, builder: { state: "same" } });
      expect(calls).toEqual(["/clubs/the-cage-padel-tribe", "/api/clubs/availability", "/api/clubs/availability"]);
    });

    it("the known script gone: the read looks in at most two of the page's scripts, the old figures first, and finds the new one", async () => {
      const moved = "/_next/static/chunks/7105-1111111111111111.js";
      const page = withScripts("/_next/static/chunks/webpack-a5ebbac99cc22893.js", "/_next/static/chunks/1403-c214edc856aac673.js", moved);
      const r = await settle(playtomicAdapter.scrape(target({ builder: fnv1a(KNOWN), chunk: 7105, hunt: true }), site(page, { [moved]: BUILDER }), SG_NOW));
      expect(r).toMatchObject({ ok: true, requests: 4, builder: { state: "found", key: fnv1a(moved), chunk: 7105 } });
      expect(calls.slice(3)).toEqual([moved]);
      // The times it read are all still there.
      expect(r.ok && r.slots.length).toBe(29);
    });

    it("no script builds it any more: lost, after two scripts at most, and the times kept", async () => {
      const page = withScripts("/_next/static/chunks/1403-c214edc856aac673.js", "/_next/static/chunks/1487-2393d161092c8d10.js", "/_next/static/chunks/1924-99221c4d4b22a41d.js");
      const r = await settle(playtomicAdapter.scrape(target({ builder: fnv1a(KNOWN), chunk: 7105, hunt: true }), site(page, { "/_next/static/chunks/1403-c214edc856aac673.js": "x", "/_next/static/chunks/1487-2393d161092c8d10.js": "y", "/_next/static/chunks/1924-99221c4d4b22a41d.js": "z" }), SG_NOW));
      expect(r).toMatchObject({ ok: true, requests: 5, builder: { state: "lost", checked: 2, of: 3 } });
      expect(r.ok && r.slots.length).toBe(29);
    });

    it("without leave to look, lost with no request; a read of today with the tenant id reads no page and checks nothing", async () => {
      const r = await settle(playtomicAdapter.scrape(target({ builder: fnv1a(KNOWN), chunk: 7105, hunt: false }), site(withScripts("/_next/static/chunks/1403-c214edc856aac673.js")), SG_NOW));
      expect(r).toMatchObject({ ok: true, requests: 3, builder: { state: "lost", checked: 0, of: 1 } });
      calls = [];
      const today = await settle(playtomicAdapter.scrape(target({ builder: fnv1a(KNOWN), chunk: 7105, hunt: true }, { days: 1, ref: "54a3fdba-ec4d-4e5c-97b9-149c3290d66c" }), site(withScripts(KNOWN)), SG_NOW));
      expect(today.ok && today.builder).toBeUndefined();
      expect(calls).toEqual(["/api/clubs/availability"]);
    });
  });
});

describe("the read keeps the offers, and only the match page reads them", () => {
  let db: Db;
  beforeEach(async () => {
    ({ db } = await createTestDb());
    delete process.env.SCRAPE_DISABLED;
  });
  afterEach(() => resetPlaytomicState());

  const PAGE = readFileSync(path.join(import.meta.dirname, "fixtures/scrape/playtomic/club-the-padel-co.html"), "utf8");
  const BUILDER = readFileSync(path.join(import.meta.dirname, "fixtures/scrape/playtomic/checkout-builder.js"), "utf8");
  const KNOWN = CHECKOUT.playtomic!.builder;
  /** Playtomic's answer for a day of The Padel Co.: Padel 2 free at 18:00 Bangkok for 60 and 90 minutes, Padel 1 at 18:30 for 90. */
  const dayOf = (date: string) =>
    JSON.stringify([
      { resource_id: PADEL2, start_date: date, slots: [{ start_time: "11:00:00", duration: 60, price: "1000 THB" }, { start_time: "11:00:00", duration: 90, price: "1500 THB" }] },
      { resource_id: PADEL1, start_date: date, slots: [{ start_time: "11:30:00", duration: 90, price: "1500 THB" }] },
    ]);
  type World = { calls: string[]; fetchImpl: typeof fetch; clock: Clock };
  const world = (page: string, scripts: Record<string, string> = {}, answer: (date: string) => string = dayOf): World => {
    let t = 0.25;
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      calls.push(u.pathname);
      t += 200.123;
      if (u.pathname === "/clubs/the-padel-co") return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
      if (u.pathname === "/api/clubs/availability") return new Response(answer(u.searchParams.get("date")!), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname in scripts) return new Response(scripts[u.pathname], { status: 200 });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    return { calls, fetchImpl, clock: { now: () => t, sleep: async (ms) => void (t += ms) } };
  };
  const withScripts = (...paths: string[]) => PAGE.replace("<body>", `<body>${paths.map((p) => `<script src="${p}" async=""></script>`).join("")}`);
  /** The reader keeps its own second between requests on `Date.now()`: move that clock on, so no real second passes. */
  const wallClock = () => {
    let wall = NOW.getTime();
    return vi.spyOn(Date, "now").mockImplementation(() => (wall += 5_000));
  };
  const seed = () => db.insert(clubs).values({ slug: "the-padel-co", name: "The Padel Co", manageToken: "tok-the-padel-co-abcdefghijklmnop", source: "directory", tz: TZ, website: LINK, bookingPlatform: "playtomic" });
  const row = async () => (await db.select().from(clubs).where(eq(clubs.slug, "the-padel-co")))[0];
  const metric = async (key: string) => Number((await db.select().from(metricsDaily).where(and(eq(metricsDaily.key, key), eq(metricsDaily.day, "2026-10-10"))))[0]?.value ?? 0);
  const run = async (w: World, now = NOW, adapter: AvailabilityAdapter = playtomicAdapter) => {
    const spy = wallClock();
    try {
      return await runScrape(db, now, { adapters: [adapter], fetchImpl: w.fetchImpl, clock: w.clock });
    } finally {
      spy.mockRestore();
    }
  };

  it("a full read keeps the exact starts; no list and no club page reads them; the match page fills the checkout from them", async () => {
    await seed();
    const r = await run(world(withScripts(KNOWN)));
    expect(r.platforms.playtomic).toMatchObject({ ok: 1, checkout: "on" });
    const a = (await row()).availability!;
    expect(offeredCourts(a.offers, TZ, bkk("2026-10-11", "18:00"), 90)).toEqual([{ id: PADEL2, name: "Padel 2" }]);
    expect(offeredCourts(a.offers, TZ, bkk("2026-10-12", "18:30"), 90)).toEqual([{ id: PADEL1, name: "Padel 1" }]);
    // Rule 12: the lists, the club page and the API's club leave them in the database.
    const listed = (await listShownClubs(db, null, 400, NOW)).find((c) => c.slug === "the-padel-co")!;
    expect(listed.availability).not.toHaveProperty("offers");
    expect((await getClubWithCache(db, "the-padel-co"))!.availability).not.toHaveProperty("offers");
    expect((await getClubWithCache(db, "the-padel-co"))!.availability!.slots.length).toBeGreaterThan(0);
    // The match page's one read: the head of the cache with the offers, never the slots.
    const forBooking = (await getClubForBooking(db, "the-padel-co", { cache: true }))!;
    expect(forBooking.cache).not.toHaveProperty("slots");
    const b = prepareBooking(forBooking, MATCH, { cache: forBooking.cache, now: NOW })!;
    expect(b.prepared).toBe("checkout");
    expect(Object.fromEntries(new URL(b.url).searchParams)).toMatchObject({ tenant_id: TENANT, resource_id: PADEL2, duration: "90" });
    // A match too far out reads no cache at all.
    expect((await getClubForBooking(db, "the-padel-co", { cache: false }))!.cache).toBeNull();
  });

  it("a read of today alone replaces today's offers and keeps the later days' from the row, names included", async () => {
    await seed();
    await run(world(withScripts(KNOWN)));
    const full = (await row()).availability!;
    // Fifteen minutes on, in a new function instance: today alone, with the tenant id (no page, no names).
    resetPlaytomicState();
    const later = new Date(NOW.getTime() + 15 * MIN);
    const w = world(withScripts(KNOWN));
    await run(w, later);
    expect(w.calls).toEqual(["/api/clubs/availability"]);
    const a = (await row()).availability!;
    expect(a.fullAt).toBe(full.fullAt);
    expect(a.offers!.days["2026-10-11"]).toEqual(full.offers!.days["2026-10-11"]);
    expect(a.offers!.days["2026-10-12"]).toEqual(full.offers!.days["2026-10-12"]);
    expect(a.offers!.courts).toEqual(full.offers!.courts);
    expect(offeredCourts(a.offers, TZ, bkk("2026-10-10", "18:00"), 60)).toEqual([{ id: PADEL2, name: "Padel 2" }]);
  });

  it("a read of today alone over a row with no offers yet has no names: a match on a named court gets the day page, never another court", async () => {
    // The row as the code before the offers wrote it (and as a checkout switched back on finds it): a
    // clean full read 20 minutes ago, with the tenant id and the link's key, and no offers to lend names.
    await seed();
    const before: ClubAvailability = { fetchedAt: ago(20), day: "2026-10-10", days: DAYS, tz: TZ, source: "scrape:playtomic", platform: "playtomic", slots: [], error: null, fullAt: ago(20), ref: TENANT, linkKey: linkKey(LINK) };
    await db.update(clubs).set({ availability: before, availabilityAt: new Date(NOW.getTime() - 20 * MIN) }).where(eq(clubs.slug, "the-padel-co"));
    // Tonight, 18:00 in Bangkok (11:00 UTC), both courts are free for 90 minutes.
    const both = (date: string) => JSON.stringify([PADEL2, PADEL1].map((id) => ({ resource_id: id, start_date: date, slots: [{ start_time: "11:00:00", duration: 90, price: "1500 THB" }] })));
    const w = world(withScripts(KNOWN), {}, both);
    await run(w);
    expect(w.calls).toEqual(["/api/clubs/availability"]);
    const c = (await getClubForBooking(db, "the-padel-co", { cache: true }))!;
    const tonight = bkk("2026-10-10", "18:00");
    expect(offeredCourts(c.cache!.offers, TZ, tonight, 90).map((x) => x.name)).toEqual([null, null]);
    const dayPage = { url: "https://playtomic.com/clubs/the-padel-co?date=2026-10-10&sport=PADEL", prepared: "slot", platform: "playtomic" };
    // The match is on court 1: the lowest id is Padel 2, which the page could not even name.
    expect(prepareBooking(c, { start: tonight, minutes: 90, tz: TZ, court: "1" }, { cache: c.cache, now: NOW })).toEqual(dayPage);
    expect(prepareBooking(c, { start: tonight, minutes: 90, tz: TZ, court: null }, { cache: c.cache, now: NOW })).toEqual(dayPage);
  });

  it("the builder gone from the page: no offers kept, the state and a counter say so; found again in a new script, the offers come back", async () => {
    await seed();
    // The page no longer loads the known script, and none of its scripts builds the link.
    const page = withScripts("/_next/static/chunks/1403-c214edc856aac673.js", "/_next/static/chunks/7105-1111111111111111.js");
    const r = await run(world(page, { "/_next/static/chunks/1403-c214edc856aac673.js": "x", "/_next/static/chunks/7105-1111111111111111.js": "y" }));
    expect(r.platforms.playtomic).toMatchObject({ ok: 1, checkout: "lost" });
    expect((await row()).availability).not.toHaveProperty("offers");
    expect((await row()).availability!.slots.length).toBeGreaterThan(0);
    expect(await metric("checkout_builder_lost_playtomic")).toBe(1);
    expect(await metric("checkout_lost_playtomic")).toBe(1);
    // The owner's service board says so on the platform's line.
    expect((await scrapeBoard(db, NOW, [playtomicAdapter]))[0]).toMatchObject({ platform: "playtomic", checkout: "lost" });
    // An hour on, in a new function instance, a full read finds a new build whose script builds the link again.
    resetPlaytomicState();
    const moved = "/_next/static/chunks/7105-2222222222222222.js";
    const back = await run(world(withScripts("/_next/static/chunks/1403-c214edc856aac673.js", moved), { "/_next/static/chunks/1403-c214edc856aac673.js": "x", [moved]: BUILDER }), new Date(NOW.getTime() + 61 * MIN));
    expect(back.platforms.playtomic).toMatchObject({ checkout: "on" });
    expect(await metric("checkout_builder_lost_playtomic")).toBe(0);
    expect(await metric("checkout_found_playtomic")).toBe(1);
    expect(await metric("checkout_builder_playtomic")).toBe(fnv1a(moved));
    expect(offeredCourts((await row()).availability!.offers, TZ, bkk("2026-10-11", "18:00"), 90)).toHaveLength(1);
  });

  it("a read that times out over a good read keeps that read, and drops its offers while the checkout is off", async () => {
    await seed();
    await run(world(withScripts(KNOWN)));
    expect((await row()).availability).toHaveProperty("offers");
    // The owner switches the checkout off; the club's next read times out (review, 11 October 2026).
    await setMetric(db, "checkout_off_playtomic", 1, "2026-10-10");
    const timeout: ScrapeResult = { ok: false, status: null, reason: "timeout", requests: 1, detail: "availability 2026-10-10: TimeoutError" };
    const slow: AvailabilityAdapter = { ...playtomicAdapter, scrape: async (t, f) => (await f(t.bookingUrl), timeout) };
    const later = new Date(NOW.getTime() + 20 * MIN);
    const r = await run(world(withScripts(KNOWN)), later, slow);
    expect(r.failed).toEqual([{ slug: "the-padel-co", platform: "playtomic", error: "timeout", why: "availability 2026-10-10: TimeoutError" }]);
    // The good read stays, its times included, and its offers go.
    const a = (await row()).availability!;
    expect(a).toMatchObject({ error: null, fullAt: NOW.toISOString() });
    expect(a.slots.length).toBeGreaterThan(0);
    expect(a).not.toHaveProperty("offers");
    const c = (await getClubForBooking(db, "the-padel-co", { cache: true }))!;
    expect(prepareBooking(c, MATCH, { cache: c.cache, now: later })?.prepared).toBe("slot");
  });

  it("the switch row turns the checkout off with no deploy: no offers, and no look for a builder", async () => {
    await seed();
    await setMetric(db, "checkout_off_playtomic", 1, "2026-10-01");
    const w = world(withScripts("/_next/static/chunks/1403-c214edc856aac673.js"), { "/_next/static/chunks/1403-c214edc856aac673.js": "x" });
    const r = await run(w);
    expect(r.platforms.playtomic).toMatchObject({ ok: 1, checkout: "off" });
    expect(w.calls.filter((p) => p.endsWith(".js"))).toEqual([]);
    expect((await row()).availability).not.toHaveProperty("offers");
    const c = (await getClubForBooking(db, "the-padel-co", { cache: true }))!;
    expect(prepareBooking(c, MATCH, { cache: c.cache, now: NOW })?.prepared).toBe("slot");
  });
});

/** Keeps a hand-written row's shape honest: a cache written before the offers existed still reads. */
describe("a cache from before the offers", () => {
  it("gives the day page, never an error", () => {
    const old: ClubAvailability = { fetchedAt: ago(5), day: "2026-10-10", days: DAYS, tz: TZ, slots: [], error: null, source: "scrape:playtomic", fullAt: ago(5), ref: TENANT, linkKey: linkKey(LINK) };
    expect(prepareBooking(directoryClub as Pick<Club, "bookingUrl" | "bookingPlatform" | "website" | "tz" | "source" | "approvedAt" | "rejectedAt">, MATCH, { cache: old, now: NOW })?.prepared).toBe("slot");
    expect(offeredCourts({ courts: { x: "nope" }, days: { "2026-10-11": { x: 3 } } } as never, TZ, MATCH.start, 90)).toEqual([]);
  });
});
