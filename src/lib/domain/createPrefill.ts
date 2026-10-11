import { isValidTimeZone } from "@/lib/dates";
import { parseMatchLength, type MatchLength } from "./matchLength";
import { SEAT_NAMES_MAX } from "./slots";

/**
 * What the create form's address may carry, read once on the server (`CreateScreen`). Every value is
 * a string anybody can type into a link, so each one is checked against the form's own bounds and a
 * value outside them is dropped, never cut to fit: a court cut at 40 letters is another court.
 *
 * Three doors write these links. A venue board or a free court offered to a player
 * (`?venue=&date=&time=&tz=`) lists the match on the club's board, as it always did. The americano
 * generator carries `names`. A pasted booking (`bookingHref` in `bookingPaste.ts`: `src=paste` with
 * `len`, `court`, `cost`, `names` and `booked=1`) fills what the booking said, leaves the rest empty
 * and says which fields those are, and never lists the match on the board: the organiser booked a
 * court for their own four, and the board is theirs to choose (the switch under More options).
 * Pure.
 */
export type CreateLink = {
  venue?: string;
  date?: string;
  time?: string;
  tz?: string;
  names?: string;
  src?: string;
  len?: string;
  court?: string;
  cost?: string;
  booked?: string;
  check?: string;
};

export type LinkPrefill = {
  /** `src=paste`: the form was filled from a pasted booking. */
  fromPaste: boolean;
  venue: string | null;
  date: string | null;
  time: string | null;
  tz: string | null;
  durationMinutes: MatchLength | null;
  court: string | null;
  cost: string | null;
  /** The venue board: on for a club's own link, off for a pasted booking. */
  publicListing: boolean;
  /** `booked=1`: the organiser already booked the court ("Court booked by me" starts ticked). */
  booked: boolean;
  names: string[];
  /** A pasted booking only: what it did not say, so the form asks for it in place. */
  missing: ("venue" | "date" | "time")[];
  /** A pasted booking only: what the organiser must look at (`check=venue,date`): a venue that is their last one, a date its weekday disagrees with. */
  check: ("venue" | "date")[];
};

/** The form's bounds: a court and a price are 40 characters at most, a venue 80 (as the create action takes them). */
export const COURT_MAX = 40;
export const COST_MAX = 40;
const VENUE_MAX = 80;
const NAME_MAX = 60;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** One line of text within `max`, or null: empty, or longer than the form would ever take. */
function field(v: string | undefined, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return s && s.length <= max ? s : null;
}

const isDate = (v: string | undefined): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v;
};
const isTime = (v: string | undefined): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

export function readCreateLink(sp: CreateLink): LinkPrefill {
  const fromPaste = sp.src === "paste";
  // The venue as the venue board always read it: trimmed and held to 80.
  const venue = typeof sp.venue === "string" ? sp.venue.trim().slice(0, VENUE_MAX) || null : null;
  const tz = typeof sp.tz === "string" && isValidTimeZone(sp.tz) ? sp.tz : null;
  // A day and a time mean nothing without their zone. A club's link brings all three or none; a
  // pasted booking may lack the day or the time, and the form then asks for the one it lacks.
  let date = tz && isDate(sp.date) ? sp.date : null;
  let time = tz && isTime(sp.time) ? sp.time : null;
  if (!fromPaste && !(date && time)) date = time = null;
  const names = (sp.names ?? "")
    .split(",")
    .map((n) => n.trim().slice(0, NAME_MAX))
    .filter(Boolean)
    .slice(0, SEAT_NAMES_MAX);
  return {
    fromPaste,
    venue,
    date,
    time,
    tz: date || time || fromPaste ? tz : null,
    // 60, 90 or 120 and nothing else: a booking of 75 minutes leaves the form's own 90 for the organiser to see.
    durationMinutes: parseMatchLength(sp.len ?? null),
    court: field(sp.court, COURT_MAX),
    cost: field(sp.cost, COST_MAX),
    publicListing: Boolean(venue) && !fromPaste,
    booked: sp.booked === "1",
    names,
    missing: fromPaste ? [...(venue ? [] : ["venue" as const]), ...(date ? [] : ["date" as const]), ...(time ? [] : ["time" as const])] : [],
    check: fromPaste ? (["venue", "date"] as const).filter((f) => (sp.check ?? "").split(",").includes(f) && (f === "venue" ? venue : date)) : [],
  };
}
