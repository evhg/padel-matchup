import { isValidTimeZone, zonedTimeToUtc } from "@/lib/dates";
import { detectPlatform } from "../platforms";
import type { AvailabilityAdapter, ScrapedSlot, ScrapeResult, ScrapeTarget } from "./types";

/**
 * MATCHi: the free courts an anonymous visitor sees on a club's public page.
 *
 * What the page loads (read on 10 October 2026, www.matchi.se/facilities/bluetree, no cookie, no login):
 *   1. GET /facilities/{slug}: server HTML. Its script carries the facility id in the URL of the
 *      mobile list (`/book/listSlots?wl=&facility=2165&date=…`), and the sport picker
 *      carries the sport id (`<option value="5" …> Padel</option>`).
 *   2. GET /book/listSlots?wl=&facility={id}&date={YYYY-MM-DD}&sport={id}&week=&year=: an HTML
 *      fragment with the FREE slots of that local day only. Per start time a panel: the date
 *      ("Saturday, 10 Oct 2026"), the hour ("13<sup>00</sup>"), then one row per free court with
 *      its name, the length ("60min"), and a Book link (to MATCHi's own sign-in, then the booking).
 *      A day with nothing free says "No available time slots in the selected period."
 *   3. GET /book/getSlotPrices?slotId=…: JSON [{slotId, currency, price}], but only for the slots of
 *      ONE start time (the ids of one button); ids from two start times return an empty body. A day
 *      has fifteen or more start times, so prices do not fit the budget and priceText stays null.
 *
 * Booked courts are not in that fragment. They are only in /book/schedule, which MATCHi's
 * robots.txt disallows, so this reader never asks for it: every slot it returns is free.
 * The `start=` epoch inside the Book link is the club's wall clock read as Stockholm time, so it is
 * never used for the time; the hour comes from the text and the club's own zone.
 *
 * Manners (the owner's decision of 10 October 2026, AGENTS.md): no sign-in, no cookie kept, an honest
 * User-Agent, one request a second, at most eight a call, and a 401, 403 or 429 stops the call.
 */

export const MATCHI_ORIGIN = "https://www.matchi.se";
export const MATCHI_USER_AGENT = "KicksmashBot/1.0 (+https://kicksma.sh/about)";
export const MATCHI_MAX_REQUESTS = 8;
export const MATCHI_TIMEOUT_MS = 10_000;
export const MATCHI_MIN_GAP_MS = 1_000;
/** One facility page plus one list a day: seven days fill the budget. */
export const MATCHI_MAX_DAYS = MATCHI_MAX_REQUESTS - 1;

/** Paths MATCHi's robots.txt disallows (read 10 October 2026). The reader refuses to request them. */
export const MATCHI_DISALLOWED = ["/book/findFacilities", "/book/schedule", "/j_spring_security_check", "/registration", "/login", "/user", "/profile", "/forms"] as const;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;?/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const textOf = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** The facility slug of a MATCHi club link (`/facilities/{slug}`), or null. */
export function matchiFacilitySlug(url: string): string | null {
  if (detectPlatform(url)?.id !== "matchi") return null;
  const m = new URL(url).pathname.match(/^\/facilities\/([A-Za-z0-9_-]+)\/?$/);
  return m ? m[1] : null;
}

