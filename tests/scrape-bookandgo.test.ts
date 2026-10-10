import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPTERS, adapterFor } from "@/lib/booking/adapters";
import {
  BOOKANDGO_MAX_REQUESTS,
  BOOKANDGO_TIMEOUT_MS,
  BOOKANDGO_USER_AGENT,
  bookandgoAdapter,
  bookandgoApp,
  bookandgoPrice,
  createBookandgoAdapter,
  parseBookandgoDay,
  parseBookandgoLocations,
  pickBookandgoLocation,
  type BookandgoPriceRow,
} from "@/lib/booking/adapters/bookandgo";
import type { ScrapedSlot, ScrapeTarget } from "@/lib/booking/adapters/types";
import { detectPlatform, PLATFORMS } from "@/lib/booking/platforms";
import { availabilityFrom } from "@/lib/booking/scrape";
import { utcToZonedParts } from "@/lib/dates";
import { freezeClock } from "./helpers/clock";

/**
 * Real anonymous answers from api.bookandgo.app, read on 10 October 2026, trimmed to what the reader
 * reads: Prime Padel (app 39: Dempsey, location 93, and Grand Copthorne Waterfront on Havelock Road,
 * location 73) for 10, 11 and 12 October, MBP Sports (app 51) and Sterling (app 83) for 11 October.
 * The locations keep no coach, phone number, map link or address; the court bookings name nobody.
 *
 * NOW is 06:54 UTC on Saturday 10 October: 14:54 in Singapore, 13:54 in Bangkok.
 */
const NOW = new Date("2026-10-10T06:54:00Z");
freezeClock(NOW);

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "fixtures/scrape/bookandgo", name), "utf8");
const LOC39 = fixture("locations-39.json");
const LOC51 = fixture("locations-51.json");
const LOC83 = fixture("locations-83.json");
const DAY: Record<string, string> = {
  "39/2026-10-10": fixture("court-bookings-39-2026-10-10.json"),
  "39/2026-10-11": fixture("court-bookings-39-2026-10-11.json"),
  "39/2026-10-12": fixture("court-bookings-39-2026-10-12.json"),
  "51/2026-10-11": fixture("court-bookings-51-2026-10-11.json"),
  "83/2026-10-11": fixture("court-bookings-83-2026-10-11.json"),
};
const LOCATIONS: Record<string, string> = { "39": LOC39, "51": LOC51, "83": LOC83 };
const NO_LOCATIONS = '{"status":"success","success":true,"error":false,"message":"Location retrived successfully","data":[]}';
const NOTHING_FREE = '{"status":"success","success":true,"error":false,"message":"Bookings details retrieved successfully","data":{"bookings":[]}}';

const SG = "Asia/Singapore";
const BKK = "Asia/Bangkok";
const PRIME = "https://app.primepadelsport.com/";
const HAVELOCK = 73;
const DEMPSEY = 93;

const row = (s: ScrapedSlot) => `${s.start} ${s.end} ${s.court} ${s.priceText}`;
const day = (key: string, locationId: number, tz = SG, bookUrl: string | null = PRIME) => parseBookandgoDay(DAY[key], { locationId, date: key.slice(3), tz, bookUrl })!;

