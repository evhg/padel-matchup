import { and, eq, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, type Club, type ClubAvailability, type ClubFreeSlot } from "@/db/schema";
import { isValidTimeZone, zonedTimeToUtc } from "@/lib/dates";

/**
 * Free courts, from two sources, cached on the club row (`clubs.availability`, `availability_at`).
 *
 * 1. A feed the club shares, refreshed hourly here:
 *   - ics_bookings: a calendar feed of its bookings (most booking systems and
 *     Google Calendar export one). Free courts = courts − overlapping bookings,
 *     hour by hour, inside opening hours.
 *   - json_free: a JSON document of free slots, {"slots":[{"start","end","free"}]}.
 * 2. The free court times a booking platform shows on its public club page, read every fifteen
 *    minutes by `scrape.ts` through one reader per platform (`adapters/`). A feed the club shared
 *    always wins over a read for that club.
 *
 * This header said "No scraping, no credentials, nothing a club did not hand us" from 7 September
 * 2026; a session wrote that line, and the owner never asked for it. The owner's decision of
 * 10 October 2026 replaces it (DECIDING rule 32): "platforms forbid scraping in their terms but we
 * are just testing, and on top every app scrapes every other app, for example padel society scrapes
 * playtomic and matchi for court availability. So scraping at risk of being blocked is acceptable,
 * just do it." What stays: we never sign in to a platform, never store a player's password, token or
 * session, never book, reserve, pay or post there, and never get around a login wall, a captcha or a
 * block. The player books and pays on the platform.
 */
export const AVAILABILITY_KINDS = ["ics_bookings", "json_free"] as const;
export type AvailabilityKind = (typeof AVAILABILITY_KINDS)[number];
export const DEFAULT_HOURS = { opensAt: "07:00", closesAt: "23:00" } as const;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 2_000_000;

export type Booking = { start: Date; end: Date; summary: string | null };

/** Unfolds RFC 5545 line continuations and splits into lines. */
const unfold = (text: string) => text.replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");

/** DTSTART/DTEND values: 20260906T170000Z, 20260906T170000 (floating, read in tz), 20260906 (all-day: skipped). */
export function parseIcsDate(value: string, params: Record<string, string>, fallbackTz: string): Date | null {
  const v = value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  if (!m[4]) return null; // all-day
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0)));
  const tz = params.TZID && isValidTimeZone(params.TZID) ? params.TZID : fallbackTz;
  const date = zonedTimeToUtc(`${y}-${mo}-${d}`, `${h}:${mi}`, tz);
  if (Number.isNaN(date.getTime())) return null;
  return s && s !== "00" ? new Date(date.getTime() + Number(s) * 1000) : date;
}

/** ISO 8601 durations as calendars write them: PT1H30M, P1D, PT90M. */
export function parseDuration(v: string): number | null {
  const m = v.trim().match(/^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, neg, w, d, h, mi, s] = m;
  const ms = ((+(w ?? 0) * 7 + +(d ?? 0)) * 86400 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000;
  return neg ? -ms : ms;
}

/** VEVENTs with a start and an end, cancelled ones dropped. Pure. */
export function parseIcs(text: string, fallbackTz = "UTC"): Booking[] {
  const out: Booking[] = [];
  let cur: Record<string, { value: string; params: Record<string, string> }> | null = null;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur) {
        const status = cur.STATUS?.value.toUpperCase();
        const start = cur.DTSTART ? parseIcsDate(cur.DTSTART.value, cur.DTSTART.params, fallbackTz) : null;
        let end = cur.DTEND ? parseIcsDate(cur.DTEND.value, cur.DTEND.params, fallbackTz) : null;
        if (start && !end && cur.DURATION) {
          const ms = parseDuration(cur.DURATION.value);
          if (ms != null) end = new Date(start.getTime() + ms);
        }
        if (start && end && end > start && status !== "CANCELLED") out.push({ start, end, summary: cur.SUMMARY?.value.replace(/\\,/g, ",").replace(/\\n/g, " ").trim() || null });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const head = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = head.split(";");
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
    }
    cur[name.toUpperCase()] = { value, params };
  }
  return out;
}

