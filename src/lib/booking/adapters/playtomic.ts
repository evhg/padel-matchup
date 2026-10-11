import { isValidTimeZone, utcToZonedParts } from "@/lib/dates";
import { fnv1a } from "../linkKey";
import type { AvailabilityAdapter, BuilderReport, ScrapedSlot, ScrapeFailure, ScrapeResult, ScrapeTarget } from "./types";
import { errorClass } from "./errorClass";

/**
 * Free courts on Playtomic, read the way an anonymous visitor's browser reads them.
 *
 * What the public club page does (checked 10 October 2026 on /clubs/the-padel-co, Bangkok, and
 * /clubs/the-cage-padel-tribe, Singapore, with no cookie and no login):
 *   1. https://playtomic.com/clubs/<slug> is server-rendered. Its Next.js payload
 *      (self.__next_f.push) carries `"tenant":{tenant_id, slug, address.timezone, resources:
 *      [{resourceId, name, sport}], opening_hours}`.
 *   2. The booking grid then calls, from the browser, without credentials:
 *      GET https://playtomic.com/api/clubs/availability?tenant_id=<uuid>&date=<club's local day>&sport_id=PADEL
 *      → [{resource_id, start_date, slots: [{start_time: "HH:MM:SS", duration: minutes, price: "1000 THB"}]}]
 *      start_date + start_time is a UTC instant (the page reads both with zone "UTC"): a club in
 *      Singapore that opens at 07:00 shows its first slot as start_date "2026-10-10", "23:00:00".
 *      Only free start times are listed, one per offered duration; booked time is simply absent.
 *   3. "Continue" opens /api/web-app/payments?type=CUSTOMER_MATCH&tenant_id&resource_id&start&duration&sport_id,
 *      Playtomic's own checkout. This file never follows it. The owner decided on 11 October 2026,
 *      "Playtomic checkout, filled" (DECIDING rule 36): "Book this court" on the match page opens this
 *      checkout in the player's browser (`checkoutFor` in prepare.ts), built from the exact starts the
 *      frame keeps (`offersFromScrape`), else the club's day page. The link is not documented, so a read
 *      of the club page also checks that its scripts still build it (`builderCheck`, below).
 *
 * A read of today alone takes one request: the tenant id from the club's last clean read comes back as
 * `target.ref`, so the club page is not read again. The frame hands it back only while the club's link is
 * the one that read gave it (`prevForLink` in scrape.ts). A full read (all three days, about hourly)
 * takes the tenant id from the club page. It reads the page only when this process has no copy of that
 * page from the last 24 hours (`clubCache`, keyed by the page), so a full read is three or four requests.
 *
 * Limits: an honest User-Agent, one request a second to Playtomic, at most 8 requests a call,
 * 10 seconds per request, the club page cached for a day. 401, 403 and 429 mean stop ("blocked").
 * No sign-in, no cookie, no booking: this file only reads.
 *
 * robots.txt: Playtomic's (read 10 October 2026) disallows /api, /*?*date= and /*?*sport=, and step 2
 * above asks for exactly that. This reader reads those paths under the owner's decision of 10 October
 * 2026 (DECIDING rule 35): "platforms forbid scraping in their terms but we are just testing ... So
 * scraping at risk of being blocked is acceptable, just do it." robots.txt does not bind a reader under
 * that rule; the frame keeps the load low instead (today every 15 minutes, the next two days about
 * hourly) and stops at the first sign of a block.
 */

export const PLAYTOMIC_UA = "KicksmashBot/1.0 (+https://kicksma.sh/about)";
const ORIGIN = "https://playtomic.com";
const HOSTS = ["playtomic.com", "playtomic.io"];
export const MAX_REQUESTS = 8;
export const REQUEST_TIMEOUT_MS = 10_000;
export const MIN_GAP_MS = 1_000;
const MAX_BYTES = 3_000_000;
const CLUB_TTL_MS = 24 * 3600_000;
const CLUB_CACHE_MAX = 500;
const MAX_SLOTS = 5_000;
const SPORT = "PADEL";

