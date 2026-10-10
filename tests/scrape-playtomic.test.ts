import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_REQUESTS, MIN_GAP_MS, parsePlaytomicAvailability, parsePlaytomicClubPage, PLAYTOMIC_UA, playtomicAdapter, playtomicBookUrl, playtomicClubPage, playtomicDay, REQUEST_TIMEOUT_MS, resetPlaytomicState } from "@/lib/booking/adapters/playtomic";
import type { ScrapeTarget } from "@/lib/booking/adapters/types";
import { PLATFORMS } from "@/lib/booking/platforms";
import { todaySlots } from "@/lib/booking/availability";
import { availabilityFrom, ScrapeStop } from "@/lib/booking/scrape";
import { utcToZonedParts } from "@/lib/dates";
import { freeCourtHours } from "@/lib/domain/clubs";

/**
 * Fixtures are real anonymous responses from 10 October 2026, trimmed to what the parser reads:
 * the club page keeps only its tenant object (no images, no club properties), the availability
 * keeps every slot for The Cage (Singapore, opens 07:00, so its day starts at 23:00 UTC the day
 * before) and the first four per court for The Padel Co. (Bangkok). No person appears in either.
 */
const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "fixtures/scrape/playtomic", name), "utf8");
const BKK_PAGE = fixture("club-the-padel-co.html");
const BKK_DAY = fixture("availability-the-padel-co-2026-10-11.json");
const SG_PAGE = fixture("club-the-cage-padel-tribe.html");
const SG_DAY = fixture("availability-the-cage-padel-tribe-2026-10-11.json");

const BKK = { tenantId: "b692a586-2e22-4fca-add7-272f73c98aa7", padel1: "30d9f634-9ef5-4ce2-b69b-037bb7d15701", padel2: "27648c80-eebf-448c-b0de-2166165b00cc" };
const SG = { tenantId: "54a3fdba-ec4d-4e5c-97b9-149c3290d66c" };

describe("parsePlaytomicClubPage", () => {
  it("reads the tenant, the time zone and the courts of a Bangkok club", () => {
    expect(parsePlaytomicClubPage(BKK_PAGE)).toEqual({
      tenantId: BKK.tenantId,
      slug: "the-padel-co",
      name: "the padel co. - BKK",
      timezone: "Asia/Bangkok",
      courts: [
        { id: BKK.padel1, name: "Padel 1", sport: "PADEL" },
        { id: BKK.padel2, name: "Padel 2", sport: "PADEL" },
      ],
    });
  });

  it("reads a Singapore club with four named courts", () => {
    const club = parsePlaytomicClubPage(SG_PAGE);
    expect(club?.tenantId).toBe(SG.tenantId);
    expect(club?.timezone).toBe("Asia/Singapore");
    expect(club?.courts.map((c) => c.name)).toEqual(["CMC Court (Center Green Court)", "Purple Court", "Terracotta Court", "Blue Court"]);
  });

  it("says null, not an empty club, when the page no longer carries the tenant", () => {
    expect(parsePlaytomicClubPage("<html><body>Hello</body></html>")).toBeNull();
    expect(parsePlaytomicClubPage(BKK_PAGE.replaceAll("tenant_id", "tenantUuid"))).toBeNull();
    expect(parsePlaytomicClubPage(BKK_PAGE.replaceAll("resourceId", "resource_uuid"))).toBeNull();
  });
});

