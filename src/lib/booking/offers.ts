import type { ClubOffers } from "@/db/schema";
import { isValidTimeZone, utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";
import type { ScrapedSlot } from "./adapters/types";

/**
 * The exact starts a platform lists for each court, kept small enough to sit on the club's cache
 * (`ClubAvailability.offers`), so "Book this court" can open the platform's own checkout with the
 * court, the time and the length filled in (the owner's decision of 11 October 2026, "Playtomic
 * checkout, filled"; DECIDING rule 36).
 *
 * Why not the free time the cache keeps already: a checkout takes one listed start for one listed
 * length. The read of 11 October 2026 compared each court's free time, cut on the half hour, with what
 * Playtomic listed for the next day: exact at one club (375 of 375), and 12 to 48 starts too many at the
 * three others, each a half hour beside a booking or at opening time that Playtomic does not sell. So
 * the read keeps what the platform listed, not what the free time suggests.
 *
 * The shape: for each club day, each court, one figure for each half hour from the club's midnight
 * (1 for a start of 60 minutes, 2 for 90, 4 for 120, added together). A start off the half hour, or of
 * another length, is not kept, and "Book this court" opens the club's day page for it. Pure.
 */
export const OFFER_STEP_MS = 30 * 60_000;
export const OFFER_BITS: Readonly<Record<number, number>> = { 60: 1, 90: 2, 120: 4 };
/** The figures of one day stop here: a day has 50 half hours at most, on the night the clocks go back. */
const MAX_STEPS = 50;
const MAX_COURTS = 40;
const KEY_LENGTH = 8;
const COURT_ID = /^[A-Za-z0-9_-]{8,80}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const midnight = (day: string, tz: string) => zonedTimeToUtc(day, "00:00", tz).getTime();
const dayOf = (t: number, tz: string) => utcToZonedParts(new Date(t), tz).date;
const nameOf = (court: string | null | undefined, id: string): string | null => {
  const name = (court ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return name && name !== id ? name : null;
};

/**
 * A reader's slots as the offers the cache keeps: only the club days given (`days`, in `tz`), only
 * starts still to come, only a court with the platform's own id. Null when nothing is left. Pure.
 */
export function offersFromScrape(slots: readonly ScrapedSlot[], o: { tz: string; days: readonly string[]; now: Date }): ClubOffers | null {
  if (!isValidTimeZone(o.tz) || o.days.length === 0) return null;
  const courts: ClubOffers["courts"] = {};
  const grid = new Map<string, Map<string, number[]>>();
  for (const s of slots.slice(0, 5_000)) {
    if (!s || s.free !== true) continue;
    const id = typeof s.courtId === "string" ? s.courtId.trim() : "";
    if (!COURT_ID.test(id)) continue;
    const start = Date.parse(s.start);
    const end = Date.parse(s.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= o.now.getTime()) continue;
    const bit = OFFER_BITS[Math.round((end - start) / 60_000)];
    if (!bit) continue;
    const day = dayOf(start, o.tz);
    if (!o.days.includes(day)) continue;
    const offset = start - midnight(day, o.tz);
    if (offset < 0 || offset % OFFER_STEP_MS !== 0 || offset / OFFER_STEP_MS >= MAX_STEPS) continue;
    const key = id.slice(0, KEY_LENGTH);
    const held = courts[key];
    // Two courts whose ids start alike: the second keeps no offers, and its times open the day page.
    if (held && held[0] !== id) continue;
    if (!held) {
      if (Object.keys(courts).length >= MAX_COURTS) continue;
      courts[key] = [id, nameOf(s.court, id)];
    } else if (!held[1]) held[1] = nameOf(s.court, id);
    const byCourt = grid.get(day) ?? new Map<string, number[]>();
    const figures = byCourt.get(key) ?? [];
    const i = offset / OFFER_STEP_MS;
    while (figures.length <= i) figures.push(0);
    figures[i] |= bit;
    byCourt.set(key, figures);
    grid.set(day, byCourt);
  }
  if (Object.keys(courts).length === 0) return null;
  const days: ClubOffers["days"] = {};
  for (const [day, byCourt] of grid) days[day] = Object.fromEntries([...byCourt].map(([key, figures]) => [key, figures.join("").replace(/0+$/, "")]));
  return { courts, days };
}

export type OfferedCourt = { id: string; name: string | null };

/**
 * The courts the platform listed with exactly this start and this length, as the cache keeps them.
 * Reads the cache's shape with care: it comes from a jsonb column. Pure.
 */
export function offeredCourts(offers: ClubOffers | null | undefined, tz: string, start: Date, minutes: number): OfferedCourt[] {
  const bit = OFFER_BITS[minutes];
  const t = start.getTime();
  if (!bit || !offers || typeof offers !== "object" || !Number.isFinite(t) || !isValidTimeZone(tz)) return [];
  const day = dayOf(t, tz);
  const offset = t - midnight(day, tz);
  if (!DAY.test(day) || offset < 0 || offset % OFFER_STEP_MS !== 0) return [];
  const i = offset / OFFER_STEP_MS;
  const row = offers.days?.[day];
  if (!row || typeof row !== "object") return [];
  const out: OfferedCourt[] = [];
  for (const [key, figures] of Object.entries(row)) {
    const court = offers.courts?.[key];
    if (typeof figures !== "string" || !Array.isArray(court) || typeof court[0] !== "string") continue;
    if ((Number(figures[i] ?? "0") & bit) === 0) continue;
    out.push({ id: court[0], name: typeof court[1] === "string" && court[1] ? court[1] : null });
  }
  return out;
}

/** The number in a court's name or in the match's court ("Court 2", "Pista 2", "2"), or null. */
const numberIn = (s: string) => /(\d{1,3})/.exec(s)?.[1].replace(/^0+(?=\d)/, "") ?? null;

/**
 * Which listed court the checkout books: the match's own court when the platform lists it ("2" is
 * "Court 2"), else the first listed court by name, so the player sees which court the link holds.
 * Never a court with no name, because the page could not say which court the link holds. A read of
 * today alone sees no names, and a row with no offers before it has none to lend (review, 11 October
 * 2026). And when the match names a court that no listed name matches, a listed court with no name may
 * be that very court, so nothing is picked. Null then, and when none is listed: the day page. Pure.
 */
export function pickCourt(courts: readonly OfferedCourt[], wanted: string | null | undefined): OfferedCourt | null {
  if (courts.length === 0) return null;
  const want = (wanted ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (want) {
    const exact = courts.find((c) => c.name?.toLowerCase() === want);
    if (exact) return exact;
    const n = numberIn(want);
    const numbered = n ? courts.filter((c) => c.name && numberIn(c.name) === n) : [];
    if (numbered.length === 1) return numbered[0];
    if (courts.some((c) => !c.name)) return null;
  }
  const first = [...courts].sort((a, b) => (a.name ?? "￿").localeCompare(b.name ?? "￿", "en", { numeric: true }) || a.id.localeCompare(b.id))[0];
  return first.name ? first : null;
}