export type PlaytomicCourt = { id: string; name: string; sport: string | null };
export type PlaytomicClub = { tenantId: string; slug: string; name: string | null; timezone: string | null; courts: PlaytomicCourt[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/i;
const LOCALE = /^[a-z]{2}(?:[-_][a-z]{2})?$/i;

/**
 * The public club page behind a Playtomic link, or null when the link is not one we can read.
 * Accepts playtomic.com/clubs/<slug>, playtomic.io/clubs/<slug>, a locale before /clubs/
 * (/es/clubs/<slug>), and the old playtomic.io/<slug>/<tenant uuid>, which redirects to /clubs/<slug>.
 */
export function playtomicClubPage(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (!HOSTS.some((h) => host === h || host === `www.${h}`)) return null;
  const segs = u.pathname.split("/").filter(Boolean);
  const at = segs[0] === "clubs" ? 0 : LOCALE.test(segs[0] ?? "") && segs[1] === "clubs" ? 1 : -1;
  if (at >= 0) {
    const slug = segs[at + 1];
    return slug && SLUG.test(slug) && segs.length === at + 2 ? `${ORIGIN}/clubs/${slug.toLowerCase()}` : null;
  }
  if (segs.length === 2 && SLUG.test(segs[0]) && UUID.test(segs[1])) return `https://playtomic.io/${segs[0].toLowerCase()}/${segs[1].toLowerCase()}`;
  return null;
}

/** Joins the string chunks of a Next.js App Router payload (self.__next_f.push([1,"…"])). */
function nextPayload(html: string): string {
  let out = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\[\s\S])*")\]\)/g)) {
    try {
      out += JSON.parse(m[1]) as string;
    } catch {
      /* a chunk we cannot read is skipped */
    }
  }
  return out;
}