describe("parsePlaytomicAvailability", () => {
  const club = parsePlaytomicClubPage(BKK_PAGE)!;
  const row = (start: string, end: string, court: string, price: string) => `${start} ${end} ${court} ${price}`;

  // On a machine whose own zone is not UTC, as on a laptop in Bangkok, a time read as local instead of UTC
  // gives the wrong instant. Vercel and CI run in UTC and could not see it, so the parser also runs in a
  // child process that starts in Asia/Bangkok, and must give exactly the instants it gives here.
  it("gives the same instants on a machine whose own zone is not UTC", () => {
    const run = spawnSync(path.join(process.cwd(), "node_modules/.bin/tsx"), [path.join(import.meta.dirname, "helpers/playtomic-in-zone.ts")], {
      encoding: "utf8",
      env: { ...process.env, TZ: "Asia/Bangkok" },
      timeout: 60_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const there = JSON.parse(run.stdout) as { hostMidnight: string; slots: string[][] | null };
    // The child really is in Bangkok: its own midnight is 17:00 UTC the day before.
    expect(there.hostMidnight).toBe("2026-10-10T17:00:00.000Z");
    const here = parsePlaytomicAvailability(BKK_DAY, club)!.map((s) => [s.start, s.end, s.court]);
    expect(there.slots).toEqual(here);
  });

  it("turns the Bangkok response into exact UTC slots, one per court, start and duration", () => {
    const slots = parsePlaytomicAvailability(BKK_DAY, club)!;
    expect(slots.map((s) => row(s.start, s.end, s.court!, s.priceText!))).toEqual([
      row("2026-10-11T00:00:00.000Z", "2026-10-11T01:00:00.000Z", "Padel 2", "1000 THB"),
      row("2026-10-11T00:00:00.000Z", "2026-10-11T01:30:00.000Z", "Padel 2", "1500 THB"),
      row("2026-10-11T00:00:00.000Z", "2026-10-11T02:00:00.000Z", "Padel 2", "2000 THB"),
      row("2026-10-11T01:00:00.000Z", "2026-10-11T02:00:00.000Z", "Padel 2", "1000 THB"),
      row("2026-10-11T00:00:00.000Z", "2026-10-11T01:00:00.000Z", "Padel 1", "1000 THB"),
      row("2026-10-11T00:00:00.000Z", "2026-10-11T01:30:00.000Z", "Padel 1", "1500 THB"),
      row("2026-10-11T00:00:00.000Z", "2026-10-11T02:00:00.000Z", "Padel 1", "2000 THB"),
      row("2026-10-11T01:00:00.000Z", "2026-10-11T02:00:00.000Z", "Padel 1", "1000 THB"),
    ]);
    expect(slots.every((s) => s.free)).toBe(true);
    // 00:00 UTC is 07:00 in Bangkok, the hour the page says the club opens.
    expect(utcToZonedParts(new Date(slots[0].start), "Asia/Bangkok")).toEqual({ date: "2026-10-11", time: "07:00" });
  });

  it("gives each slot the link the page's own Continue button opens", () => {
    const [first] = parsePlaytomicAvailability(BKK_DAY, club)!;
    expect(first.bookUrl).toBe(
      "https://playtomic.com/api/web-app/payments?type=CUSTOMER_MATCH&tenant_id=b692a586-2e22-4fca-add7-272f73c98aa7&resource_id=27648c80-eebf-448c-b0de-2166165b00cc&start=2026-10-11T00%3A00%3A00.000Z&duration=60&sport_id=PADEL",
    );
    expect(first.bookUrl).toBe(playtomicBookUrl(BKK.tenantId, BKK.padel2, new Date("2026-10-11T00:00:00Z"), 60));
  });

  it("keeps a Singapore day that starts before midnight UTC on the right instants", () => {
    const sg = parsePlaytomicClubPage(SG_PAGE)!;
    const slots = parsePlaytomicAvailability(SG_DAY, sg)!;
    expect(slots).toHaveLength(29);
    const early = slots.filter((s) => s.start.startsWith("2026-10-10"));
    expect(early.map((s) => row(s.start, s.end, s.court!, s.priceText!))).toEqual([
      row("2026-10-10T23:00:00.000Z", "2026-10-11T00:00:00.000Z", "CMC Court (Center Green Court)", "100 SGD"),
      row("2026-10-10T23:00:00.000Z", "2026-10-11T00:00:00.000Z", "Terracotta Court", "100 SGD"),
      row("2026-10-10T23:00:00.000Z", "2026-10-11T00:00:00.000Z", "Blue Court", "100 SGD"),
      row("2026-10-10T23:00:00.000Z", "2026-10-11T00:00:00.000Z", "Purple Court", "100 SGD"),
    ]);
    // 23:00 UTC on the 10th is 07:00 on the 11th in Singapore: the opening hour, on the day asked for.
    for (const s of slots) expect(utcToZonedParts(new Date(s.start), "Asia/Singapore").date).toBe("2026-10-11");
    const purple = slots.filter((s) => s.court === "Purple Court").map((s) => row(s.start, s.end, s.court!, s.priceText!));
    expect(purple).toEqual([
      row("2026-10-11T06:30:00.000Z", "2026-10-11T08:00:00.000Z", "Purple Court", "150 SGD"),
      row("2026-10-11T11:00:00.000Z", "2026-10-11T12:00:00.000Z", "Purple Court", "100 SGD"),
      row("2026-10-11T13:30:00.000Z", "2026-10-11T15:00:00.000Z", "Purple Court", "150 SGD"),
      row("2026-10-10T23:00:00.000Z", "2026-10-11T00:00:00.000Z", "Purple Court", "100 SGD"),
    ]);
  });

  it("falls back to the court's id when the page did not name it", () => {
    const slots = parsePlaytomicAvailability(BKK_DAY, { tenantId: BKK.tenantId, courts: [] })!;
    expect(slots[0].court).toBe(BKK.padel2);
  });

  it("says null (changed) when the fields it reads are gone, and [] for a day with nothing free", () => {
    expect(parsePlaytomicAvailability("not json", club)).toBeNull();
    expect(parsePlaytomicAvailability('{"slots":[]}', club)).toBeNull();
    expect(parsePlaytomicAvailability(BKK_DAY.replaceAll('"start_time"', '"startTime"'), club)).toBeNull();
    expect(parsePlaytomicAvailability(BKK_DAY.replaceAll('"resource_id"', '"resourceId"'), club)).toBeNull();
    expect(parsePlaytomicAvailability(BKK_DAY.replaceAll('"duration":60', '"duration":"60"'), club)).toBeNull();
    expect(parsePlaytomicAvailability("[]", club)).toEqual([]);
  });
});

/**
 * What the cache keeps from a Playtomic day. Playtomic lists every free start once for each length it
 * offers (60, 90, 120) and a new start every 30 minutes, so one free hour of one court is many rows.
 * The cache keeps the union of each court's free time, cut where the count of free courts changes,
 * so a court-hour counts once and every start is unique (readers F1, job F5, docs-rules F1).
 */
describe("the cache a Playtomic day becomes", () => {
  const club = parsePlaytomicClubPage(BKK_PAGE)!;
  // 03:00 on Sunday 11 October in Bangkok: the whole fixture day is still to come.
  const NOW = new Date("2026-10-10T20:00:00Z");

  /**
   * A full day as Playtomic writes it for The Padel Co. (2 courts, open 07:00-22:00 Bangkok, which is
   * 00:00-15:00 UTC): a start every 30 minutes, each length that fits before closing. Padel 2 is booked
   * 10:00-11:30 Bangkok (03:00-04:30 UTC), so no slot of it touches that time.
   */
  const fullDay = () => {
    const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:00`;
    const court = (id: string, busy: [number, number] | null) => ({
      resource_id: id,
      start_date: "2026-10-11",
      slots: Array.from({ length: 29 }, (_, i) => i * 30).flatMap((start) =>
        [60, 90, 120].filter((d) => start + d <= 15 * 60 && !(busy && start < busy[1] && start + d > busy[0])).map((d) => ({ start_time: hm(start), duration: d, price: `${d * 17} THB` })),
      ),
    });
    return JSON.stringify([court(BKK.padel1, null), court(BKK.padel2, [180, 270])]);
  };

  const cacheOf = (text: string) => availabilityFrom({ ok: true, slots: parsePlaytomicAvailability(text, club)!, requests: 2 }, { platform: "playtomic", tz: "Asia/Bangkok", now: NOW });

  it("counts each court-hour once: at most courts x opening hours", () => {
    const raw = parsePlaytomicAvailability(fullDay(), club)!;
    expect(raw.length).toBeGreaterThan(100); // what the page lists: every start at every length
    const a = cacheOf(fullDay());
    // 07:00-10:00 both courts, 10:00-11:30 one, 11:30-22:00 both: 6 + 1.5 + 21.
    expect(a.slots).toEqual([
      { start: "2026-10-11T00:00:00.000Z", end: "2026-10-11T03:00:00.000Z", free: 2 },
      { start: "2026-10-11T03:00:00.000Z", end: "2026-10-11T04:30:00.000Z", free: 1 },
      { start: "2026-10-11T04:30:00.000Z", end: "2026-10-11T15:00:00.000Z", free: 2 },
    ]);
    const hours = freeCourtHours({ availability: a }, NOW)!;
    expect(hours).toBe(28.5);
    expect(hours).toBeLessThanOrEqual(2 * 15);
  });

  it("gives every start once, no row overlaps the next, and keeps no link, price or court name", () => {
    const a = cacheOf(fullDay());
    const today = todaySlots(a, NOW);
    expect(new Set(today.map((s) => s.start)).size).toBe(today.length);
    for (let i = 1; i < a.slots.length; i++) expect(a.slots[i].start >= a.slots[i - 1].end).toBe(true);
    for (const s of a.slots) expect(Object.keys(s).sort()).toEqual(["end", "free", "start"]);
  });

  it("the real fixtures: 4 court-hours at The Padel Co., 21.5 at The Cage", () => {
    expect(freeCourtHours({ availability: cacheOf(BKK_DAY) }, NOW)).toBe(4);
    const sg = parsePlaytomicClubPage(SG_PAGE)!;
    const cage = availabilityFrom({ ok: true, slots: parsePlaytomicAvailability(SG_DAY, sg)!, requests: 2 }, { platform: "playtomic", tz: "Asia/Singapore", now: NOW });
    expect(freeCourtHours({ availability: cage }, NOW)).toBe(21.5);
    const starts = todaySlots(cage, NOW).map((s) => s.start);
    expect(new Set(starts).size).toBe(starts.length);
  });
});

describe("playtomicAdapter.matches", () => {
  const clubsJson = JSON.parse(readFileSync(path.join(import.meta.dirname, "../data/clubs.json"), "utf8")) as { clubs: { website: string | null }[] };
  const realLinks = clubsJson.clubs.map((c) => c.website).filter((w): w is string => !!w && w.includes("playtomic"));

  it("knows its platform id", () => {
    expect(PLATFORMS.some((p) => p.id === playtomicAdapter.platform)).toBe(true);
  });

  it("accepts every Playtomic club link in data/clubs.json", () => {
    expect(realLinks.length).toBeGreaterThan(10);
    for (const link of realLinks) expect([link, playtomicAdapter.matches(link)]).toEqual([link, true]);
  });

  it("accepts the other forms a club page takes, and canonicalises them", () => {
    expect(playtomicClubPage("https://playtomic.io/clubs/the-padel-co")).toBe("https://playtomic.com/clubs/the-padel-co");
    expect(playtomicClubPage("https://www.playtomic.com/es/clubs/The-Padel-Co?utm_source=x")).toBe("https://playtomic.com/clubs/the-padel-co");
    expect(playtomicClubPage("https://playtomic.io/the-padel-co/b692a586-2e22-4fca-add7-272f73c98aa7")).toBe("https://playtomic.io/the-padel-co/b692a586-2e22-4fca-add7-272f73c98aa7");
  });

  it("refuses other platforms, club sites, the app and look-alike hosts", () => {
    for (const link of [
      "https://www.matchi.se/facilities/padelcenter",
      "https://nodramapadel.com/",
      "https://playtomic.com/",
      "https://playtomic.com/clubs",
      "https://playtomic.com/clubs/the-padel-co/academy/public-classes",
      "https://app.playtomic.io/tenant/b692a586-2e22-4fca-add7-272f73c98aa7",
      "https://playtomic.com.evil.example/clubs/the-padel-co",
      "https://notplaytomic.com/clubs/the-padel-co",
      "ftp://playtomic.com/clubs/the-padel-co",
      "javascript:alert(1)",
      "not a link",
    ])
      expect([link, playtomicAdapter.matches(link)]).toEqual([link, false]);
  });
});

describe("playtomicAdapter.scrape", () => {
  type Call = { url: string; ua: string | null; at: number };
  let calls: Call[];

  /** A fetch that answers from `route` and records what was asked, and when. */
  const stubFetch = (route: (url: URL) => Response | Promise<Response>) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ua: new Headers(init?.headers).get("user-agent"), at: Date.now() });
      return route(new URL(url));
    }) as typeof fetch;

  const site = (days: Record<string, string>, page = SG_PAGE) =>
    stubFetch((u) => {
      if (u.pathname === "/clubs/the-cage-padel-tribe") return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
      if (u.pathname === "/api/clubs/availability") return new Response(days[u.searchParams.get("date")!] ?? "[]", { status: 200, headers: { "content-type": "application/json" } });
      return new Response("nope", { status: 404 });
    });

  const target = (o: Partial<ScrapeTarget> = {}): ScrapeTarget => ({ clubSlug: "the-cage-padel-tribe", platform: "playtomic", bookingUrl: "https://playtomic.com/clubs/the-cage-padel-tribe", tz: "Asia/Singapore", days: 2, ...o });

  /** 04:00 on 11 October in Singapore: the club's local day is the fixture's day. */
  const NOW = new Date("2026-10-10T20:00:00Z");

  /** Runs the scrape to the end with fake timers (the pacing and the timeout are timers). */
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
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    resetPlaytomicState();
  });

  it("reads the club page once, then one day per request, honestly named and a second apart", async () => {
    const r = await settle(playtomicAdapter.scrape(target(), site({ "2026-10-11": SG_DAY }), NOW));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.requests).toBe(3);
    expect(calls.map((c) => c.url)).toEqual([
      "https://playtomic.com/clubs/the-cage-padel-tribe",
      "https://playtomic.com/api/clubs/availability?tenant_id=54a3fdba-ec4d-4e5c-97b9-149c3290d66c&date=2026-10-11&sport_id=PADEL",
      "https://playtomic.com/api/clubs/availability?tenant_id=54a3fdba-ec4d-4e5c-97b9-149c3290d66c&date=2026-10-12&sport_id=PADEL",
    ]);
    expect(calls.every((c) => c.ua === PLAYTOMIC_UA)).toBe(true);
    for (let i = 1; i < calls.length; i++) expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(MIN_GAP_MS);
    expect(r.slots).toHaveLength(29);
    expect(r.slots[0]).toEqual({
      start: "2026-10-10T23:00:00.000Z",
      end: "2026-10-11T00:00:00.000Z",
      court: "Blue Court",
      courtId: "d4a841b2-6c90-450d-aeb6-df5c31f9fea9",
      free: true,
      priceText: "100 SGD",
      bookUrl: playtomicBookUrl(SG.tenantId, "d4a841b2-6c90-450d-aeb6-df5c31f9fea9", new Date("2026-10-10T23:00:00Z"), 60),
    });
    const starts = r.slots.map((s) => s.start);
    expect([...starts].sort()).toEqual(starts);
  });

  it("drops what has already started, and keeps the club page for the next run", async () => {
    const later = new Date("2026-10-11T06:00:00Z");
    vi.setSystemTime(later);
    const r = await settle(playtomicAdapter.scrape(target({ days: 1 }), site({ "2026-10-11": SG_DAY }), later));
    expect(r.ok && r.slots.every((s) => s.start > later.toISOString())).toBe(true);
    expect(r.ok && r.slots.length).toBe(13);
    calls = [];
    const again = await settle(playtomicAdapter.scrape(target({ days: 1 }), site({ "2026-10-11": SG_DAY }), later));
    expect(again.ok && again.requests).toBe(1);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/clubs/availability"]);
  });

  it("never makes more than eight requests, however many days are asked for", async () => {
    const r = await settle(playtomicAdapter.scrape(target({ days: 30 }), site({}), NOW));
    expect(r.requests).toBe(MAX_REQUESTS);
    expect(calls).toHaveLength(MAX_REQUESTS);
    expect(new URL(calls.at(-1)!.url).searchParams.get("date")).toBe(playtomicDay(NOW, "Asia/Singapore", 6));
  });

  it("stops at 403 on the club page and calls it blocked", async () => {
    const r = await settle(playtomicAdapter.scrape(target(), stubFetch(() => new Response("Forbidden", { status: 403 })), NOW));
    expect(r).toEqual({ ok: false, status: 403, reason: "blocked", requests: 1, detail: "club page: HTTP 403" });
    expect(calls).toHaveLength(1);
  });

  it("stops at 429 mid-run and asks nothing more", async () => {
    const fetchImpl = stubFetch((u) => (u.pathname.startsWith("/clubs/") ? new Response(SG_PAGE, { status: 200 }) : new Response("Too Many Requests", { status: 429 })));
    const r = await settle(playtomicAdapter.scrape(target({ days: 5 }), fetchImpl, NOW));
    expect(r).toMatchObject({ ok: false, status: 429, reason: "blocked", requests: 2 });
    expect(calls).toHaveLength(2);
  });

  it("calls a 404 not_found", async () => {
    const r = await settle(playtomicAdapter.scrape(target({ bookingUrl: "https://playtomic.com/clubs/gone-club" }), site({}), NOW));
    expect(r).toEqual({ ok: false, status: 404, reason: "not_found", requests: 1, detail: "club page: HTTP 404" });
  });

  it("calls a body without the fields it reads changed, for the page and for the availability", async () => {
    const page = await settle(playtomicAdapter.scrape(target(), site({}, "<html><body>New design</body></html>"), NOW));
    expect(page).toMatchObject({ ok: false, status: 200, reason: "changed", requests: 1 });
    resetPlaytomicState();
    const day = await settle(playtomicAdapter.scrape(target(), site({ "2026-10-11": '{"availability":[]}' }), NOW));
    expect(day).toMatchObject({ ok: false, status: 200, reason: "changed", requests: 2 });
  });

  it("gives up on a request after ten seconds and calls it a timeout", async () => {
    const hang = stubFetch(
      () =>
        new Promise<Response>(() => {
          /* never answers */
        }),
    );
    const started = Date.now();
    const r = await settle(playtomicAdapter.scrape(target(), hang, NOW));
    expect(r).toMatchObject({ ok: false, status: null, reason: "timeout", requests: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(REQUEST_TIMEOUT_MS);
    expect(Date.now() - started).toBeLessThan(REQUEST_TIMEOUT_MS + 1_000);
  });

  it("calls the frame's own abort a timeout, never an error", async () => {
    const aborted = stubFetch(() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
    const r = await settle(playtomicAdapter.scrape(target(), aborted, NOW));
    expect(r).toMatchObject({ ok: false, status: null, reason: "timeout", requests: 1 });
  });

  it("hands the frame's own stop back to the frame rather than calling it the club's error", async () => {
    const stopped = stubFetch(() => Promise.reject(new ScrapeStop("cap")));
    await expect(settle(playtomicAdapter.scrape(target(), stopped, NOW))).rejects.toBeInstanceOf(ScrapeStop);
  });

  it("reads the club's days in the page's own zone when the club row has none, and says which zone it used", async () => {
    // 20:00 UTC on the 10th is already the 11th in Singapore: a reader that guessed UTC would ask for the 10th.
    const r = await settle(playtomicAdapter.scrape(target({ tz: null }), site({ "2026-10-11": SG_DAY }), NOW));
    expect(r).toMatchObject({ ok: true, tz: "Asia/Singapore" });
    expect(calls.slice(1).map((c) => new URL(c.url).searchParams.get("date"))).toEqual(["2026-10-11", "2026-10-12"]);
  });

  it("gives up with 'no time zone' when neither the club row nor the page names one", async () => {
    const page = SG_PAGE.replaceAll("Asia/Singapore", "Somewhere/Else");
    expect(page).not.toBe(SG_PAGE);
    const r = await settle(playtomicAdapter.scrape(target({ tz: null }), site({}, page), NOW));
    expect(r).toEqual({ ok: false, status: null, reason: "error", requests: 1, detail: "no time zone" });
  });

  it("reports a network error as error, and makes no request for a link that is not Playtomic's", async () => {
    // The error's class and the network's code, never its message, which may carry a link.
    const r = await settle(playtomicAdapter.scrape(target(), stubFetch(() => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }))), NOW));
    expect(r).toEqual({ ok: false, status: null, reason: "error", requests: 1, detail: "club page: TypeError ECONNRESET" });
    calls = [];
    const other = await settle(playtomicAdapter.scrape(target({ bookingUrl: "https://www.matchi.se/facilities/x" }), site({}), NOW));
    expect(other).toMatchObject({ ok: false, reason: "error", requests: 0 });
    expect(calls).toHaveLength(0);
  });
});