describe("Book & Go parsers on real responses", () => {
  it("reads each location, its zone and the name it gives padel", () => {
    expect(parseBookandgoLocations(LOC39)).toEqual([
      { id: DEMPSEY, name: "Dempsey", timezone: SG, padel: "Padel" },
      { id: HAVELOCK, name: "Grand Copthorne Waterfront", timezone: SG, padel: "Padel" },
    ]);
    expect(parseBookandgoLocations(LOC51)).toEqual([
      { id: 129, name: "Suntec City Pickleball", timezone: SG, padel: null },
      { id: 128, name: "Marina Square Pickle + Tennis", timezone: SG, padel: null },
      { id: 127, name: "Marina Square Padel", timezone: SG, padel: "Padel" },
    ]);
    expect(parseBookandgoLocations(LOC83)).toEqual([{ id: 213, name: "Sterling", timezone: BKK, padel: "Padel" }]);
    expect(parseBookandgoLocations(NO_LOCATIONS)).toEqual([]);
  });

  it("calls locations without their fields a change", () => {
    expect(parseBookandgoLocations("<html>Bad gateway</html>")).toBeNull();
    expect(parseBookandgoLocations('{"data":{}}')).toBeNull();
    expect(parseBookandgoLocations(LOC39.replaceAll('"location_name"', '"name"'))).toBeNull();
    expect(parseBookandgoLocations(LOC39.replaceAll('"sport_name"', '"sportName"'))).toBeNull();
  });

  it("picks the venue a club's slug names, else the app's only padel venue, and never guesses", () => {
    const prime = parseBookandgoLocations(LOC39)!;
    const primeApp = bookandgoApp(PRIME)!;
    expect(pickBookandgoLocation(prime, primeApp, "prime-padel-havelock")).toMatchObject({ kind: "location", location: { id: HAVELOCK } });
    expect(pickBookandgoLocation(prime, primeApp, "prime-padel-dempsey")).toMatchObject({ kind: "location", location: { id: DEMPSEY } });
    expect(pickBookandgoLocation(prime, primeApp, "prime-padel")).toEqual({ kind: "not_found", detail: "app 39 has 2 padel locations and names none for prime-padel" });
    expect(pickBookandgoLocation(prime.filter((l) => l.id !== HAVELOCK), primeApp, "prime-padel-havelock")).toEqual({ kind: "not_found", detail: "app 39 no longer lists location 73" });

    const mbp = parseBookandgoLocations(LOC51)!;
    expect(pickBookandgoLocation(mbp, bookandgoApp("https://mbpsports.web.app/")!, "mbp-sports")).toMatchObject({ kind: "location", location: { id: 127 } });
    expect(pickBookandgoLocation(mbp.filter((l) => l.id !== 127), { app: 51 }, "mbp-sports")).toEqual({ kind: "no_padel" });
    expect(pickBookandgoLocation([], { app: 999999 }, "mbp-sports")).toEqual({ kind: "not_found", detail: "app 999999 lists no locations" });
  });

  it("turns Havelock's Sunday into exact UTC slots: court, start, length and price", () => {
    const slots = day("39/2026-10-11", HAVELOCK);
    expect(slots).toHaveLength(38);
    // No price row covers a Sunday at Prime Padel, so each length costs its base price.
    expect(
      slots
        .filter((s) => s.court === "Court 1")
        .map(row)
        .sort(),
    ).toEqual([
      "2026-10-10T23:00:00.000Z 2026-10-11T00:30:00.000Z Court 1 156 SGD",
      "2026-10-11T03:00:00.000Z 2026-10-11T04:00:00.000Z Court 1 104 SGD",
      "2026-10-11T03:00:00.000Z 2026-10-11T04:30:00.000Z Court 1 156 SGD",
      "2026-10-11T04:00:00.000Z 2026-10-11T05:30:00.000Z Court 1 156 SGD",
      "2026-10-11T04:30:00.000Z 2026-10-11T05:30:00.000Z Court 1 104 SGD",
      "2026-10-11T07:00:00.000Z 2026-10-11T08:00:00.000Z Court 1 104 SGD",
      "2026-10-11T12:00:00.000Z 2026-10-11T13:00:00.000Z Court 1 104 SGD",
      "2026-10-11T12:00:00.000Z 2026-10-11T14:00:00.000Z Court 1 208 SGD",
      "2026-10-11T13:00:00.000Z 2026-10-11T14:00:00.000Z Court 1 104 SGD",
    ]);
    expect(new Set(slots.map((s) => s.court))).toEqual(new Set(["Court 1", "Court 2", "Court 3"]));
    expect(slots.every((s) => s.free && s.bookUrl === PRIME)).toBe(true);
    // 23:00 UTC on the 10th is 07:00 on the 11th in Singapore: the opening hour, on the day asked for.
    for (const s of slots) expect(utcToZonedParts(new Date(s.start), SG).date).toBe("2026-10-11");
  });

  it("keeps two venues of one app apart, though one answer carries both", () => {
    const dempsey = day("39/2026-10-11", DEMPSEY);
    const havelock = day("39/2026-10-11", HAVELOCK);
    expect(dempsey).toHaveLength(102);
    expect(dempsey.some((s) => s.court === "Court 7")).toBe(true);
    expect(havelock.some((s) => ["Court 4", "Court 5", "Court 6", "Court 7"].includes(s.court!))).toBe(false);
    expect(parseBookandgoDay(DAY["39/2026-10-11"], { locationId: 12345, date: "2026-10-11", tz: SG, bookUrl: null })).toEqual([]);
  });

  it("prices a weekday's off-peak window from the club's own rows (Monday at Dempsey)", () => {
    const court7 = day("39/2026-10-12", DEMPSEY).filter((s) => s.court === "Court 7");
    const price = (local: string, minutes: number) => {
      const s = court7.find((x) => utcToZonedParts(new Date(x.start), SG).time === local && Date.parse(x.end) - Date.parse(x.start) === minutes * 60_000);
      return s?.priceText;
    };
    expect([price("07:00", 60), price("12:00", 60), price("15:00", 60)]).toEqual(["104 SGD", "62 SGD", "62 SGD"]);
    expect([price("07:00", 90), price("11:30", 90)]).toEqual(["156 SGD", "93 SGD"]);
    expect([price("10:30", 120), price("13:00", 120)]).toEqual(["208 SGD", "124 SGD"]);
  });

  it("takes the club's dated rows over a base price of 0 (MBP Sports)", () => {
    const slots = day("51/2026-10-11", 127, SG, "https://mbpsports.web.app/");
    expect(slots).toHaveLength(30);
    const byLength = new Map(slots.map((s) => [(Date.parse(s.end) - Date.parse(s.start)) / 60_000, s.priceText]));
    expect(Object.fromEntries(byLength)).toEqual({ 60: "150 SGD", 90: "225 SGD", 120: "300 SGD" });
    // 08:00 in Singapore is midnight UTC.
    expect(slots.map((s) => s.start).sort()[0]).toBe("2026-10-11T00:00:00.000Z");
  });

  it("settles overlapping windows by the one that holds the whole booking (Sterling's Sunday)", () => {
    const padel1 = day("83/2026-10-11", 213, BKK, "https://book.sterlingbkk.com/").filter((s) => s.court === "Padel 1");
    const two = padel1.filter((s) => Date.parse(s.end) - Date.parse(s.start) === 120 * 60_000);
    // 20:00 to 22:00 sits in "20:00-24:00" (3280) only; the first window holding 20:00 would say 3580.
    expect(two.map(row)).toEqual([
      "2026-10-11T13:00:00.000Z 2026-10-11T15:00:00.000Z Padel 1 3280 THB",
      "2026-10-11T13:30:00.000Z 2026-10-11T15:30:00.000Z Padel 1 3280 THB",
      "2026-10-11T14:00:00.000Z 2026-10-11T16:00:00.000Z Padel 1 3280 THB",
      "2026-10-11T14:30:00.000Z 2026-10-11T16:30:00.000Z Padel 1 3280 THB",
    ]);
    // 06:00 in Bangkok is 23:00 UTC the day before.
    expect(padel1.find((s) => s.start === "2026-10-10T23:00:00.000Z")?.priceText).toBe("1640 THB");
  });

  it("gives no price rather than a wrong one", () => {
    const r = (start_time: string, end_time: string, price: number, days: string | null = "Sunday"): BookandgoPriceRow => ({ start_time, end_time, days, date_start: null, date_end: null, price });
    // Two windows hold the whole booking and disagree: no price.
    expect(bookandgoPrice([r("10:00:00", "20:00:00", 100), r("09:00:00", "21:00:00", 120)], 90, "2026-10-11", "12:00:00", 60)).toBeNull();
    // A price of 0 means "see the app".
    expect(bookandgoPrice([], 0, "2026-10-11", "12:00:00", 60)).toBeNull();
    expect(bookandgoPrice([], 104, "2026-10-11", "12:00:00", 60)).toBe(104);
    // A dated row beats the weekday's row, and a window may run to 24:00.
    const dated: BookandgoPriceRow = { start_time: "07:00:00", end_time: "24:00:00", days: null, date_start: "2026-10-11T00:00:00.000Z", date_end: "2026-10-11T00:00:00.000Z", price: 200 };
    expect(bookandgoPrice([r("07:00:00", "24:00:00", 80), dated], 100, "2026-10-11", "22:30:00", 60)).toBe(200);
    expect(bookandgoPrice([r("07:00:00", "24:00:00", 80), dated], 100, "2026-10-12", "22:30:00", 60)).toBe(100);
  });

  it("calls a day without its fields a change, and a day with nothing free an empty list", () => {
    const o = { locationId: HAVELOCK, date: "2026-10-11", tz: SG, bookUrl: PRIME };
    const base = DAY["39/2026-10-11"];
    expect(parseBookandgoDay("not json", o)).toBeNull();
    expect(parseBookandgoDay('{"data":[]}', o)).toBeNull();
    expect(parseBookandgoDay(base.replaceAll('"available_time_slots"', '"slots"'), o)).toBeNull();
    expect(parseBookandgoDay(base.replaceAll('"date":"2026-10-11"', '"date":"2026-10-11T00:00:00.000Z"'), o)).toBeNull();
    // Havelock's Court 1 is free for two hours from 20:00 only.
    expect(parseBookandgoDay(base.replace('"available_time_slots":["20:00:00"]', '"available_time_slots":["8pm"]'), o)).toBeNull();
    expect(parseBookandgoDay(base.replaceAll('"duration":60', '"duration":"60"'), o)).toBeNull();
    expect(parseBookandgoDay(NOTHING_FREE, o)).toEqual([]);
  });
});

