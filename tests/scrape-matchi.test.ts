import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MATCHI_DISALLOWED,
  MATCHI_MAX_REQUESTS,
  MATCHI_TIMEOUT_MS,
  MATCHI_USER_AGENT,
  createMatchiAdapter,
  matchiAdapter,
  parseMatchiFacility,
  parseMatchiSlots,
} from "@/lib/booking/adapters/matchi";
import type { ScrapeTarget } from "@/lib/booking/adapters/types";

// Real responses from www.matchi.se, read as an anonymous visitor on 10 October 2026, trimmed to what
// the parser needs: Padel Phuket @ Blue Tree (facility 2165) and Bangkok Padel's empty day.
const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "fixtures/scrape/matchi", name), "utf8");
const FACILITY = fixture("facility-bluetree.html");
const DAY1 = fixture("list-slots-bluetree-2026-10-10.html");
const DAY2 = fixture("list-slots-bluetree-2026-10-11.html");
const EMPTY = fixture("list-slots-empty.html");

const TZ = "Asia/Bangkok";
const book = (slotId: string, start: number, end: number) =>
  `https://www.matchi.se/login/auth?returnUrl=%2Fbook%2Findex%3FslotIds%3D${slotId}%26facilityId%3D2165%26start%3D${start}%26end%3D${end}%26sportIds%3D5%26comeback%3Dtrue`;
const slot = (start: string, end: string, court: string, bookUrl: string) => ({ start, end, court, free: true, priceText: null, bookUrl });

// 13:00, 13:30 and 16:30 in Phuket are 06:00, 06:30 and 09:30 UTC. The epoch in each Book link is
// MATCHi's own (13:00 read as Stockholm time), kept as the page gives it and never used for the time.
const DAY1_SLOTS = [
  slot("2026-10-10T06:00:00.000Z", "2026-10-10T07:00:00.000Z", "1. Centercourt", book("2c9412429c52a7af019c52c13c0d22f8", 1791630000000, 1791633600000)),
  slot("2026-10-10T06:00:00.000Z", "2026-10-10T07:00:00.000Z", "2. Centercourt", book("2c9412429c52a7af019c52c1d66f34d9", 1791630000000, 1791633600000)),
  slot("2026-10-10T06:00:00.000Z", "2026-10-10T07:00:00.000Z", "Court 6", book("2c9412429c52a7af019c52c1d7873828", 1791630000000, 1791633600000)),
  slot("2026-10-10T06:30:00.000Z", "2026-10-10T07:30:00.000Z", "1. Centercourt", book("2c9412429c52a7af019c52c13c0e22fc", 1791631800000, 1791635400000)),
  slot("2026-10-10T06:30:00.000Z", "2026-10-10T07:30:00.000Z", "2. Centercourt", book("2c9412429c52a7af019c52c1d67134e0", 1791631800000, 1791635400000)),
  slot("2026-10-10T09:30:00.000Z", "2026-10-10T10:30:00.000Z", "1. Centercourt", book("2c9412429c52a7af019c52c13c18230a", 1791642600000, 1791646200000)),
  slot("2026-10-10T09:30:00.000Z", "2026-10-10T10:30:00.000Z", "2. Centercourt", book("2c9412429c52a7af019c52c1d687350d", 1791642600000, 1791646200000)),
  slot("2026-10-10T09:30:00.000Z", "2026-10-10T11:00:00.000Z", "Court 3", book("2c9412429c52a7af019c52c1d6c935e5", 1791642600000, 1791648000000)),
  slot("2026-10-10T09:30:00.000Z", "2026-10-10T10:30:00.000Z", "Court 4", book("2c9412429c52a7af019c52c1d70c36b9", 1791642600000, 1791646200000)),
  slot("2026-10-10T09:30:00.000Z", "2026-10-10T10:30:00.000Z", "Court 5", book("2c9412429c52a7af019c52c1d74b3786", 1791642600000, 1791646200000)),
];
// 07:00 on Sunday 11 October in Phuket is midnight UTC.
const DAY2_SLOTS = [
  ["1. Centercourt", "2c9415269b080a6d019b082f40791759"],
  ["2. Centercourt", "2c9415269b080a6d019b082f409e17c2"],
  ["Court 3", "2c9415269b080a6d019b082f40c5183b"],
  ["Court 4", "2c9415269b080a6d019b082f40e01899"],
  ["Court 5", "2c9415269b080a6d019b082f41061904"],
  ["Court 6", "2c9415269b080a6d019b082f4123196d"],
].map(([court, id]) => slot("2026-10-11T00:00:00.000Z", "2026-10-11T01:00:00.000Z", court, book(id, 1791694800000, 1791698400000)));

