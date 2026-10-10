import { isValidTimeZone, utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";
import type { AvailabilityAdapter, ScrapedSlot, ScrapeResult, ScrapeTarget } from "./types";

/**
 * Book & Go (bookandgo.app): the white-label booking system behind club apps that live on the club's
 * own domain, so a club's booking link never says "bookandgo". The host of the link names the club's
 * app (`BOOKANDGO_APPS`); a host we have not mapped is not read.
 *
 * What the club's public web app loads (read on 10 October 2026 for apps 39, 51 and 83, no cookie,
 * no key, no login). Prime Padel's own page, app.primepadelsport.com/availability.html, documents the
 * same two calls: "no authentication, CORS enabled … Please poll gently".
 *   1. GET https://api.bookandgo.app/api/v1/apps/{app}/locations → {data: [{id, location_name,
 *      currency, timezone, sports: [{sport_name, bookings: [{duration}], courts: [{id, court_name}]}]}]}.
 *      An app id Book & Go does not know answers 200 with `data: []`.
 *   2. GET https://api.bookandgo.app/api/v1/apps/{app}/court-bookings?sport_name=Padel&date=YYYY-MM-DD
 *      → {data: {bookings: [...]}}, one entry per location and length (60, 90 or 120 minutes): its
 *      base `price`, its price rows (`bookabledays`), and `location.courts[].timings[]` with `date` and
 *      `available_time_slots`, the free START times ("HH:MM:SS", the club's wall clock). A start listed
 *      under the 90-minute entry means that court is free for 90 minutes from then; booked time is
 *      simply absent, and no booking names anybody. Today's list still shows the hours that began.
 *      One answer carries every location of the app, so two clubs of one app read the same address,
 *      and the frame's cache answers the second.
 *
 * The price of a slot follows the club's own page: rows for that date first, then rows for that
 * weekday, each holding the start times of a window; else the base price. Where two windows that
 * hold the start disagree, the one that holds the whole booking decides; where that still disagrees,
 * or the price is 0 ("see the app"), the slot has no price rather than a wrong one.
 *
 * Times are read in the venue's own zone (`timezone` on the location), else the club row's; with
 * neither the reader says "no time zone" and never guesses, and a clean read says which zone it used.
 * Each slot carries the court's own id (`courtId`), so the cache counts two courts with one name apart.
 *
 * Manners (DECIDING rule 35): no sign-in, no key, no cookie, an honest User-Agent, one request a
 * second, at most eight a call, 10 seconds each, and a 401, 403 or 429 stops the call. It only reads.
 */

export const BOOKANDGO_API = "https://api.bookandgo.app/api/v1";
export const BOOKANDGO_USER_AGENT = "KicksmashBot/1.0 (+https://kicksma.sh/about)";
export const BOOKANDGO_MAX_REQUESTS = 8;
export const BOOKANDGO_TIMEOUT_MS = 10_000;
export const BOOKANDGO_MIN_GAP_MS = 1_000;
/** One list of locations plus one day a request: seven days fill the budget. */
export const BOOKANDGO_MAX_DAYS = BOOKANDGO_MAX_REQUESTS - 1;
const MAX_BYTES = 3_000_000;
const MAX_SLOTS = 5_000;

/** A club's Book & Go app; `locations` names the venue per club slug where one app runs several padel venues. */
export type BookandgoApp = { app: number; locations?: Readonly<Record<string, number>> };

const PRIME_PADEL: BookandgoApp = { app: 39, locations: { "prime-padel-dempsey": 93, "prime-padel-havelock": 73 } };
const STERLING: BookandgoApp = { app: 83 };

/**
 * The club apps we know, by the host of the club's booking link (each read on 10 October 2026). A new
 * Book & Go club is one line here: its booking host and its app id, from its public web app.
 */
export const BOOKANDGO_APPS: Readonly<Record<string, BookandgoApp>> = {
  // Prime Padel, Singapore: Dempsey (location 93) and Grand Copthorne Waterfront on Havelock Road (73).
  "app.primepadelsport.com": PRIME_PADEL,
  "primepadelweb.web.app": PRIME_PADEL,
  // MBP Sports, Singapore: Marina Square Padel is the app's one padel venue.
  "mbpsports.web.app": { app: 51 },
  // Sterling Sport & Wellness, Bangkok: book.sterlingbkk.com redirects to sterling-sports.web.app.
  "sterling-sports.web.app": STERLING,
  "book.sterlingbkk.com": STERLING,
};

const APP_PATH = /\/apps\/(\d{1,7})(?:\/|$)/;

/**
 * The Book & Go app behind a booking link, or null: a mapped club host, or a bookandgo.app link that
 * names its app (`…/apps/39…`). `bookUrl` is the club's booking page, null for a bookandgo.app link. Pure.
 */
export function bookandgoApp(url: string): (BookandgoApp & { bookUrl: string | null }) | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const known = Object.hasOwn(BOOKANDGO_APPS, host) ? BOOKANDGO_APPS[host] : undefined;
  if (known) return { ...known, bookUrl: `https://${host}/` };
  if (host !== "bookandgo.app" && !host.endsWith(".bookandgo.app")) return null;
  const m = u.pathname.match(APP_PATH);
  return m ? { app: Number(m[1]), bookUrl: null } : null;
}