describe("matches()", () => {
  it("takes the club apps we mapped, and a bookandgo.app link that names its app", () => {
    for (const url of [PRIME, "https://app.primepadelsport.com/availability.html", "https://primepadelweb.web.app/", "https://mbpsports.web.app/", "https://sterling-sports.web.app/", "https://book.sterlingbkk.com/", "https://api.bookandgo.app/api/v1/apps/39/locations"]) {
      expect(bookandgoAdapter.matches(url), url).toBe(true);
    }
    expect(bookandgoApp("https://book.sterlingbkk.com/")).toEqual({ app: 83, bookUrl: "https://book.sterlingbkk.com/" });
    expect(bookandgoApp("https://mbpsports.web.app/#/home")).toEqual({ app: 51, bookUrl: "https://mbpsports.web.app/" });
    expect(bookandgoApp("https://api.bookandgo.app/api/v1/apps/39/locations")).toEqual({ app: 39, bookUrl: null });
  });

  it("refuses a host nobody mapped, the vendor's own pages and look-alike hosts", () => {
    for (const url of [
      "https://bookandgo.app/en/padel",
      "https://primepadelsport.com/",
      "https://app.primepadelsport.com.evil.example/",
      "https://evil.example/app.primepadelsport.com/",
      "https://notbookandgo.app/api/v1/apps/39",
      "https://kross-padel.web.app/",
      "https://krosspadel.com/",
      "https://playtomic.com/clubs/love-all-racquet-club",
      "javascript:alert(1)",
      "not a link",
      "",
    ]) {
      expect(bookandgoAdapter.matches(url), url).toBe(false);
    }
  });

  it("is a platform, registered beside the other readers", () => {
    expect(bookandgoAdapter.platform).toBe("bookandgo");
    expect(PLATFORMS.find((p) => p.id === "bookandgo")).toEqual({ id: "bookandgo", name: "Book & Go", hosts: ["bookandgo.app"] });
    expect(detectPlatform("https://api.bookandgo.app/api/v1/apps/39")?.id).toBe("bookandgo");
    // A club's own domain stays the club's: only the reader knows it runs on Book & Go.
    expect(detectPlatform(PRIME)).toBeNull();
    expect(ADAPTERS).toContain(bookandgoAdapter);
    expect(adapterFor(PRIME, "bookandgo")).toBe(bookandgoAdapter);
    // A club row that says "bookandgo" with a host nobody mapped gets no reader, so the frame leaves it unread.
    expect(adapterFor("https://kross-padel.web.app/", "bookandgo")).toBeNull();
  });
});