describe("MATCHi parsers on real responses", () => {
  it("reads the facility id and the padel sport id from the club page", () => {
    expect(parseMatchiFacility(FACILITY)).toEqual({ facilityId: "2165", sportId: "5" });
    expect(parseMatchiFacility("<html><title>Down for maintenance</title></html>")).toBeNull();
  });

  // readers F6: a renamed or reordered field reads as "changed", never as "no free courts".
  it("finds Padel in the sport picker whatever the order of the option's attributes", () => {
    const reordered = FACILITY.replace(/<option value="5" selected\s+data-content="([^"]*)">/, '<option data-content="$1" selected value="5">');
    expect(reordered).not.toBe(FACILITY);
    expect(parseMatchiFacility(reordered)).toEqual({ facilityId: "2165", sportId: "5" });
  });

  it("calls a club page with no sport picker at all a change, and one whose picker has no Padel a club with no padel", () => {
    const noPicker = FACILITY.replace(/<select id="sport-picker-mobile"[\s\S]*?<\/select>/, "").replace(/var sport = '5';/, "");
    expect(parseMatchiFacility(noPicker)).toBeNull();
    const tennisOnly = FACILITY.replace(/ Padel<\/option>/, " Tennis</option>").replace(/ma-5'><\/i> Padel/, "ma-1'></i> Tennis");
    expect(parseMatchiFacility(tennisOnly)).toEqual({ facilityId: "2165", sportId: null });
  });

  it("falls back to the page's own sport when the picker's options cannot be read", () => {
    const unreadable = FACILITY.replace(/<option[\s\S]*?<\/option>/g, "");
    expect(parseMatchiFacility(unreadable)).toEqual({ facilityId: "2165", sportId: "5" });
  });

  it("reads every free court of a day, in UTC, with its length and its Book link", () => {
    expect(parseMatchiSlots(DAY1, "2026-10-10", TZ)).toEqual({ ok: true, slots: DAY1_SLOTS });
  });

  it("reads the next day by the date the page prints, not the date that was asked", () => {
    expect(parseMatchiSlots(DAY2, "2026-10-10", TZ)).toEqual({ ok: true, slots: DAY2_SLOTS });
  });

  it("reads a day with nothing free as an empty list, not as a change", () => {
    expect(parseMatchiSlots(EMPTY, "2026-10-10", TZ)).toEqual({ ok: true, slots: [] });
  });

  it("calls a page without the fields it needs a change", () => {
    expect(parseMatchiSlots("<html><body>Sorry, something went wrong</body></html>", "2026-10-10", TZ).ok).toBe(false);
    expect(parseMatchiSlots(DAY1.replace(/\d+min/g, "an hour"), "2026-10-10", TZ).ok).toBe(false);
    expect(parseMatchiSlots(DAY1.replace(/<sup>00<\/sup>/g, ""), "2026-10-10", TZ).ok).toBe(false);
  });
});