export type BookandgoLocation = { id: number; name: string; timezone: string | null; padel: string | null };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The app's locations, each with its zone and the name it gives padel, or null when the answer lacks those fields. Pure. */
export function parseBookandgoLocations(text: string): BookandgoLocation[] | null {
  const json = parseJson(text);
  if (!isRecord(json) || !Array.isArray(json.data)) return null;
  const out: BookandgoLocation[] = [];
  for (const l of json.data) {
    if (!isRecord(l) || !Number.isInteger(l.id) || typeof l.location_name !== "string" || !Array.isArray(l.sports)) return null;
    const names: string[] = [];
    for (const s of l.sports) {
      if (!isRecord(s) || typeof s.sport_name !== "string") return null;
      names.push(s.sport_name);
    }
    const padel = names.find((n) => n.trim().toLowerCase() === "padel") ?? names.find((n) => /padel/i.test(n)) ?? null;
    const tz = typeof l.timezone === "string" && isValidTimeZone(l.timezone) ? l.timezone : null;
    out.push({ id: l.id as number, name: l.location_name.trim().slice(0, 80), timezone: tz, padel });
  }
  return out;
}

export type LocationPick = { kind: "location"; location: BookandgoLocation } | { kind: "no_padel" } | { kind: "not_found"; detail: string };

/**
 * The venue a club reads: the one its slug names in `BOOKANDGO_APPS`, else the app's only padel venue.
 * An app with several padel venues and none named for this club is not guessed. Pure.
 */
export function pickBookandgoLocation(locations: readonly BookandgoLocation[], app: BookandgoApp, clubSlug: string): LocationPick {
  if (!locations.length) return { kind: "not_found", detail: `app ${app.app} lists no locations` };
  const named = app.locations && Object.hasOwn(app.locations, clubSlug) ? app.locations[clubSlug] : undefined;
  if (named !== undefined) {
    const location = locations.find((l) => l.id === named);
    if (!location) return { kind: "not_found", detail: `app ${app.app} no longer lists location ${named}` };
    return location.padel ? { kind: "location", location } : { kind: "no_padel" };
  }
  const padel = locations.filter((l) => l.padel);
  if (padel.length === 1) return { kind: "location", location: padel[0] };
  if (!padel.length) return { kind: "no_padel" };
  return { kind: "not_found", detail: `app ${app.app} has ${padel.length} padel locations and names none for ${clubSlug}` };
}

/** One price row (`bookabledays`): a window of start times, on a weekday or between two dates. */
export type BookandgoPriceRow = { start_time: string; end_time: string; days: string | null; date_start: string | null; date_end: string | null; price: number };

const TIME = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const WINDOW_TIME = /^(?:[01]\d|2[0-4]):[0-5]\d(?::[0-5]\d)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** The price rows, or null when one of them is unreadable (then no slot of that length gets a price). */
function priceRows(v: unknown): BookandgoPriceRow[] | null {
  if (!Array.isArray(v)) return null;
  const out: BookandgoPriceRow[] = [];
  for (const r of v) {
    if (!isRecord(r) || typeof r.start_time !== "string" || typeof r.end_time !== "string" || !WINDOW_TIME.test(r.start_time) || !WINDOW_TIME.test(r.end_time)) return null;
    if (typeof r.price !== "number" || !Number.isFinite(r.price)) return null;
    const text = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : null);
    out.push({ start_time: r.start_time, end_time: r.end_time, days: text("days"), date_start: text("date_start"), date_end: text("date_end"), price: r.price });
  }
  return out;
}