type Call = { url: string; method: string; ua: string | null; secret: boolean };
const target = (over: Partial<ScrapeTarget> = {}): ScrapeTarget => ({ clubSlug: "prime-padel-havelock", platform: "bookandgo", bookingUrl: PRIME, tz: SG, days: 3, ...over });

/** A fake api.bookandgo.app: routes by path, records every call and every wait. */
function harness(route: (url: URL) => Response | Promise<Response>, opts: { timeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const waits: number[] = [];
  let t = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url: url.pathname + url.search, method: init?.method ?? "GET", ua: headers.get("user-agent"), secret: headers.has("cookie") || headers.has("authorization") });
    return route(url);
  }) as typeof fetch;
  const adapter = createBookandgoAdapter({
    clock: () => t,
    sleep: async (ms) => {
      waits.push(ms);
      t += ms;
    },
    timeoutMs: opts.timeoutMs,
  });
  return { calls, waits, fetchImpl, adapter };
}

const json = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8" } });
const realBookandgo = (url: URL) => {
  const m = url.pathname.match(/^\/api\/v1\/apps\/(\d+)\/(locations|court-bookings)$/);
  if (!m) return json('{"message":"Not found"}', 404);
  if (m[2] === "locations") return json(LOCATIONS[m[1]] ?? NO_LOCATIONS);
  if (url.searchParams.get("sport_name") !== "Padel") return json(NOTHING_FREE);
  return json(DAY[`${m[1]}/${url.searchParams.get("date")}`] ?? NOTHING_FREE);
};
const day39 = (date: string) => `/api/v1/apps/39/court-bookings?sport_name=Padel&date=${date}`;