describe("matches()", () => {
  it("takes a MATCHi club page and nothing else", () => {
    for (const url of ["https://www.matchi.se/facilities/bluetree", "https://www.matchi.se/facilities/bangkokpadel", "https://matchi.se/facilities/bluetree/"]) {
      expect(matchiAdapter.matches(url), url).toBe(true);
    }
    for (const url of [
      "https://www.matchi.se/",
      "https://www.matchi.se/book/schedule?facilityId=2165",
      "https://playtomic.io/padel-phuket/abc",
      "https://matchi.se.example.com/facilities/bluetree",
      "https://www.bangkokpadel.com/",
      "not a link",
      "",
    ]) {
      expect(matchiAdapter.matches(url), url).toBe(false);
    }
    expect(matchiAdapter.platform).toBe("matchi");
  });
});

type Call = { url: string; ua: string | null };
const target = (over: Partial<ScrapeTarget> = {}): ScrapeTarget => ({ clubSlug: "blue-tree", platform: "matchi", bookingUrl: "https://www.matchi.se/facilities/bluetree", tz: TZ, days: 2, ...over });

/** A fake MATCHi: routes by path, records every call and every wait. */
function harness(route: (url: URL) => Response | Promise<Response>, opts: { timeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const waits: number[] = [];
  let t = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.pathname + url.search, ua: new Headers(init?.headers).get("user-agent") });
    return route(url);
  }) as typeof fetch;
  const adapter = createMatchiAdapter({
    clock: () => t,
    sleep: async (ms) => {
      waits.push(ms);
      t += ms;
    },
    timeoutMs: opts.timeoutMs,
  });
  return { calls, waits, fetchImpl, adapter };
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html;charset=UTF-8" } });
const realMatchi = (url: URL) => {
  if (url.pathname === "/facilities/bluetree") return html(FACILITY);
  if (url.pathname === "/book/listSlots") return html(url.searchParams.get("date") === "2026-10-10" ? DAY1 : url.searchParams.get("date") === "2026-10-11" ? DAY2 : EMPTY);
  return html("", 404);
};

// 15:00 in Phuket: the 13:00 and 13:30 courts have started, the 16:30 ones are still to come.
const NOW = new Date("2026-10-10T08:00:00Z");