/**
 * The price of one booking of `minutes` from `start` ("HH:MM:SS") on the club's day `date`, or null
 * when it is 0 or the rows disagree. Rows for that date beat rows for that weekday; each holds the
 * start times in [start_time, end_time). Pure.
 */
export function bookandgoPrice(rows: readonly BookandgoPriceRow[], base: number | null, date: string, start: string, minutes: number): number | null {
  const from = minutesOf(start);
  const to = from + minutes;
  const day = Date.parse(`${date}T00:00:00Z`);
  const weekday = WEEKDAYS[new Date(day).getUTCDay()];
  const holds = (r: BookandgoPriceRow) => minutesOf(r.start_time) <= from && from < minutesOf(r.end_time);
  const dated = rows.filter((r) => !r.days && r.date_start && r.date_end && Date.parse(r.date_start) <= day && day <= Date.parse(r.date_end) && holds(r));
  const decide = dated.length ? dated : rows.filter((r) => r.days === weekday && holds(r));
  const one = (rs: readonly BookandgoPriceRow[]) => {
    const prices = [...new Set(rs.map((r) => r.price))];
    return prices.length === 1 ? prices[0] : undefined;
  };
  const price = decide.length ? (one(decide) ?? one(decide.filter((r) => to <= minutesOf(r.end_time))) ?? null) : base;
  return price !== null && price > 0 ? price : null;
}

/**
 * The free slots of one location on one local day, from one court-bookings answer, in UTC; null when
 * the answer lacks the fields read (so a renamed field reads as "changed", never as "no free courts").
 * Every slot is free: booked time is not in the answer. Pure.
 */
export function parseBookandgoDay(text: string, o: { locationId: number; date: string; tz: string; bookUrl: string | null }): ScrapedSlot[] | null {
  const json = parseJson(text);
  if (!isRecord(json) || !isRecord(json.data) || !Array.isArray(json.data.bookings)) return null;
  const out: ScrapedSlot[] = [];
  for (const b of json.data.bookings) {
    if (!isRecord(b) || typeof b.duration !== "number" || !isRecord(b.location) || !Number.isInteger(b.location.id) || !Array.isArray(b.location.courts)) return null;
    if (b.location.id !== o.locationId) continue;
    const minutes = Math.trunc(b.duration);
    if (minutes < 15 || minutes > 600) return null;
    const currency = typeof b.location.currency === "string" && /^[A-Z]{3}$/.test(b.location.currency.trim()) ? b.location.currency.trim() : null;
    const rows = priceRows(b.bookabledays);
    const base = typeof b.price === "number" && Number.isFinite(b.price) ? b.price : null;
    for (const c of b.location.courts) {
      if (!isRecord(c) || typeof c.court_name !== "string" || !Array.isArray(c.timings)) return null;
      for (const t of c.timings) {
        if (!isRecord(t) || typeof t.date !== "string" || !DATE.test(t.date) || !Array.isArray(t.available_time_slots)) return null;
        if (t.date !== o.date) continue;
        for (const s of t.available_time_slots) {
          if (typeof s !== "string" || !TIME.test(s)) return null;
          const start = zonedTimeToUtc(o.date, s, o.tz);
          if (Number.isNaN(start.getTime())) return null;
          const price = rows && currency ? bookandgoPrice(rows, base, o.date, s, minutes) : null;
          out.push({
            start: start.toISOString(),
            end: new Date(start.getTime() + minutes * 60_000).toISOString(),
            court: c.court_name.trim().slice(0, 80) || null,
            // The court's own id, so two courts with one name stay two in the cache.
            courtId: Number.isInteger(c.id) ? String(c.id) : null,
            free: true,
            priceText: price !== null ? `${price} ${currency}` : null,
            bookUrl: o.bookUrl,
          });
          if (out.length >= MAX_SLOTS) return out;
        }
      }
    }
  }
  return out;
}

