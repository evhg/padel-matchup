/**
 * A booking screenshot, read once by the AI model (the owner, 11 October 2026: "Yes, landing page
 * first", DECIDING rule 9). The browser shrinks the picture and sends it with the paste box's text;
 * the server makes one Messages API call (`src/lib/booking/screenshot.ts`) and keeps neither the
 * picture nor the reply. The reply is a stranger's words about a stranger's picture, so nothing in it
 * is trusted: `parseShotReply` keeps each field only in its own plain shape, and `readBooking` then
 * reads every field again with the same validators it uses on typed words (the day, the time, the
 * length, the court, the price, the names through the same name filter, the club against the clubs'
 * names). What the person typed wins over the picture, field by field.
 *
 * Pure, and safe in a browser: the paste box imports the sizes from here.
 */

/** The longest side the browser sends, in pixels: the size the model reads without scaling it down again. */
export const SHOT_LONG_SIDE = 1568;
/**
 * The largest picture the server takes, in bytes. Under the 1 MB that every server action takes
 * (`serverActions.bodySizeLimit` in next.config.ts), with room for the text: a screenshot at 1568
 * pixels as a JPEG is 150 to 400 KB.
 */
export const SHOT_MAX_BYTES = 900 * 1024;
/** The smallest file that can be a picture at all. */
const SHOT_MIN_BYTES = 100;
/** What the server takes. The browser sends a JPEG, which every browser can make from a canvas. */
export const SHOT_TYPES = ["image/jpeg", "image/webp"] as const;
export type ShotType = (typeof SHOT_TYPES)[number];

/**
 * What the file is, from its own first bytes, never from the name or the type the request claims:
 * a JPEG starts FF D8 FF, a WebP "RIFF", four bytes, "WEBP". Null for anything else or a size out of bounds.
 */
export function sniffShot(bytes: Uint8Array): ShotType | null {
  if (bytes.length < SHOT_MIN_BYTES || bytes.length > SHOT_MAX_BYTES) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** The fields one picture gives, each a short plain string as the picture shows it, or null. */
export type BookingShot = {
  club: string | null;
  date: string | null;
  start: string | null;
  end: string | null;
  minutes: number | null;
  court: string | null;
  price: string | null;
  players: string[];
};

/** At most this many players are read from a picture, as from typed words (`PASTE_NAMES_MAX`). */
const SHOT_PLAYERS_MAX = 7;
/** The longest a field may be; a longer one is dropped, never cut. */
const FIELD_MAX = { club: 80, date: 40, start: 20, end: 20, court: 40, price: 40, player: 40 } as const;

/**
 * One field as a short plain string, or null. A field is dropped whole, never cleaned into something
 * else, when it carries a control character, a tag's bracket, a link (`://`, `www.`) or an address
 * (`@`), or is longer than its bound. A booking's own words carry none of these.
 */
function plain(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s || s.length > max) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>{}[\]\\`]|:\/\/|www\.|@/iu.test(v)) return null;
  return s;
}

/**
 * The model's reply, read as the strict JSON the instruction asks for and nothing else: the first
 * object in the text (a code fence around it is fine), only the eight known keys, each in its own
 * shape. Every other key is ignored; a reply that is no JSON object, or says it is no booking
 * (`"booking": false`), gives null. Never throws.
 */
export function parseShotReply(text: string): BookingShot | null {
  if (typeof text !== "string") return null;
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from < 0 || to <= from || to - from > 8000) return null;
  let j: unknown;
  try {
    j = JSON.parse(text.slice(from, to + 1));
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (o.booking === false) return null;
  const minutes = typeof o.minutes === "number" && Number.isInteger(o.minutes) && o.minutes >= 30 && o.minutes <= 360 ? o.minutes : null;
  const players = Array.isArray(o.players)
    ? o.players
        .map((p) => plain(p, FIELD_MAX.player))
        .filter((p): p is string => p !== null)
        .slice(0, SHOT_PLAYERS_MAX)
    : [];
  const shot: BookingShot = {
    club: plain(o.club, FIELD_MAX.club),
    date: plain(o.date, FIELD_MAX.date),
    start: plain(o.start, FIELD_MAX.start),
    end: plain(o.end, FIELD_MAX.end),
    minutes,
    court: plain(typeof o.court === "number" ? String(o.court) : o.court, FIELD_MAX.court),
    price: plain(o.price, FIELD_MAX.price),
    players,
  };
  const any = shot.club || shot.date || shot.start || shot.court || shot.price || shot.players.length > 0;
  return any ? shot : null;
}