describe("scrape()", () => {
  it("reads two days politely: the club page, then one list a day, one request a second", async () => {
    const h = harness(realMatchi);
    expect(await h.adapter.scrape(target(), h.fetchImpl, NOW)).toEqual({ ok: true, requests: 3, slots: [...DAY1_SLOTS.slice(5), ...DAY2_SLOTS] });
    expect(h.calls.map((c) => c.url)).toEqual([
      "/facilities/bluetree",
      "/book/listSlots?wl=&facility=2165&date=2026-10-10&sport=5&week=&year=",
      "/book/listSlots?wl=&facility=2165&date=2026-10-11&sport=5&week=&year=",
    ]);
    expect(h.calls.every((c) => c.ua === MATCHI_USER_AGENT)).toBe(true);
    expect(MATCHI_USER_AGENT).toBe("KicksmashBot/1.0 (+https://kicksma.sh/about)");
    expect(h.waits).toEqual([1000, 1000]);
    expect(h.calls.some((c) => MATCHI_DISALLOWED.some((p) => c.url.startsWith(p)))).toBe(false);
  });

  it("never spends more than eight requests, however many days are asked", async () => {
    const h = harness(realMatchi);
    const r = await h.adapter.scrape(target({ days: 30 }), h.fetchImpl, NOW);
    expect(r.ok).toBe(true);
    expect(r.requests).toBe(MATCHI_MAX_REQUESTS);
    expect(h.calls).toHaveLength(MATCHI_MAX_REQUESTS);
    expect(MATCHI_MAX_REQUESTS).toBe(8);
  });

  it("stops at a 403 and asks nothing more", async () => {
    const h = harness(() => html("Forbidden", 403));
    expect(await h.adapter.scrape(target(), h.fetchImpl, NOW)).toEqual({ ok: false, status: 403, reason: "blocked", requests: 1, detail: "403 on /facilities/bluetree" });
    expect(h.calls).toHaveLength(1);
  });

  it("stops at a 429 halfway through", async () => {
    const h = harness((url) => (url.pathname === "/book/listSlots" ? html("Too many requests", 429) : realMatchi(url)));
    expect(await h.adapter.scrape(target(), h.fetchImpl, NOW)).toMatchObject({ ok: false, status: 429, reason: "blocked", requests: 2 });
    expect(h.calls).toHaveLength(2);
  });

  it("stops when MATCHi sends it to sign in", async () => {
    const h = harness(() => {
      const res = html("<form action='/j_spring_security_check'>");
      Object.defineProperty(res, "url", { value: "https://www.matchi.se/login/auth?returnUrl=%2Ffacilities%2Fbluetree" });
      return res;
    });
    expect(await h.adapter.scrape(target(), h.fetchImpl, NOW)).toMatchObject({ ok: false, reason: "blocked", requests: 1 });
  });

  it("calls a club MATCHi no longer has not_found", async () => {
    const h = harness(() => html("Not found", 404));
    expect(await h.adapter.scrape(target(), h.fetchImpl, NOW)).toMatchObject({ ok: false, status: 404, reason: "not_found", requests: 1 });
  });

  it("calls a facility that redirects to the list of facilities not_found, not a changed page (job F3)", async () => {
    // Checked on 10 October 2026: GET /facilities/<unknown> redirects to /facilities/index and answers 200.
    const h = harness(() => {
      const res = html("<html><body>All facilities</body></html>");
      Object.defineProperty(res, "url", { value: "https://www.matchi.se/facilities/index" });
      return res;
    });
    expect(await h.adapter.scrape(target({ bookingUrl: "https://www.matchi.se/facilities/typo" }), h.fetchImpl, NOW)).toMatchObject({ ok: false, status: 200, reason: "not_found", requests: 1 });
  });

  it("never asks for a path MATCHi's robots.txt names, /facilities/matchitk among them (readers F8)", async () => {
    expect(MATCHI_DISALLOWED).toContain("/facilities/matchitk");
    const h = harness(realMatchi);
    expect(await h.adapter.scrape(target({ bookingUrl: "https://www.matchi.se/facilities/matchitk" }), h.fetchImpl, NOW)).toMatchObject({ ok: false, requests: 0 });
    expect(h.calls).toHaveLength(0);
  });

  it("reads a club whose picker has no Padel as a club with nothing free, after one request", async () => {
    const tennisOnly = FACILITY.replace(/ Padel<\/option>/, " Tennis</option>").replace(/ma-5'><\/i> Padel/, "ma-1'></i> Tennis");
    const h = harness((url) => (url.pathname === "/facilities/bluetree" ? html(tennisOnly) : realMatchi(url)));
    expect(await h.adapter.scrape(target(), h.fetchImpl, NOW)).toEqual({ ok: true, slots: [], requests: 1 });
  });

  it("calls a page without its fields changed: the club page, and a day's list", async () => {
    const a = harness(() => html("<html><body>New MATCHi, coming soon</body></html>"));
    expect(await a.adapter.scrape(target(), a.fetchImpl, NOW)).toMatchObject({ ok: false, reason: "changed", requests: 1 });
    const b = harness((url) => (url.pathname === "/book/listSlots" ? html("<div id='app'></div>") : realMatchi(url)));
    expect(await b.adapter.scrape(target(), b.fetchImpl, NOW)).toMatchObject({ ok: false, reason: "changed", requests: 2 });
  });

  it("gives up on a page that does not answer", async () => {
    expect(MATCHI_TIMEOUT_MS).toBe(10_000);
    const h = harness(() => new Promise<Response>(() => undefined), { timeoutMs: 20 });
    expect(await h.adapter.scrape(target(), h.fetchImpl, NOW)).toMatchObject({ ok: false, status: null, reason: "timeout", requests: 1 });
  });

  it("refuses a link that is not a MATCHi club page without asking anything", async () => {
    const h = harness(realMatchi);
    expect(await h.adapter.scrape(target({ bookingUrl: "https://playtomic.io/x" }), h.fetchImpl, NOW)).toMatchObject({ ok: false, reason: "error", requests: 0 });
    expect(h.calls).toHaveLength(0);
  });
});