/** yyyy-mm-dd, `offset` days after the local day of `now` in `tz`. */
export function bookandgoDay(now: Date, tz: string, offset: number): string {
  const [y, m, d] = utcToZonedParts(now, tz).date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
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

export type BookandgoOptions = {
  /** Waits between requests; tests pass one that only records. */
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  timeoutMs?: number;
  minGapMs?: number;
};

export function createBookandgoAdapter(opts: BookandgoOptions = {}): AvailabilityAdapter {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = opts.clock ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? BOOKANDGO_TIMEOUT_MS;
  const minGapMs = opts.minGapMs ?? BOOKANDGO_MIN_GAP_MS;

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
    platform: "bookandgo",
    matches: (url: string) => bookandgoApp(url) !== null,

    async scrape(target: ScrapeTarget, fetchImpl: typeof fetch, now: Date): Promise<ScrapeResult> {
      let requests = 0;
      const fail = (reason: "changed" | "not_found" | "error", detail: string, status: number | null = null): ScrapeResult => ({ ok: false, status, reason, requests, detail });

      const get = async (path: string): Promise<string> => {
        if (requests >= BOOKANDGO_MAX_REQUESTS) throw new Stop("error", null, "request budget spent");
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
          const res = await fetchImpl(`${BOOKANDGO_API}${path}`, { headers: { "User-Agent": BOOKANDGO_USER_AGENT, Accept: "application/json" }, redirect: "follow", signal: ctrl.signal });
          if (res.status === 401 || res.status === 403 || res.status === 429) throw new Stop("blocked", res.status, `${res.status} on ${path}`);
          if (res.status === 404 || res.status === 410) throw new Stop("not_found", res.status, `${res.status} on ${path}`);
          if (!res.ok) throw new Stop("error", res.status, `${res.status} on ${path}`);
          return (await res.text()).slice(0, MAX_BYTES);
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

      const app = bookandgoApp(target.bookingUrl);
      if (!app) return fail("not_found", "no Book & Go app is known for this booking link");

      try {
        const locations = parseBookandgoLocations(await get(`/apps/${app.app}/locations`));
        if (!locations) return fail("changed", `app ${app.app}: the locations lack id, location_name or sports[].sport_name`);
        const pick = pickBookandgoLocation(locations, app, target.clubSlug);
        if (pick.kind === "not_found") return fail("not_found", pick.detail);
        // The club row's zone as the frame gives it, null included (DECIDING rule 35): never a guess.
        const given = target.tz && isValidTimeZone(target.tz) ? target.tz : null;
        if (pick.kind === "no_padel") return { ok: true, slots: [], requests, ...(given ? { tz: given } : {}) };
        const { location } = pick;
        // The venue's own zone first: the feed's times are its wall clock.
        const tz = location.timezone ?? given;
        if (!tz) return fail("error", "no time zone");

        const days = Math.max(1, Math.min(BOOKANDGO_MAX_DAYS, Math.trunc(Number.isFinite(target.days) ? target.days : 1)));
        const seen = new Set<string>();
        const slots: ScrapedSlot[] = [];
        for (let i = 0; i < days; i++) {
          const date = bookandgoDay(now, tz, i);
          const q = new URLSearchParams({ sport_name: location.padel!, date });
          const parsed = parseBookandgoDay(await get(`/apps/${app.app}/court-bookings?${q}`), { locationId: location.id, date, tz, bookUrl: app.bookUrl });
          if (!parsed) return fail("changed", `app ${app.app} ${date}: the court bookings lack duration, location.courts[].timings[] or available_time_slots`);
          for (const s of parsed) {
            // Today's list still shows the hours that began; nobody can play them any more.
            if (Date.parse(s.start) < now.getTime()) continue;
            const key = `${s.court}|${s.start}|${s.end}`;
            if (seen.has(key)) continue;
            seen.add(key);
            slots.push(s);
          }
        }
        slots.sort((a, b) => a.start.localeCompare(b.start) || (a.court ?? "").localeCompare(b.court ?? "") || a.end.localeCompare(b.end));
        return { ok: true, slots, requests, tz };
      } catch (e) {
        if (e instanceof Stop) return { ok: false, status: e.status, reason: e.reason, requests, detail: e.message };
        return fail("error", e instanceof Error ? e.message : String(e));
      }
    },
  };
}

export const bookandgoAdapter: AvailabilityAdapter = createBookandgoAdapter();