/** "07:00" → 7; anything odd falls back. */
const hourOf = (hhmm: string | null | undefined, fallback: number) => {
  const m = (hhmm ?? "").match(/^(\d{1,2}):?(\d{2})?$/);
  const h = m ? Number(m[1]) : NaN;
  return Number.isInteger(h) && h >= 0 && h <= 24 ? h : fallback;
};

/** yyyy-mm-dd of `now` in the club's time zone. */
export function localDay(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type HoursSpec = { courts: number; opensAt?: string | null; closesAt?: string | null; tz: string; day: string; now?: Date };

/** Hour by hour inside opening hours: free = courts − bookings overlapping the hour. Past hours are dropped. Pure. */
export function freeSlotsFromBookings(bookings: readonly Booking[], o: HoursSpec): ClubFreeSlot[] {
  const open = hourOf(o.opensAt, hourOf(DEFAULT_HOURS.opensAt, 7));
  const close = hourOf(o.closesAt, hourOf(DEFAULT_HOURS.closesAt, 23));
  const out: ClubFreeSlot[] = [];
  const courts = Math.max(1, Math.min(64, Math.trunc(o.courts)));
  for (let h = open; h < close; h++) {
    const start = zonedTimeToUtc(o.day, `${String(h).padStart(2, "0")}:00`, o.tz);
    const end = new Date(start.getTime() + 3600_000);
    if (o.now && end <= o.now) continue;
    const busy = bookings.filter((b) => b.start < end && b.end > start).length;
    const free = Math.max(0, courts - busy);
    if (free > 0) out.push({ start: start.toISOString(), end: end.toISOString(), free });
  }
  return out;
}

/** {"slots":[{"start": ISO, "end": ISO, "free"?: n}]}, tolerant of a bare array. Only today's future slots are kept. */
export function parseFreeJson(json: unknown, o: { day: string; tz: string; now?: Date }): ClubFreeSlot[] {
  const raw = Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as { slots?: unknown }).slots) ? (json as { slots: unknown[] }).slots : [];
  const out: ClubFreeSlot[] = [];
  for (const r of raw.slice(0, 500)) {
    if (!r || typeof r !== "object") continue;
    const s = r as { start?: unknown; end?: unknown; free?: unknown; courts?: unknown };
    const start = typeof s.start === "string" ? new Date(s.start) : null;
    const end = typeof s.end === "string" ? new Date(s.end) : start ? new Date(start.getTime() + 3600_000) : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;
    if (localDay(start, o.tz) !== o.day) continue;
    if (o.now && end <= o.now) continue;
    const free = Number(s.free ?? s.courts ?? 1);
    out.push({ start: start.toISOString(), end: end.toISOString(), free: Number.isFinite(free) && free > 0 ? Math.min(64, Math.trunc(free)) : 1 });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

export const availabilityConfigured = (c: Pick<Club, "availabilityUrl" | "availabilityKind">) => Boolean(c.availabilityUrl && c.availabilityKind && (AVAILABILITY_KINDS as readonly string[]).includes(c.availabilityKind));

/** Fetches the club's feed once and stores today's free slots on the row. Errors are stored, never thrown. */
export async function refreshClubAvailability(db: Db, club: Club, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<ClubAvailability | null> {
  if (!availabilityConfigured(club)) return null;
  const tz = club.tz && isValidTimeZone(club.tz) ? club.tz : "UTC";
  const day = localDay(now, tz);
  const base: ClubAvailability = { fetchedAt: now.toISOString(), day, tz, slots: [], error: null, source: club.availabilityKind! };
  let result = base;
  try {
    const res = await fetchImpl(club.availabilityUrl!, { headers: { "user-agent": "Kicksmash availability (+https://kicksma.sh/clubs)", accept: club.availabilityKind === "json_free" ? "application/json" : "text/calendar, text/plain;q=0.8, */*;q=0.5" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
    if (!res.ok) result = { ...base, error: `HTTP ${res.status}` };
    else {
      const text = (await res.text()).slice(0, MAX_BYTES);
      if (club.availabilityKind === "json_free") {
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          result = { ...base, error: "not JSON" };
        }
        if (json !== null) result = { ...base, slots: parseFreeJson(json, { day, tz, now }) };
      } else {
        const bookings = parseIcs(text, tz);
        if (!/BEGIN:VCALENDAR/i.test(text)) result = { ...base, error: "not a calendar feed" };
        else result = { ...base, slots: freeSlotsFromBookings(bookings, { courts: club.courts ?? 1, opensAt: club.opensAt, closesAt: club.closesAt, tz, day, now }) };
      }
    }
  } catch (e) {
    result = { ...base, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
  await db.update(clubs).set({ availability: result, availabilityAt: now }).where(eq(clubs.slug, club.slug));
  return result;
}

/** Hourly: live clubs with a feed whose cache is older than 50 minutes (or from another day). Bounded. */
export async function refreshAllAvailability(db: Db, now = new Date(), fetchImpl: typeof fetch = fetch, max = 30): Promise<{ refreshed: number; errors: number }> {
  const stale = new Date(now.getTime() - 50 * 60 * 1000);
  const due = await db
    .select()
    .from(clubs)
    .where(and(isNotNull(clubs.approvedAt), isNull(clubs.rejectedAt), isNotNull(clubs.availabilityUrl), or(isNull(clubs.availabilityAt), lt(clubs.availabilityAt, stale))))
    .limit(max);
  let refreshed = 0;
  let errors = 0;
  for (const club of due) {
    const r = await refreshClubAvailability(db, club, now, fetchImpl);
    if (r) refreshed++;
    if (r?.error) errors++;
  }
  return { refreshed, errors };
}

/** How long a read from a platform is shown after it was made. Past it a reader shows nothing rather than an old hour. */
export const SCRAPE_SHOWN_MS = 2 * 3600_000;

/** Was this cache read from a booking platform (`scrape:<platform>`) rather than handed to us by the club? Pure. */
export const isScraped = (a: Pick<ClubAvailability, "source"> | null | undefined): boolean => Boolean(a?.source?.startsWith("scrape:"));

/** A read from a platform that is clean and recent enough to show. Pure. */
export function scrapeFresh(a: ClubAvailability | null | undefined, now: Date): boolean {
  if (!a || !isScraped(a) || a.error) return false;
  const at = Date.parse(a.fetchedAt);
  return Number.isFinite(at) && now.getTime() - at < SCRAPE_SHOWN_MS;
}

/**
 * The slots of today in the club's zone that have not ended. A feed holds only today's; a read from a
 * platform holds several days, and every reader that says "today" goes through here. Pure.
 */
export function todaySlots(a: Pick<ClubAvailability, "slots" | "tz">, now: Date): ClubFreeSlot[] {
  const tz = isValidTimeZone(a.tz) ? a.tz : "UTC";
  const today = localDay(now, tz);
  return a.slots.filter((s) => {
    const start = new Date(s.start);
    return !Number.isNaN(start.getTime()) && new Date(s.end) > now && localDay(start, tz) === today;
  });
}

/** The club's day (yyyy-mm-dd) a slot starts on; "" for a time that does not parse. Pure. */
export function slotDay(start: string, tz: string): string {
  const d = new Date(start);
  return Number.isNaN(d.getTime()) ? "" : localDay(d, isValidTimeZone(tz) ? tz : "UTC");
}

/**
 * The cache as a read that needs only a few hours selects it: every field but the slots, and only the
 * slots that end after `from` and start before `until`. The days it does not need stay in the database,
 * which is what keeps a list of clubs small now that a read from a platform holds three days (AGENTS.md
 * rule 12, the Supabase egress in docs/OPERATING.md). Every writer stores instants from `toISOString()`,
 * so comparing the text compares the times. Null where the row has no cache.
 */
export function cacheBetween(from: Date, until: Date): SQL<ClubAvailability | null> {
  const lo = from.toISOString();
  const hi = until.toISOString();
  return sql<ClubAvailability | null>`((${clubs.availability} - 'slots') || jsonb_build_object('slots', jsonb_path_query_array(coalesce(${clubs.availability}->'slots', '[]'::jsonb), '$[*] ? (@.end > $lo && @.start < $hi)', jsonb_build_object('lo', ${lo}::text, 'hi', ${hi}::text))))`.mapWith(clubs.availability) as SQL<ClubAvailability | null>;
}