describe("scrape()", () => {
  it("reads Havelock politely: the locations, then one day a request, one request a second", async () => {
    const h = harness(realBookandgo);
    const r = await h.adapter.scrape(target(), h.fetchImpl, NOW);
    expect(h.calls.map((c) => c.url)).toEqual(["/api/v1/apps/39/locations", day39("2026-10-10"), day39("2026-10-11"), day39("2026-10-12")]);
    expect(h.calls.every((c) => c.method === "GET" && c.ua === BOOKANDGO_USER_AGENT && !c.secret)).toBe(true);
    expect(BOOKANDGO_USER_AGENT).toBe("KicksmashBot/1.0 (+https://kicksma.sh/about)");
    expect(h.waits).toEqual([1000, 1000, 1000]);
    if (!r.ok) throw new Error(r.detail ?? r.reason);
    expect(r.requests).toBe(4);
    // Today's 20 slots still to come, then the whole of Sunday and Monday.
    expect(r.slots).toHaveLength(20 + 38 + 49);
    expect(r.slots.every((s) => Date.parse(s.start) >= NOW.getTime())).toBe(true);
    expect(r.slots.map((s) => s.start)).toEqual([...r.slots.map((s) => s.start)].sort());
    expect(new Set(r.slots.map((s) => s.court))).toEqual(new Set(["Court 1", "Court 2", "Court 3"]));
  });

  it("reads Dempsey from the same app by its own slug", async () => {
    const h = harness(realBookandgo);
    const r = await h.adapter.scrape(target({ clubSlug: "prime-padel-dempsey", days: 2 }), h.fetchImpl, NOW);
    expect(r.ok && r.slots.some((s) => s.court === "Court 7")).toBe(true);
    expect(r.requests).toBe(3);
  });

  it("reads MBP Sports and Sterling on the day of the club's own zone", async () => {
    // 00:30 on Sunday in Singapore, and 23:30 on Saturday in Bangkok.
    const at = new Date("2026-10-10T16:30:00Z");
    const mbp = harness(realBookandgo);
    expect(await mbp.adapter.scrape(target({ clubSlug: "mbp-sports", bookingUrl: "https://mbpsports.web.app/", days: 1 }), mbp.fetchImpl, at)).toMatchObject({ ok: true, requests: 2 });
    expect(mbp.calls[1].url).toBe("/api/v1/apps/51/court-bookings?sport_name=Padel&date=2026-10-11");
    const sterling = harness(realBookandgo);
    const r = await sterling.adapter.scrape(target({ clubSlug: "sterling", bookingUrl: "https://book.sterlingbkk.com/", tz: BKK, days: 2 }), sterling.fetchImpl, at);
    expect(sterling.calls.map((c) => c.url)).toEqual(["/api/v1/apps/83/locations", "/api/v1/apps/83/court-bookings?sport_name=Padel&date=2026-10-10", "/api/v1/apps/83/court-bookings?sport_name=Padel&date=2026-10-11"]);
    expect(r.ok && r.slots.length).toBe(100);
  });

  it("never spends more than eight requests, however many days are asked", async () => {
    const h = harness(realBookandgo);
    const r = await h.adapter.scrape(target({ days: 30 }), h.fetchImpl, NOW);
    expect(r.ok).toBe(true);
    expect(r.requests).toBe(BOOKANDGO_MAX_REQUESTS);
    expect(h.calls).toHaveLength(BOOKANDGO_MAX_REQUESTS);
    expect(BOOKANDGO_MAX_REQUESTS).toBe(8);
  });

  it("stops at a 403 and asks nothing more", async () => {
    const h = harness(() => json('{"message":"Forbidden"}', 403));
    expect(await h.adapter.scrape(target(), h.fetchImpl, NOW)).toEqual({ ok: false, status: 403, reason: "blocked", requests: 1, detail: "403 on /apps/39/locations" });
    expect(h.calls).toHaveLength(1);
  });

  it("stops at a 429 halfway through", async () => {
    const h = harness((url) => (url.pathname.endsWith("/court-bookings") ? json('{"message":"Too many requests"}', 429) : realBookandgo(url)));
    expect(await h.adapter.scrape(target(), h.fetchImpl, NOW)).toMatchObject({ ok: false, status: 429, reason: "blocked", requests: 2 });
    expect(h.calls).toHaveLength(2);
  });

  it("calls an app Book & Go no longer has not_found: a 404, or an empty list of locations", async () => {
    const gone = harness(() => json('{"message":"Not found"}', 404));
    expect(await gone.adapter.scrape(target(), gone.fetchImpl, NOW)).toMatchObject({ ok: false, status: 404, reason: "not_found", requests: 1 });
    const empty = harness(() => json(NO_LOCATIONS));
    expect(await empty.adapter.scrape(target(), empty.fetchImpl, NOW)).toMatchObject({ ok: false, status: null, reason: "not_found", requests: 1 });
  });

  it("does not guess which of two venues a club is", async () => {
    const h = harness(realBookandgo);
    expect(await h.adapter.scrape(target({ clubSlug: "prime-padel" }), h.fetchImpl, NOW)).toEqual({ ok: false, status: null, reason: "not_found", requests: 1, detail: "app 39 has 2 padel locations and names none for prime-padel" });
  });

  it("asks nothing for a link whose host nobody mapped", async () => {
    const h = harness(realBookandgo);
    expect(await h.adapter.scrape(target({ clubSlug: "kross-padel-on-nut", bookingUrl: "https://kross-padel.web.app/" }), h.fetchImpl, NOW)).toMatchObject({ ok: false, reason: "not_found", requests: 0 });
    expect(h.calls).toHaveLength(0);
  });

  it("reads an app without a padel venue as no free courts, not as an error", async () => {
    const pickleOnly = JSON.stringify({ ...JSON.parse(LOC51), data: JSON.parse(LOC51).data.filter((l: { id: number }) => l.id !== 127) });
    const h = harness(() => json(pickleOnly));
    expect(await h.adapter.scrape(target({ clubSlug: "mbp-sports", bookingUrl: "https://mbpsports.web.app/" }), h.fetchImpl, NOW)).toEqual({ ok: true, slots: [], requests: 1, tz: SG });
  });

  it("calls an answer without its fields changed: the locations, and a day", async () => {
    const a = harness(() => json('{"status":"success","data":{"locations":[]}}'));
    expect(await a.adapter.scrape(target(), a.fetchImpl, NOW)).toMatchObject({ ok: false, reason: "changed", requests: 1 });
    const b = harness((url) => (url.pathname.endsWith("/court-bookings") ? json('{"status":"success","data":{"slots":[]}}') : realBookandgo(url)));
    expect(await b.adapter.scrape(target(), b.fetchImpl, NOW)).toMatchObject({ ok: false, reason: "changed", requests: 2 });
  });

  it("gives up on an answer that never comes", async () => {
    expect(BOOKANDGO_TIMEOUT_MS).toBe(10_000);
    const h = harness(() => new Promise<Response>(() => undefined), { timeoutMs: 20 });
    expect(await h.adapter.scrape(target(), h.fetchImpl, NOW)).toMatchObject({ ok: false, status: null, reason: "timeout", requests: 1 });
  });

  it("reads in the venue's own zone when the club row has none, says which, and reads one day when asked", async () => {
    const h = harness(realBookandgo);
    const r = await h.adapter.scrape(target({ tz: null, days: 1 }), h.fetchImpl, NOW);
    expect(r).toMatchObject({ ok: true, tz: SG, requests: 2 });
    expect(h.calls.map((c) => c.url)).toEqual(["/api/v1/apps/39/locations", day39("2026-10-10")]);
  });

  it("names each court by its id as well, so two courts with one name stay two", () => {
    const slots = day("39/2026-10-11", HAVELOCK);
    expect(new Set(slots.map((s) => `${s.courtId} ${s.court}`))).toEqual(new Set(["264 Court 1", "265 Court 2", "266 Court 3"]));
    expect(slots.every((s) => s.courtId && s.court)).toBe(true);
  });

  it("hands the frame every free court it found, each court-hour once (the review's readers F1, on this platform)", async () => {
    const h = harness(realBookandgo);
    const r = await h.adapter.scrape(target(), h.fetchImpl, NOW);
    if (!r.ok) throw new Error(r.detail ?? r.reason);
    const a = availabilityFrom(r, { platform: "bookandgo", tz: r.tz!, now: NOW });
    expect(a.error).toBeNull();
    expect(a.days).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
    // Book & Go lists each free start once for every length (60, 90, 120). The cache keeps each court's
    // union: the court-hours in it equal the union of the free time of each court, worked out here apart.
    const union = new Map<string, [number, number][]>();
    for (const s of r.slots) union.set(s.courtId!, [...(union.get(s.courtId!) ?? []), [Date.parse(s.start), Date.parse(s.end)]]);
    let expected = 0;
    for (const spans of union.values()) {
      spans.sort((x, y) => x[0] - y[0]);
      let [lo, hi] = spans[0];
      for (const [x, y] of spans.slice(1)) {
        if (x <= hi) hi = Math.max(hi, y);
        else [expected, lo, hi] = [expected + (hi - lo), x, y];
      }
      expected += hi - lo;
    }
    const kept = a.slots.reduce((n, s) => n + s.free * (Date.parse(s.end) - Date.parse(s.start)), 0);
    expect(kept / 3600_000).toBe(expected / 3600_000);
    expect(kept).toBeLessThan(r.slots.reduce((n, s) => n + (Date.parse(s.end) - Date.parse(s.start)), 0));
    for (let i = 1; i < a.slots.length; i++) expect(a.slots[i].start >= a.slots[i - 1].end).toBe(true);
    // No link, price or court name on a slot: the link stays on the club row (its booking button).
    for (const s of a.slots) expect(Object.keys(s).sort()).toEqual(["end", "free", "start"]);
    expect(Math.max(...a.slots.map((s) => s.free))).toBeLessThanOrEqual(3);
  });
});