/** The balanced JSON object that starts at `from` (a "{"), or null. Strings are respected. */
function objectAt(text: string, from: number): unknown {
  if (text[from] !== "{") return null;
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(from, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * The scripts the club page loads (`<script src="/_next/static/chunks/…js">`), in page order, each once,
 * 64 at most. Found by `indexOf`, never a pattern that can backtrack over a stranger's page. Pure.
 */
export function playtomicScripts(html: string): string[] {
  const out: string[] = [];
  const marker = 'src="/_next/static/chunks/';
  for (let at = html.indexOf(marker); at >= 0 && out.length < 64; at = html.indexOf(marker, at + marker.length)) {
    const from = at + 'src="'.length;
    const end = html.indexOf('"', from);
    if (end < 0 || end - from > 200) continue;
    const path = html.slice(from, end);
    if (/^\/_next\/static\/chunks\/[A-Za-z0-9._%/-]+\.js$/.test(path) && !path.includes("..") && !out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * Does this script build the checkout link the way Playtomic's "Continue" did on 11 October 2026?
 * `new URL("/api/web-app/payments"…)`, then the six parameters in order (type CUSTOMER_MATCH,
 * tenant_id, resource_id, start, duration, sport_id) within 2,000 characters, and the start written in
 * UTC as ISO (`toUTC().toISO()`). Minified names change at every deploy; these strings do not. Pure.
 */
export function holdsCheckoutBuilder(js: string): boolean {
  const head = 'new URL("/api/web-app/payments"';
  const steps = ['.set("type","CUSTOMER_MATCH")', '.set("tenant_id",', '.set("resource_id",', '.set("start",', '.set("duration",', '.set("sport_id",'];
  for (let at = js.indexOf(head); at >= 0; at = js.indexOf(head, at + head.length)) {
    const near = js.slice(at, at + 2_000);
    let from = 0;
    const found = steps.map((step) => {
      const i = near.indexOf(step, from);
      if (i >= 0) from = i + step.length;
      return i;
    });
    if (found.some((i) => i < 0)) continue;
    if (near.slice(found[3], found[4]).includes("toUTC().toISO()")) return true;
  }
  return false;
}

/** The figures a script's file name starts with ("7105" in 7105-b679921c03870a3f.js), which a new build of the same code often keeps. */
export const chunkNumber = (path: string): number | null => {
  const m = /\/(\d{1,6})-[0-9a-f]{8,}\.js$/.exec(path);
  return m ? Number(m[1]) : null;
};

/** Scripts that are the framework itself (webpack, React's runtime, the layout, the error pages) never build a checkout. */
const FRAMEWORK = /\/(webpack|main-app|main|polyfills|framework|layout|error|global-error|not-found|loading)-[0-9a-f]+\.js$/;
/** The scripts one read fetches at most while it looks for the builder: two seconds of the platform's pace. */
export const BUILDER_HUNT = 2;

/**
 * Which of the page's scripts to read first while looking for the builder: the one whose figures match
 * the last known script's, then the others, turned by the quarter hour so that one read after another
 * tries different scripts. Pure.
 */
export function huntOrder(scripts: readonly string[], chunk: number | null, now: Date): string[] {
  const candidates = scripts.filter((s) => !FRAMEWORK.test(s));
  const first = chunk === null ? [] : candidates.filter((s) => chunkNumber(s) === chunk);
  const rest = candidates.filter((s) => !first.includes(s));
  const turn = rest.length ? Math.floor(now.getTime() / (15 * 60_000)) % rest.length : 0;
  return [...first, ...rest.slice(turn), ...rest.slice(0, turn)];
}

/** Pure: the club, its time zone and its courts from the public club page's HTML, or null when the page no longer carries them. */
export function parsePlaytomicClubPage(html: string): PlaytomicClub | null {
  const payload = nextPayload(html);
  for (const m of payload.matchAll(/"tenant":\{"tenant_id"/g)) {
    const t = objectAt(payload, m.index! + '"tenant":'.length) as Record<string, unknown> | null;
    if (!t || typeof t.tenant_id !== "string" || !UUID.test(t.tenant_id) || !Array.isArray(t.resources)) continue;
    const courts: PlaytomicCourt[] = [];
    for (const r of t.resources as unknown[]) {
      const rr = r as Record<string, unknown> | null;
      if (!rr || typeof rr.resourceId !== "string" || typeof rr.name !== "string") return null;
      courts.push({ id: rr.resourceId, name: rr.name.trim().slice(0, 80), sport: typeof rr.sport === "string" ? rr.sport : null });
    }
    const address = t.address as Record<string, unknown> | undefined;
    const tz = typeof address?.timezone === "string" && isValidTimeZone(address.timezone) ? address.timezone : null;
    return { tenantId: t.tenant_id.toLowerCase(), slug: typeof t.slug === "string" ? t.slug : "", name: typeof t.tenant_name === "string" ? t.tenant_name : null, timezone: tz, courts };
  }
  return null;
}

/** The link Playtomic's own "Continue" button opens for one slot (its checkout; the player signs in there, never us). */
export function playtomicBookUrl(tenantId: string, resourceId: string, start: Date, minutes: number, sport = SPORT): string {
  const u = new URL("/api/web-app/payments", ORIGIN);
  u.searchParams.set("type", "CUSTOMER_MATCH");
  u.searchParams.set("tenant_id", tenantId);
  u.searchParams.set("resource_id", resourceId);
  u.searchParams.set("start", start.toISOString());
  u.searchParams.set("duration", String(minutes));
  u.searchParams.set("sport_id", sport);
  return u.toString();
}

export function playtomicAvailabilityUrl(tenantId: string, day: string, sport = SPORT): string {
  const u = new URL("/api/clubs/availability", ORIGIN);
  u.searchParams.set("tenant_id", tenantId);
  u.searchParams.set("date", day);
  u.searchParams.set("sport_id", sport);
  return u.toString();
}

/**
 * Pure: the free slots in one availability response, or null when the response no longer has
 * the fields we read (so a renamed field reads as "changed", never as "no free courts").
 * One slot per court, start and offered duration, as the page lists them; all free.
 */
export function parsePlaytomicAvailability(text: string, club: Pick<PlaytomicClub, "tenantId" | "courts">): ScrapedSlot[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(json)) return null;
  const names = new Map(club.courts.map((c) => [c.id, c.name]));
  const out: ScrapedSlot[] = [];
  for (const entry of json) {
    const e = entry as Record<string, unknown> | null;
    if (!e || typeof e.resource_id !== "string" || typeof e.start_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.start_date) || !Array.isArray(e.slots)) return null;
    for (const slot of e.slots as unknown[]) {
      const s = slot as Record<string, unknown> | null;
      if (!s || typeof s.start_time !== "string" || !/^\d{2}:\d{2}(?::\d{2})?$/.test(s.start_time) || typeof s.duration !== "number") return null;
      const minutes = Math.trunc(s.duration);
      if (minutes < 15 || minutes > 600) return null;
      const start = new Date(`${e.start_date}T${s.start_time.length === 5 ? `${s.start_time}:00` : s.start_time}Z`);
      if (Number.isNaN(start.getTime())) return null;
      const end = new Date(start.getTime() + minutes * 60_000);
      out.push({
        start: start.toISOString(),
        end: end.toISOString(),
        court: names.get(e.resource_id) ?? e.resource_id,
        courtId: e.resource_id,
        free: true,
        priceText: typeof s.price === "string" && s.price.trim() ? s.price.trim().slice(0, 40) : null,
        bookUrl: playtomicBookUrl(club.tenantId, e.resource_id, start, minutes),
      });
      if (out.length >= MAX_SLOTS) return out;
    }
  }
  return out;
}

/** yyyy-mm-dd, `offset` days after the local day of `now` in `tz`. */
export function playtomicDay(now: Date, tz: string, offset: number): string {
  const [y, m, d] = utcToZonedParts(now, tz).date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

// --- the network side: pacing, the club page cache, one request at a time -------------------

const clubCache = new Map<string, { at: number; club: PlaytomicClub }>();
let nextAllowedAt = 0;

/** Tests only: forget the cached club pages and the pacing clock. */
export function resetPlaytomicState(): void {
  clubCache.clear();
  nextAllowedAt = 0;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One request a second to Playtomic from this process, whatever club it is for. */
async function pace(): Promise<void> {
  const now = Date.now();
  const wait = nextAllowedAt - now;
  nextAllowedAt = Math.max(now, nextAllowedAt) + MIN_GAP_MS;
  if (wait > 0) await sleep(wait);
}

type Got = { kind: "response"; status: number; text: string } | { kind: "timeout" } | { kind: "error"; detail: string };


async function get(url: string, fetchImpl: typeof fetch, accept: string): Promise<Got> {
  await pace();
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Got>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve({ kind: "timeout" });
    }, REQUEST_TIMEOUT_MS);
  });
  const request = (async (): Promise<Got> => {
    try {
      const res = await fetchImpl(url, { headers: { "user-agent": PLAYTOMIC_UA, accept }, signal: ctrl.signal, redirect: "follow" });
      const text = res.ok ? (await res.text()).slice(0, MAX_BYTES) : "";
      return { kind: "response", status: res.status, text };
    } catch (e) {
      // The frame's own stop (budget, cap, a block) is the frame's to judge, not this club's error.
      if (e instanceof Error && e.name === "ScrapeStop") throw e;
      // An abort, ours or the frame's deadline, is a timeout.
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return { kind: "timeout" };
      return { kind: "error", detail: errorClass(e) };
    }
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const fail = (reason: ScrapeFailure, status: number | null, requests: number, detail: string | null): ScrapeResult => ({ ok: false, status, reason, requests, detail });

/** A failed response, or null when the status is a success. */
function failureOf(got: Got, requests: number, what: string): ScrapeResult | null {
  // The class, never a sentence: `failureWhy` keeps only a class or a status after the step.
  if (got.kind === "timeout") return fail("timeout", null, requests, `${what}: TimeoutError`);
  if (got.kind === "error") return fail("error", null, requests, `${what}: ${got.detail}`);
  if (got.status === 401 || got.status === 403 || got.status === 429) return fail("blocked", got.status, requests, `${what}: HTTP ${got.status}`);
  if (got.status === 404 || got.status === 410) return fail("not_found", got.status, requests, `${what}: HTTP ${got.status}`);
  if (got.status < 200 || got.status > 299) return fail("error", got.status, requests, `${what}: HTTP ${got.status}`);
  return null;
}

async function scrape(target: ScrapeTarget, fetchImpl: typeof fetch, now: Date): Promise<ScrapeResult> {
  const page = playtomicClubPage(target.bookingUrl);
  if (!page) return fail("error", null, 0, "not a Playtomic club link");
  let requests = 0;

  // Today alone, a tenant id from the last clean read and the club's own zone: no club page to read.
  const zone = target.tz && isValidTimeZone(target.tz) ? target.tz : null;
  const known = target.days === 1 && typeof target.ref === "string" && UUID.test(target.ref) && zone ? { at: now.getTime(), club: { tenantId: target.ref.toLowerCase(), slug: "", name: null, timezone: zone, courts: [] } } : null;
  let club = known ?? clubCache.get(page);
  // The club page's HTML when this read fetched it: the checkout builder is checked on it (`builderCheck`).
  let pageHtml: string | null = null;
  if (!club || now.getTime() - club.at > CLUB_TTL_MS || now.getTime() < club.at) {
    const got = await get(page, fetchImpl, "text/html");
    requests++;
    const failed = failureOf(got, requests, "club page");
    if (failed) return failed;
    pageHtml = (got as { text: string }).text;
    const parsed = parsePlaytomicClubPage(pageHtml);
    if (!parsed) return fail("changed", (got as { status: number }).status, requests, "club page has no tenant and courts");
    club = { at: now.getTime(), club: parsed };
    clubCache.set(page, club);
    if (clubCache.size > CLUB_CACHE_MAX) clubCache.delete(clubCache.keys().next().value!);
  }

  // The club row's zone, else the one the page gives (address.timezone); never a guess.
  const tz = target.tz && isValidTimeZone(target.tz) ? target.tz : club.club.timezone;
  if (!tz) return fail("error", null, requests, "no time zone");
  const days = Math.max(1, Math.min(MAX_REQUESTS - requests, Math.trunc(Number.isFinite(target.days) ? target.days : 1)));
  const seen = new Set<string>();
  const slots: ScrapedSlot[] = [];
  for (let i = 0; i < days; i++) {
    const day = playtomicDay(now, tz, i);
    const got = await get(playtomicAvailabilityUrl(club.club.tenantId, day), fetchImpl, "application/json");
    requests++;
    const failed = failureOf(got, requests, `availability ${day}`);
    if (failed) return failed;
    const parsed = parsePlaytomicAvailability((got as { text: string }).text, club.club);
    if (!parsed) return fail("changed", (got as { status: number }).status, requests, `availability ${day} lacks resource_id, start_date or slots[].start_time/duration`);
    for (const s of parsed) {
      if (Date.parse(s.start) <= now.getTime()) continue;
      const key = `${s.court}|${s.start}|${s.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push(s);
    }
  }
  slots.sort((a, b) => a.start.localeCompare(b.start) || (a.court ?? "").localeCompare(b.court ?? "") || a.end.localeCompare(b.end));
  // After the times, never before them: the check spends what the read left of its eight requests.
  const checked = target.checkout && pageHtml !== null ? await builderCheck(pageHtml, target.checkout, { fetchImpl, now, left: MAX_REQUESTS - requests }) : null;
  return { ok: true, slots, requests: requests + (checked?.requests ?? 0), tz, ref: club.club.tenantId, ...(checked ? { builder: checked.report } : {}) };
}

/**
 * Does the club page still build the checkout link "Book this court" fills (the owner's decision of 11
 * October 2026, DECIDING rule 36)? The link is not documented, so the check reads the code that makes
 * it. Next.js names a script after its content, so while the page loads the script known to build it,
 * the code is the same (`same`, no request). When that script is gone, and the frame allows (`hunt`),
 * the read fetches at most `BUILDER_HUNT` of the page's other scripts, one a second, and looks for the
 * builder (`holdsCheckoutBuilder`): `found` gives the new script, `lost` says how many it read. The frame
 * turns the checkout off while it is lost (`writeOffers` in scrape.ts). A request that fails ends the
 * look and keeps the times this read found.
 */
async function builderCheck(html: string, c: NonNullable<ScrapeTarget["checkout"]>, o: { fetchImpl: typeof fetch; now: Date; left: number }): Promise<{ report: BuilderReport; requests: number }> {
  const scripts = playtomicScripts(html);
  if (scripts.some((s) => fnv1a(s) === c.builder)) return { report: { state: "same" }, requests: 0 };
  const order = huntOrder(scripts, c.chunk, o.now);
  let requests = 0;
  let checked = 0;
  for (const path of c.hunt ? order.slice(0, Math.max(0, Math.min(BUILDER_HUNT, o.left))) : []) {
    let got: Got;
    try {
      got = await get(new URL(path, ORIGIN).toString(), o.fetchImpl, "*/*");
    } catch {
      break;
    }
    requests++;
    if (got.kind !== "response" || got.status !== 200) break;
    checked++;
    if (holdsCheckoutBuilder(got.text)) return { report: { state: "found", key: fnv1a(path), chunk: chunkNumber(path) }, requests };
  }
  return { report: { state: "lost", checked, of: order.length }, requests };
}

export const playtomicAdapter: AvailabilityAdapter = {
  platform: "playtomic",
  matches: (url: string) => playtomicClubPage(url) !== null,
  scrape,
};