/** The facility id and the padel sport id from the public club page. Pure. */
export function parseMatchiFacility(html: string): { facilityId: string; sportId: string | null } | null {
  const id = html.match(/listSlots\?[^"']*?facility=(\d+)/) ?? html.match(/facilityId[=:]\s*["']?(\d+)/);
  if (!id) return null;
  const padel = html.match(/<option value="(\d+)"(?:[^>"]|"[^"]*")*>\s*Padel\s*<\/option>/i);
  return { facilityId: id[1], sportId: padel ? padel[1] : null };
}

export type MatchiParse = { ok: true; slots: ScrapedSlot[] } | { ok: false; detail: string };

/**
 * The free slots of one listSlots fragment. Pure. `date` is the local day that was asked for, used
 * only when a panel's own date cannot be read; `tz` is the club's zone.
 */
export function parseMatchiSlots(html: string, date: string, tz: string): MatchiParse {
  if (!/id="collapse-items"|getSlotPrices|btn-slot/.test(html)) return { ok: false, detail: "not a listSlots fragment" };
  const panels = html.split(/<div class="panel panel-default collapse" id="[^"]*">/).slice(1);
  if (panels.length === 0) {
    return /class="btn btn-slot/.test(html) ? { ok: false, detail: "times without panels" } : { ok: true, slots: [] };
  }
  const slots: ScrapedSlot[] = [];
  for (const panel of panels) {
    const head = panel.match(/<h6>([\s\S]*?)<\/h6>/);
    const hour = head?.[1].match(/<strong>\s*(\d{1,2})\s*<sup>\s*(\d{2})\s*<\/sup>/);
    if (!head || !hour) return { ok: false, detail: "a panel without its hour" };
    const day = head[1].match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/);
    const month = day ? MONTHS[day[2].toLowerCase()] : undefined;
    const localDate = day && month ? `${day[3]}-${pad(month)}-${pad(Number(day[1]))}` : date;
    const start = zonedTimeToUtc(localDate, `${pad(Number(hour[1]))}:${hour[2]}`, tz);
    if (Number.isNaN(start.getTime())) return { ok: false, detail: `an unreadable time ${localDate} ${hour[1]}:${hour[2]}` };
    const rows = panel.split(/<li class="list-group-item">/).filter((r) => r.includes("<table"));
    for (const row of rows) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
      const court = cells[0] ? textOf(cells[0]) : "";
      const minutes = cells[1]?.match(/(\d+)\s*min/);
      if (!court || !minutes) return { ok: false, detail: "a row without its court or length" };
      const href = row.match(/<a href="([^"]+)"[^>]*class="[^"]*btn-success/)?.[1];
      const bookUrl = href ? new URL(decodeEntities(href), MATCHI_ORIGIN).toString() : null;
      const end = new Date(start.getTime() + Number(minutes[1]) * 60_000);
      slots.push({ start: start.toISOString(), end: end.toISOString(), court, free: true, priceText: null, bookUrl });
    }
  }
  return { ok: true, slots };
}

/** The local day `i` days after `now` in `tz`, as YYYY-MM-DD. */
function localDay(now: Date, tz: string, i: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const d = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + i));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

class Stop extends Error {
  constructor(
    readonly reason: "blocked" | "not_found" | "timeout" | "error",
    readonly status: number | null,
    detail: string,
  ) {
    super(detail);
  }
}

export type MatchiOptions = {
  /** Waits between requests; tests pass one that only records. */
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  timeoutMs?: number;
  minGapMs?: number;
};

export function createMatchiAdapter(opts: MatchiOptions = {}): AvailabilityAdapter {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = opts.clock ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? MATCHI_TIMEOUT_MS;
  const minGapMs = opts.minGapMs ?? MATCHI_MIN_GAP_MS;

  // One request a second across every call of this adapter in this process, not per call.
  let queue: Promise<void> = Promise.resolve();
  let last = Number.NEGATIVE_INFINITY;
  const pace = () => {
    const turn = queue.then(async () => {
      const wait = last + minGapMs - clock();
      if (wait > 0) await sleep(wait);
      last = clock();
    });
    queue = turn.catch(() => undefined);
    return turn;
  };

  return {
    platform: "matchi",
    matches: (url: string) => matchiFacilitySlug(url) !== null,

    async scrape(target: ScrapeTarget, fetchImpl: typeof fetch, now: Date): Promise<ScrapeResult> {
      let requests = 0;
      const fail = (reason: "changed" | "error", detail: string, status: number | null = null): ScrapeResult => ({ ok: false, status, reason, requests, detail });

      const get = async (path: string, accept: string): Promise<string> => {
        if (requests >= MATCHI_MAX_REQUESTS) throw new Stop("error", null, "request budget spent");
        if (MATCHI_DISALLOWED.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))) throw new Stop("error", null, `robots.txt disallows ${path}`);
        await pace();
        requests++;
        const ctrl = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ctrl.abort();
            reject(new Stop("timeout", null, `no answer in ${timeoutMs} ms from ${path}`));
          }, timeoutMs);
        });
        const call = (async () => {
          const res = await fetchImpl(`${MATCHI_ORIGIN}${path}`, {
            headers: { "User-Agent": MATCHI_USER_AGENT, Accept: accept, "Accept-Language": "en" },
            redirect: "follow",
            signal: ctrl.signal,
          });
          if (res.status === 401 || res.status === 403 || res.status === 429) throw new Stop("blocked", res.status, `${res.status} on ${path}`);
          if (res.status === 404) throw new Stop("not_found", 404, `404 on ${path}`);
          if (!res.ok) throw new Stop("error", res.status, `${res.status} on ${path}`);
          // A redirect to the sign-in page is a login wall: stop, never sign in.
          if (res.url && /^\/login(\/|$)/.test(new URL(res.url, MATCHI_ORIGIN).pathname)) throw new Stop("blocked", res.status, `sent to sign in from ${path}`);
          return res.text();
        })();
        try {
          return await Promise.race([call, timeout]);
        } catch (e) {
          if (e instanceof Stop) throw e;
          if (ctrl.signal.aborted) throw new Stop("timeout", null, `no answer in ${timeoutMs} ms from ${path}`);
          throw new Stop("error", null, e instanceof Error ? e.message : String(e));
        } finally {
          clearTimeout(timer);
          call.catch(() => undefined);
        }
      };

      const slug = matchiFacilitySlug(target.bookingUrl);
      if (!slug) return fail("error", "not a MATCHi club link");
      if (!isValidTimeZone(target.tz)) return fail("error", `unknown time zone ${target.tz}`);
      const days = Math.max(1, Math.min(MATCHI_MAX_DAYS, Math.floor(target.days) || 1));

      try {
        const facility = parseMatchiFacility(await get(`/facilities/${encodeURIComponent(slug)}`, "text/html"));
        if (!facility) return fail("changed", "the club page no longer names its facility id");
        if (!facility.sportId) return { ok: true, slots: [], requests };

        const slots: ScrapedSlot[] = [];
        for (let i = 0; i < days; i++) {
          const date = localDay(now, target.tz, i);
          const q = new URLSearchParams({ wl: "", facility: facility.facilityId, date, sport: facility.sportId, week: "", year: "" });
          const parsed = parseMatchiSlots(await get(`/book/listSlots?${q}`, "text/html"), date, target.tz);
          if (!parsed.ok) return fail("changed", `${date}: ${parsed.detail}`);
          // Today's list still shows an hour that has begun; nobody can play it any more.
          slots.push(...parsed.slots.filter((s) => Date.parse(s.start) >= now.getTime()));
        }
        slots.sort((a, b) => a.start.localeCompare(b.start) || (a.court ?? "").localeCompare(b.court ?? ""));
        return { ok: true, slots, requests };
      } catch (e) {
        if (e instanceof Stop) return { ok: false, status: e.status, reason: e.reason, requests, detail: e.message };
        return fail("error", e instanceof Error ? e.message : String(e));
      }
    },
  };
}

export const matchiAdapter: AvailabilityAdapter = createMatchiAdapter();
