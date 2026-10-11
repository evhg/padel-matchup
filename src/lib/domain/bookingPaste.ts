import { bookandgoApp } from "@/lib/booking/adapters/bookandgo";
import { matchiFacilitySlug } from "@/lib/booking/adapters/matchi";
import { playtomicClubPage } from "@/lib/booking/adapters/playtomic";
import { cleanUrl, detectPlatform } from "@/lib/booking/platforms";
import { isValidTimeZone, utcToZonedParts } from "@/lib/dates";
import { distinctWords, matchVenue, WEEKDAYS, ZONE_ALIASES } from "@/lib/telegram/parse";
import { CITIES } from "./cities";
import { normalName } from "./dupes";
import { parseMatchLength } from "./matchLength";
import { namesFromChat } from "./pasteNames";

/**
 * "Paste your booking": a person booked a court in a platform's app and pastes what the app gave them
 * (the share text, the booking link, or both) on the create form or to the bot, and the match form
 * fills itself. The owner, 11 October 2026: "how do I turn this into a match and match card/link by
 * just copy and pasting the link?"
 *
 * Pure: no network, no database, no clock of its own. The one read of a pasted link (as a chat app's
 * preview robot reads it, DECIDING rule 35) is `readLinkPreview` in `src/lib/booking/unfurl.ts`, and
 * its words come in here as `preview`. The person's own text always wins over the preview's: the
 * preview fills only what the text did not say. It imports the bot's parser for the weekday words and
 * the club matcher, so it runs on the server.
 *
 * Chat is free text, and a reader of free text refuses what it does not recognise (the crew group's
 * lesson: "who's in for beers at 8?"). So a field is filled only from a shape it knows: a club from
 * its link or its own name, a day from a date, a day word or a weekday, a time from a clock, a court
 * after the word "court", a price beside a currency, and names only where the text shows players.
 */

/** A club the paste can name: what `listClubsForPicking` returns, cut to what the reader uses. */
export type PickClub = { slug: string; name: string; tz: string | null; bookingUrl?: string | null; website?: string | null };

export type BookingRef = { type: string; id: string };

export type BookingRead = {
  /** The platform of the first pasted link it knows, or null. */
  platform: { id: string; name: string } | null;
  /** The platform's own id for the booking (The Padel Society's match invitation), from the preview; never sent anywhere. */
  ref: BookingRef | null;
  club: PickClub | null;
  /** Where the club came from: a pasted link, the person's text, the preview, or the organiser's last venue. */
  clubFrom?: "link" | "text" | "preview" | "history" | null;
  /** YYYY-MM-DD in `tz`. */
  date: string | null;
  /** HH:MM in `tz`. */
  time: string | null;
  /** The zone the day and the time are in: the club's, else the caller's. */
  tz: string;
  /** How long the court is booked, as read (30 to 360). The form takes 60, 90 or 120 (`parseMatchLength`). */
  minutes: number | null;
  court: string | null;
  cost: string | null;
  names: string[];
  missing: ("club" | "date" | "time")[];
  /** The paste named a weekday and a date that fall on different days ("Sun 12 Oct" when 12 October is a Monday). The date is kept; the organiser checks it. */
  dayClash: boolean;
};

export type BookingPreview = { title?: string | null; description?: string | null; ref?: BookingRef | null };

/** What a paste may carry: a chat's worth. */
export const PASTE_TEXT_MAX = 4000;
/** Links read from one paste. */
export const PASTE_LINKS_MAX = 5;
/** Names read from one paste: a match is four, a tournament night is read elsewhere. */
export const PASTE_NAMES_MAX = 7;
const FIELD_MAX = 40;

// ── Links ────────────────────────────────────────────────────────────────────────────────────────

const LINK_RE = /https?:\/\/[^\s<>"'«»“”]+/giu;

/** The http(s) links in a paste, then `extra` (a Telegram message's link entities), cleaned, the first spelling of each, five at most. */
export function linksIn(text: string, extra: readonly string[] = []): string[] {
  const found = [...((text ?? "").slice(0, PASTE_TEXT_MAX).match(LINK_RE) ?? []), ...extra.slice(0, 20)];
  const out: string[] = [];
  for (const raw of found) {
    if (typeof raw !== "string") continue;
    const clean = cleanUrl(raw.replace(/[.,;:!?)\]}>»"'”]+$/u, ""));
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= PASTE_LINKS_MAX) break;
  }
  return out;
}

const setpointSlug = (u: URL): string | null => {
  const host = u.hostname.toLowerCase();
  if (host !== "getsetpoint.io" && !host.endsWith(".getsetpoint.io")) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const slug = parts[0] === "checkout" ? parts[1] : null;
  return slug && /^[a-z0-9-]{1,80}$/i.test(slug) ? slug.toLowerCase() : null;
};

/**
 * What says which club a link is: a platform's club slug (a Playtomic or Setpoint club, a MATCHi
 * facility), a Book & Go app, or the host when the host is the club's own (its own domain, a PodPlay
 * subdomain). A platform's shared host alone says nothing: every club on it has one.
 */
function linkKeys(url: string | null | undefined): { keys: string[]; slug: string | null } {
  if (!url) return { keys: [], slug: null };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { keys: [], slug: null };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { keys: [], slug: null };
  const keys: string[] = [];
  let slug: string | null = null;
  const playtomic = playtomicClubPage(url)?.split("/").pop() ?? null;
  if (playtomic) keys.push(`playtomic:${(slug = playtomic.toLowerCase())}`);
  const matchi = matchiFacilitySlug(url)?.toLowerCase() ?? null;
  if (matchi) keys.push(`matchi:${(slug = matchi)}`);
  const setpoint = setpointSlug(u);
  if (setpoint) keys.push(`setpoint:${(slug = setpoint)}`);
  const bng = bookandgoApp(url);
  if (bng) keys.push(`bookandgo:${bng.app}`);
  const platform = detectPlatform(url);
  if (!platform || platform.id === "podplay") keys.push(`host:${u.hostname.toLowerCase().replace(/^www\./, "")}`);
  return { keys, slug };
}

/** The one club the pasted links point at, or null for none or for two. */
function clubFromLinks(links: readonly string[], clubs: readonly PickClub[]): PickClub | null {
  if (links.length === 0) return null;
  const pasted = links.map(linkKeys);
  const wanted = new Set(pasted.flatMap((p) => p.keys));
  if (wanted.size > 0) {
    const hits = clubs.filter((c) => [linkKeys(c.bookingUrl), linkKeys(c.website)].some((k) => k.keys.some((key) => wanted.has(key))));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  // A platform's slug that is the club's own address here ("playtomic.com/clubs/bangkok-padel" is bangkok-padel).
  const slugs = new Set(pasted.map((p) => p.slug).filter((s): s is string => Boolean(s)));
  const bySlug = clubs.filter((c) => slugs.has(c.slug));
  return bySlug.length === 1 ? bySlug[0] : null;
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

// Cyrillic has no \b in JS regexes; these lookarounds are the word boundary for both alphabets (as in the bot's parser).
const W = (re: string, flags = "iu") => new RegExp(`(?<![\\p{L}\\d])(?:${re})(?![\\p{L}\\d])`, flags);
const pad = (n: number) => String(n).padStart(2, "0");

/** The months in English, Russian (every case) and Spanish, full and short. Full forms first: "marzo" is not "mar". */
const MONTHS: readonly [string, number][] = [
  ["january|jan|январ\\p{L}*|янв|enero|ene", 1],
  ["february|feb|феврал\\p{L}*|фев|febrero", 2],
  ["march|mar|март\\p{L}*|marzo", 3],
  ["april|apr|апрел\\p{L}*|апр|abril|abr", 4],
  ["may|ма[йяюе]|маем|mayo", 5],
  ["june|jun|июн\\p{L}*|junio", 6],
  ["july|jul|июл\\p{L}*|julio", 7],
  ["august|aug|август\\p{L}*|авг|agosto|ago", 8],
  ["september|sept|sep|сентябр\\p{L}*|сент|сен|septiembre|setiembre", 9],
  ["october|oct|октябр\\p{L}*|окт|octubre", 10],
  ["november|nov|ноябр\\p{L}*|ноя|noviembre", 11],
  ["december|dec|декабр\\p{L}*|дек|diciembre|dic", 12],
];
const MONTH_ALT = MONTHS.map(([re]) => re).join("|");
const MONTH_RES = MONTHS.map(([re, n]) => [new RegExp(`^(?:${re})$`, "iu"), n] as const);
const monthOf = (word: string): number | null => MONTH_RES.find(([re]) => re.test(word.replace(/\.$/, "")))?.[1] ?? null;

/**
 * The short Spanish weekdays are also names ("Dom", "Vie", "Sab"), so they count as a day only right
 * before a figure ("dom 12 oct", "vie 19:00"); every other weekday word counts wherever it stands.
 */
const SHORT_ES_DAYS = ["dom", "lun", "mié", "mie", "jue", "vie", "sáb", "sab"];
const byLength = (words: string[]) => words.sort((a, b) => b.length - a.length).join("|");
// "el jueves": the article goes with the day.
const WEEKDAY_RE = W(`(?:el\\s+)?(?:${byLength(Object.keys(WEEKDAYS).filter((w) => !SHORT_ES_DAYS.includes(w)))})\\.?`);
const SHORT_WEEKDAY_RE = W(`(?:el\\s+)?(?:${byLength([...SHORT_ES_DAYS])})\\.?(?=,?\\s*\\d)`);
/** A day said in words, with no date: "tomorrow 19.10" then has its time in the figures. */
const DAY_WORD_RE = W("today|tonight|tomorrow|tmrw?|day after tomorrow|сегодня|завтра|послезавтра|hoy|ma[ñn]ana|pasado ma[ñn]ana|esta noche|esta tarde");

const CURRENCY_BEFORE = "US\\$|S\\$|A\\$|HK\\$|RM|Rp|฿|€|\\$|£|₽|THB|SGD|USD|EUR|GBP|AED|RUB|MYR|IDR|AUD|HKD|VND|INR";
const CURRENCY_AFTER = `${CURRENCY_BEFORE}|baht|бат(?:ов|а)?|евро|руб(?:лей|ля|\\.)?|р\\.|euros?|dirhams?|дирхам(?:ов|а)?`;
// A plain space never groups thousands: "Court 3 600 THB" is court 3 and 600 baht.
const AMOUNT = "\\d{1,3}(?:[,.\\u00a0\\u202f]\\d{3})+(?:[.,]\\d{1,2})?|\\d{1,6}(?:[.,]\\d{1,2})?";
const PER = "(?:\\s?\\/\\s?(?:person|pax|player|pp|чел|persona)|\\s(?:pp|each|per person|с человека|por persona))?";
const COST_RE = new RegExp(`(?<![\\p{L}\\d])(?:(?:${CURRENCY_BEFORE})\\s?(?:${AMOUNT})|(?:${AMOUNT})\\s?(?:${CURRENCY_AFTER}))(?![\\p{L}\\d])${PER}`, "iu");

/** Words that are never a player's name in a booking: what the booking says about itself, in three languages. */
const BOOKING_WORDS = [
  "court", "courts", "pista", "pistas", "cancha", "корт", "корты", "корта", "padel", "падел", "pádel", "club", "клуб", "match", "game", "partido", "матч", "игра",
  "booking", "booked", "book", "reservation", "reserved", "reserva", "reservado", "бронь", "бронирование", "confirmed", "confirmation", "confirmado", "подтверждено",
  "invitation", "invite", "invited", "invitación", "invitacion", "приглашение", "join", "únete", "unete", "team", "equipo", "команда", "players", "player",
  "jugadores", "игроки", "price", "precio", "цена", "total", "итого", "paid", "pagado", "оплачено", "duration", "duración", "date", "fecha", "time", "hora",
  "venue", "location", "address", "today", "tomorrow", "hoy", "mañana", "сегодня", "завтра", "open", "free", "spot", "needed", "wanted", "tbd", "level", "nivel",
  "уровень", "indoor", "outdoor", "center", "centre", "central", "society", "playtomic", "matchi", "setpoint", "podplay", "skedda", "courtsite", "playbypoint",
  "friends", "amigos", "друзьями", "coach", "lights",
  // A way to pay and a letter's sign-off: "Paid with Visa", "Kind Regards, Front Desk".
  "visa", "mastercard", "amex", "card", "cards", "cash", "promptpay", "apple", "google", "pay", "paypal", "transfer", "wallet", "credit", "debit", "tarjeta",
  "efectivo", "transferencia", "карта", "картой", "наличные", "наличными", "перевод", "regards", "cheers", "best", "thanks", "desk", "reception",
  "support", "staff", "management", "saludos", "atentamente", "уважением",
];
const CITY_WORDS = [...CITIES.flatMap((c) => [c.slug, c.name.toLowerCase(), ...c.needles]), ...Object.keys(ZONE_ALIASES)];
// The weekdays in full and the English short forms; "Dom", "Lun" and "Vie" stay names.
const DAY_WORDS = Object.keys(WEEKDAYS).filter((w) => w.length >= 4 || /^(sun|mon|tue|wed|thu|fri|sat)$/.test(w));
const NOT_NAMES = new Set([...BOOKING_WORDS, ...CITY_WORDS, ...DAY_WORDS]);
// A month in full is no name; "Jan" and "May" are.
const FULL_MONTH = /^(?:january|february|march|april|may|june|july|august|september|october|november|december|январ\p{L}*|феврал\p{L}*|март\p{L}*|апрел\p{L}*|ма[йяюе]|июн\p{L}*|июл\p{L}*|август\p{L}*|сентябр\p{L}*|октябр\p{L}*|ноябр\p{L}*|декабр\p{L}*|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)$/iu;
const notAName = (name: string, clubWords: ReadonlySet<string>) =>
  name
    .toLowerCase()
    .split(/\s+/)
    .some((w) => NOT_NAMES.has(w) || clubWords.has(w) || FULL_MONTH.test(w));

/**
 * Words dropped from a piece of text before it is matched against the clubs' names: what a booking says
 * around a club's name ("Join my match at …", "Reserva confirmada en …"). The generic words of a name
 * ("padel", "club", "court") stay: `matchVenue` reads them itself, and "Kata Padel" is a club only whole.
 */
const NOISE = new Set([
  "join", "joined", "my", "our", "your", "you", "you're", "youre", "we", "we're", "are", "is", "be", "it", "its", "it's", "a", "an", "at", "on", "in", "with", "to", "of",
  "from", "let", "lets", "let's", "play", "playing", "together", "match", "game", "games", "invitation", "invite", "invited", "booked", "booking", "book",
  "bookings", "confirmed", "confirmation", "reservation", "reserved", "reserve", "hi", "hello", "hey", "thanks", "thank", "see", "there", "here", "total",
  "price", "paid", "pay", "payment", "players", "player", "team", "date", "time", "duration", "venue", "location", "address", "details", "new", "open",
  "spot", "spots", "need", "needed", "one", "two", "three", "more", "today", "tomorrow", "tonight", "am", "pm", "via", "app", "link", "click", "tap",
  "download", "society", "playtomic", "matchi", "setpoint", "podplay", "skedda", "courtsite", "playbypoint", "bookandgo", "go", "level",
  "я", "мы", "наш", "наша", "наше", "ваш", "ваша", "матч", "игра", "игру", "бронь", "бронирование", "забронировал", "забронировала", "забронирован",
  "забронировано", "подтверждено", "приглашение", "присоединяйся", "присоединяйтесь", "играем", "давайте", "в", "во", "на", "с", "со", "и", "для", "по",
  "сегодня", "завтра", "время", "дата", "цена", "итого", "игроки", "команда", "уровень",
  "únete", "unete", "mi", "nuestro", "nuestra", "tu", "partido", "partida", "reserva", "reservado", "reservada", "confirmada", "confirmado", "invitación",
  "invitacion", "en", "los", "las", "con", "para", "y", "a", "hoy", "mañana", "jugar", "juguemos", "vamos", "precio", "jugadores", "equipo", "hora",
  "fecha", "nivel",
]);

const placeWordsOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\d]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

// ── The reader ───────────────────────────────────────────────────────────────────────────────────

type Day = { y: number | null; m: number; d: number };
type Scan = {
  day: Day | null;
  rel: number | null;
  weekday: number | null;
  time: string | null;
  minutes: number | null;
  court: string | null;
  cost: string | null;
  names: string[];
  rest: string;
};

/** "Court 3" → "3"; "COURT 3 Center Court" → "Court 3 · Center Court"; "Pista Central" as typed. */
const COURT_RE = W(
  "(court|корт|pista|cancha)(?:\\s*(?:[:#№]|no\\.?|n[ºo°]\\.?)\\s*|\\s+|(?=\\d))([\\p{L}\\d]{1,12})(?![:.]\\d)(?:\\s*[-–·:]?\\s*((?:[\\p{L}]{2,16}\\s+){0,2}(?:court|pista|cancha|корт)))?",
);
const COURT_NOT = new Set(["booked", "booking", "book", "reserved", "reservation", "fee", "hire", "rental", "time", "at", "on", "for", "is", "de", "el", "la", "en", "and", "with", "бронь", "забронирован"]);
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

function readCourt(m: RegExpMatchArray): string | null {
  const word = cap(m[1]);
  const token = m[2];
  if (COURT_NOT.has(token.toLowerCase())) return null;
  // Under the "i" flag \p{Lu} takes any letter, so the capital of a court's name is checked here.
  const name = m[3] && /^\p{Lu}/u.test(m[3]) ? m[3].replace(/\s+/g, " ").trim() : null;
  if (/^\d{1,3}[a-zA-Z]?$/.test(token)) return (name ? `${word} ${token} · ${name}` : token).slice(0, FIELD_MAX);
  // A named court is a name: a capital, or one letter ("Court A").
  if (!/^\p{Lu}/u.test(token) && token.length > 1) return null;
  // "Court: Center Court": the name and its own court word, after a label.
  if (m[3] && /^(?:court|корт|pista|cancha)$/iu.test(m[3].trim())) return `${token} ${m[3].trim()}`.slice(0, FIELD_MAX);
  return `${word} ${token}`.slice(0, FIELD_MAX);
}

const ATOM = "(\\d{1,2})(?:[:.](\\d{2}))?(?:\\s*([apAP])\\.?\\s?[mM]\\.?(?![\\p{L}]))?";
const RANGE_RE = new RegExp(`(?<![\\d.,:/])${ATOM}(?:\\s*[-–—~]\\s*|\\s+(?:to|until|till|до|hasta|a)\\s+)${ATOM}(?!\\d)`, "iu");
const TWELVE_RE = new RegExp(`(?<![\\d.,:/])(\\d{1,2})(?:[:.](\\d{2}))?\\s*([apAP])\\.?\\s?[mM]\\.?(?![\\p{L}])`, "u");
const CLOCK_RE = /(?<![\d.,:/])(\d{1,2})[:.](\d{2})(?!\d|[.,]\d)/u;

/** Minutes after midnight, or null for a clock that is not one. */
function clock(h: number, m: number, mer: string | undefined): number | null {
  if (!Number.isFinite(h) || !Number.isFinite(m) || m > 59) return null;
  if (mer) {
    if (h < 1 || h > 12) return null;
    return ((h % 12) + (mer.toLowerCase() === "p" ? 12 : 0)) * 60 + m;
  }
  return h > 23 ? null : h * 60 + m;
}
const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/** One side of a range takes the other's am or pm when it has none: "6-7:30pm" is 18:00 to 19:30, "11-1pm" 11:00 to 13:00. */
function rangeOf(m: RegExpMatchArray): { start: number; end: number } | null {
  const [h1, mi1, mer1, h2, mi2, mer2] = [Number(m[1]), m[2], m[3], Number(m[4]), m[5], m[6]];
  // Two bare numbers are a score or a level ("6-4", "3-4"), never a time.
  if (!mi1 && !mi2 && !mer1 && !mer2) return null;
  const other = (x: string) => (x.toLowerCase() === "p" ? "a" : "p");
  let a = mer1;
  let b = mer2;
  if (!a && b && h1 <= 12) {
    const same = clock(h1, Number(mi1 ?? 0), b);
    const end = clock(h2, Number(mi2 ?? 0), b);
    a = same !== null && end !== null && same < end ? b : other(b);
  } else if (a && !b && h2 <= 12) {
    const start = clock(h1, Number(mi1 ?? 0), a);
    const same = clock(h2, Number(mi2 ?? 0), a);
    b = start !== null && same !== null && same > start ? a : other(a);
  }
  const start = clock(h1, Number(mi1 ?? 0), a);
  const end = clock(h2, Number(mi2 ?? 0), b);
  return start === null || end === null ? null : { start, end };
}

const okLength = (n: number) => (Number.isFinite(n) && n >= 30 && n <= 360 ? Math.round(n) : null);

/**
 * Every field one text carries, without the zone: a day is kept as its parts until the club is known,
 * because "today" is the club's today. What is read is cut out of the text, so it cannot be read twice
 * ("1.5 hr" is a length, never the first of May) and what is left is where the club's name is.
 */
function scan(input: string, o: { clubWords: ReadonlySet<string>; selfName: string | null; names: boolean }): Scan {
  const out: Scan = { day: null, rel: null, weekday: null, time: null, minutes: null, court: null, cost: null, names: [], rest: "" };
  let text = ` ${input
    .slice(0, PASTE_TEXT_MAX)
    .replace(/\r/g, "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(LINK_RE, " ")} `;
  // `on` refuses a match with false (it stays), takes it with nothing (it goes), or puts back the string it returns.
  const take = (re: RegExp, on: (m: RegExpMatchArray) => boolean | void | string) => {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    text = text.replace(new RegExp(re.source, flags), (...m) => {
      const match = m.slice(0, -2) as unknown as RegExpMatchArray;
      const r = on(match);
      return r === false ? match[0] : typeof r === "string" ? r : " ";
    });
  };
  const once = (fn: (m: RegExpMatchArray) => boolean | void) => {
    let done = false;
    return (m: RegExpMatchArray) => {
      if (done) return false;
      const r = fn(m);
      if (r !== false) done = true;
      return r;
    };
  };

  // The price first: its digits are no day and no time. "฿1,600", "1600 THB", "S$60".
  take(
    COST_RE,
    once((m) => {
      out.cost = m[0].replace(/\s+/g, " ").trim().slice(0, FIELD_MAX);
    }),
  );
  // A level ("Level 3.5-4.5") is not a date.
  take(W("(?:level|lvl|nivel|уровень|ур\\.?)\\s*\\d(?:[.,]\\d{1,2})?(?:\\s*[-–]\\s*\\d(?:[.,]\\d{1,2})?)?"), () => undefined);
  // "dom 12 oct", "vie 19:00": a short Spanish weekday, read while its figure is still beside it.
  take(SHORT_WEEKDAY_RE, (m) => {
    const wd = WEEKDAYS[m[0].toLowerCase().replace(/^el\s+/, "").replace(/\.$/, "")];
    if (wd === undefined) return false;
    out.weekday ??= wd;
  });
  // The length, before the clock: "1h30", "1.5 hr", "90 min", "полтора часа".
  take(
    W("(\\d)\\s*(?:h|hr|hrs|ч|час(?:а|ов)?|hours?|horas?)\\s*(\\d{1,2})(?![:.]\\d)\\s*(?:m|min|mins|minutes|мин|minutos)?\\.?"),
    once((m) => {
      const n = Number(m[1]) <= 4 && Number(m[2]) <= 59 ? okLength(Number(m[1]) * 60 + Number(m[2])) : null;
      if (n === null) return false;
      out.minutes ??= n;
    }),
  );
  take(
    W("(\\d{1,3})\\s*(?:minutes?|mins?|мин(?:ут[аы]?)?|minutos?)\\.?"),
    once((m) => {
      const n = okLength(Number(m[1]));
      if (n === null) return false;
      out.minutes ??= n;
    }),
  );
  take(
    W("(\\d(?:[.,]\\d{1,2})?)\\s*(?:h|hr|hrs|hours?|ч|час(?:а|ов)?|horas?)\\.?"),
    once((m) => {
      // Four hours at most: "6h" is more likely six o'clock than a six-hour booking.
      const h = Number(m[1].replace(",", "."));
      const n = h <= 4 ? okLength(h * 60) : null;
      if (n === null) return false;
      out.minutes ??= n;
    }),
  );
  take(W("полтора часа|hora y media|an hour and a half|one and a half hours?"), () => {
    out.minutes ??= 90;
  });
  // The court: "Court 3", "COURT 3 Center Court", "корт 3", "pista 3". A label in front of the court's own word goes first ("Court: Court 3").
  take(/(?<![\p{L}\d])(?:court|корт|pista|cancha)\s*:\s*(?=(?:court|корт|pista|cancha)(?![\p{L}]))/iu, () => undefined);
  take(
    COURT_RE,
    once((m) => {
      const court = readCourt(m);
      if (!court) return false;
      out.court = court;
    }),
  );

  // The day: an ISO date, then a day and a month by name, either way round.
  take(
    /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/u,
    once((m) => {
      out.day = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
    }),
  );
  if (!out.day)
    take(
      new RegExp(`(?<![\\p{L}\\d])(\\d{1,2})(?:st|nd|rd|th|-?го|º|°|er)?\\.?\\s*(?:de\\s+|of\\s+)?(${MONTH_ALT})\\.?(?![\\p{L}])(?:,?\\s*(?:de\\s+)?(\\d{4})(?!\\d))?(?:\\s*г\\.?)?`, "iu"),
      once((m) => {
        const month = monthOf(m[2]);
        if (!month) return false;
        out.day = { y: m[3] ? Number(m[3]) : null, m: month, d: Number(m[1]) };
      }),
    );
  if (!out.day)
    take(
      new RegExp(`(?<![\\p{L}\\d])(${MONTH_ALT})\\.?(?![\\p{L}])\\s*(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:.]\\d|\\d)(?:,?\\s*(\\d{4})(?!\\d))?`, "iu"),
      once((m) => {
        const month = monthOf(m[1]);
        if (!month) return false;
        out.day = { y: m[3] ? Number(m[3]) : null, m: month, d: Number(m[2]) };
      }),
    );

  // The time: a range first (its start, and its length), then 6pm, so neither is taken for a date.
  let range: { start: number; end: number } | null = null;
  take(
    RANGE_RE,
    once((m) => {
      range = rangeOf(m);
      if (!range) return false;
    }),
  );
  const r = range as { start: number; end: number } | null;
  if (r) {
    out.time = hhmm(r.start);
    out.minutes ??= okLength((r.end - r.start + 1440) % 1440);
  }
  if (!out.time)
    take(
      TWELVE_RE,
      once((m) => {
        const c = clock(Number(m[1]), Number(m[2] ?? 0), m[3]);
        if (c === null) return false;
        out.time = hhmm(c);
      }),
    );
  // A clock with a dot after "at" ("в 20.10", "a las 19.30") is the time, never the twentieth of October.
  if (!out.time)
    take(
      W("(?:at|в|@|a las|a la)\\s*(\\d{1,2})\\.(\\d{2})(?![.,]\\d)"),
      once((m) => {
        const c = clock(Number(m[1]), Number(m[2]), undefined);
        if (c === null) return false;
        out.time = hhmm(c);
      }),
    );
  // So is the one dotted pair of a text that gives its day in words and no other clock: "tomorrow 19.10".
  const DOTTED = /(?<![\d.,/:])(\d{1,2})\.(\d{2})(?!\d|[.,:/]\d)/gu;
  if (!out.day && !out.time && DAY_WORD_RE.test(text) && (text.match(DOTTED) ?? []).length === 1 && !/\d:\d{2}/.test(text))
    take(
      DOTTED,
      once((m) => {
        const c = clock(Number(m[1]), Number(m[2]), undefined);
        if (c === null) return false;
        out.time = hhmm(c);
      }),
    );
  // A day and a month in figures, day first (Thailand, Singapore, Europe): "12/10", "12.10.2026". With a
  // dot, two figures on a side or a year, or "4.5" (a level, a length) would be the fourth of May.
  if (!out.day)
    take(
      /(?<![\d.,/:])(\d{1,2})([./])(\d{1,2})(?:[./](\d{2,4}))?(?!\d|[.,:/]\d)/u,
      once((m) => {
        const [d, mo] = [Number(m[1]), Number(m[3])];
        if (d < 1 || d > 31 || mo < 1 || mo > 12) return false;
        if (m[2] === "." && !m[4] && (m[1].length < 2 || m[3].length < 2)) return false;
        const y = m[4] ? Number(m[4]) : null;
        out.day = { y: y !== null && y < 100 ? 2000 + y : y, m: mo, d };
      }),
    );
  if (!out.time)
    take(
      CLOCK_RE,
      once((m) => {
        const c = clock(Number(m[1]), Number(m[2]), undefined);
        if (c === null) return false;
        out.time = hhmm(c);
      }),
    );
  if (!out.time)
    take(
      W("(?:at|в|@|a las|a la)\\s*(\\d{1,2})(?:\\s*[hч])?"),
      once((m) => {
        // A bare hour before six is as likely the afternoon: refused, as the bot's parser refuses it.
        const c = Number(m[1]) >= 6 ? clock(Number(m[1]), 0, undefined) : null;
        if (c === null) return false;
        out.time = hhmm(c);
      }),
    );
  if (!out.time)
    take(
      W("(\\d{1,2})\\s*[hч](\\d{2})?"),
      once((m) => {
        const h = Number(m[1]);
        const c = h >= 5 ? clock(h, Number(m[2] ?? 0), undefined) : null;
        if (c === null) return false;
        out.time = hhmm(c);
      }),
    );

  // Day words. Spanish "mañana" is also "morning": "por la mañana" names a part of the day, "esta mañana" is today.
  take(W("(?:por|de) la ma[ñn]ana"), () => undefined);
  take(W("esta ma[ñn]ana"), () => {
    out.rel ??= 0;
  });
  take(W("day after tomorrow|послезавтра|pasado ma[ñn]ana"), () => {
    out.rel ??= 2;
  });
  take(W("today|tonight|сегодня|hoy|esta noche|esta tarde"), () => {
    out.rel ??= 0;
  });
  take(W("tomorrow|tmrw?|завтра|ma[ñn]ana"), () => {
    out.rel ??= 1;
  });
  take(WEEKDAY_RE, (m) => {
    const wd = WEEKDAYS[m[0].toLowerCase().replace(/^el\s+/, "").replace(/\.$/, "")];
    if (wd === undefined) return false;
    out.weekday ??= wd;
  });

  // How it was paid is neither a player nor the club: "Paid with Visa", "Pagado con tarjeta", "Оплачено картой".
  take(
    new RegExp(
      `(?<![\\p{L}\\d])(?:paid|pagado|pagada|оплачено|оплачен[аы]?|оплата)(?:\\s+(?:with|by|via|in|using|con|por|en|через|по|картой|наличными))?[^\\n.;,|·•()]*?(?=$|\\n|[.;,|·•()]|\\s[-–—]\\s|\\s(?:at|@|on|в|на|en)\\s)`,
      "imu",
    ),
    () => undefined,
  );

  if (o.names) {
    const self = normalName(o.selfName);
    const selfFirst = self.split(" ")[0] ?? "";
    const keep = (raw: string, capital: boolean): boolean => {
      const piece = raw.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
      // A capital is checked here: under the "i" flag a regular expression's \p{Lu} takes any letter.
      if (!piece || (capital && !/^\p{Lu}/u.test(piece))) return false;
      const name = namesFromChat(piece)[0];
      if (!name || name.length > FIELD_MAX || notAName(name, o.clubWords)) return false;
      const key = normalName(name);
      if (self && (key === self || key === selfFirst)) return true;
      if (out.names.some((n) => normalName(n) === key) || out.names.length >= PASTE_NAMES_MAX) return true;
      out.names.push(name);
      return true;
    };
    // "and Danny" is a piece too: a list's last word before it is a piece of its own ("Dom and Danny").
    const pieces = (s: string) => s.split(/\s*(?:[,;/&+]|\s(?:and|и|y|e)\s)\s*/iu).map((p) => p.replace(/^(?:and|и|y|e)\s+/iu, ""));
    /**
     * The names among the pieces, and what is no name, to put back where it stood: "Alberto Warehaus"
     * gives Alberto, and Warehaus stays in the text for the club. A piece is cut out only for the names in it.
     */
    const namesOf = (list: string[], capital: boolean): { any: boolean; left: string[] } => {
      let any = false;
      const left: string[] = [];
      for (const raw of list) {
        const piece = raw.trim();
        if (!piece) continue;
        if (keep(piece, capital)) {
          any = true;
          continue;
        }
        const words = piece.split(/\s+/);
        const at = words.findIndex((w, i) => i > 0 && notAName(w, o.clubWords));
        if (at > 0 && keep(words.slice(0, at).join(" "), capital)) {
          any = true;
          left.push(words.slice(at).join(" "));
        } else left.push(piece);
      }
      return { any, left };
    };
    const putBack = (left: string[]) => (left.length ? ` , ${left.join(" , ")} , ` : " ");
    // "Team A: Danny, Alberto", "Players: …", "Equipo 1: …", "Команда: …". A line with no name in it stays, for the club.
    take(/^[ \t]*(?:team|equipo|команда|players?|jugadores|игроки|pair|pareja|пара)[ \t]*[\p{L}\d]{0,2}[ \t]*[:：\-–][ \t]*(.+)$/imu, (m) => {
      const got = namesOf(pieces(m[1]), false);
      return got.any ? putBack(got.left) : false;
    });
    // "with Danny and Alberto", "con Ana y Bea", "с Данни и Альберто": names with a capital, up to the next piece of the
    // booking ("at Warehaus" stays). The phrase goes either way: "with danny" names no club. Only the names go: what
    // is no name stays for the club ("с 18:00 до 19:30, Warehaus").
    take(
      new RegExp(`(?<![\\p{L}\\d])(with|w\\/|con|с|со)\\s+([^\\n.;|·•()]+?)(?=$|\\n|[.;|·•()]|\\s[-–—]\\s|\\s(?:at|@|in|on|в|на|en)\\s)`, "imu"),
      (m) => {
        // A Russian "с" is also "from" ("с 18:00"): it opens names only before a capital.
        if (/^со?$/iu.test(m[1]) && !/^\p{Lu}/u.test(m[2].trim())) return false;
        return putBack(namesOf(pieces(m[2]), true).left);
      },
    );
    // A list of names on its own lines ("Danny\nAlberto", "1. Danny\n2. Alberto"), or one line of two or more ("Danny, Alberto").
    const lines = text.split("\n");
    const nameOnly = (line: string): string[] | null => {
      const parts = line
        .split(/[,;]/)
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length === 0 || /\d/.test(line.replace(/^\s*\d{1,2}[.)]\s/, ""))) return null;
      const found = namesFromChat(line).filter((n) => !notAName(n, o.clubWords));
      return found.length === parts.length ? found : null;
    };
    const blocks: string[][] = [];
    let run: string[] = [];
    for (const line of lines) {
      const found = line.trim() ? nameOnly(line) : null;
      if (found && found.length === 1) run.push(found[0]);
      else {
        if (run.length) blocks.push(run);
        run = [];
        if (found && found.length >= 2) blocks.push(found);
      }
    }
    if (run.length) blocks.push(run);
    const listed = blocks.filter((b) => b.length >= 2).flat();
    for (const n of listed) keep(n, false);
    if (listed.length) {
      const drop = new Set(listed.map(normalName));
      text = lines.map((l) => (nameOnly(l)?.every((n) => drop.has(normalName(n))) ? " " : l)).join("\n");
    }
  }
  out.rest = text;
  return out;
}

/** The pieces of what is left in which a club's name may stand: a line, a part between commas, the words after "at". */
function clubPieces(rest: string): string[] {
  return rest
    .split(/[\n,;|·•()[\]@]|\s[-–—]\s|(?<![\p{L}\d])(?:at|on|в|во|на|en)(?![\p{L}\d])/iu)
    .map((p) =>
      p
        .split(/\s+/)
        .filter((w) => w && !NOISE.has(w.toLowerCase().replace(/[^\p{L}\d']/gu, "")))
        .join(" ")
        .trim(),
    )
    .filter((p) => /\p{L}{3}/u.test(p));
}

/**
 * `matchVenue` takes the one club that owns every word typed, which suits a place typed into a chat
 * command. A booking's text is longer, so one short word of a longer name is not enough: "Love this!"
 * is not Love All Sports. The words must be the club's every distinct word, or carry one of five
 * letters or more ("Sterling" is Sterling Sport & Wellness).
 */
function namedEnough(piece: string, name: string): boolean {
  const own = distinctWords(name);
  // A name of a city and generic words only ("Bangkok Padel") is found whole or not at all.
  if (own.length === 0) return true;
  const said = new Set(distinctWords(piece));
  const covered = own.filter((w) => said.has(w));
  return covered.length > 0 && (covered.length === own.length || covered.some((w) => w.length >= 5));
}

/** The one club the words name (`matchVenue`: a city or an area alone never picks one), or null for none or for two. */
function clubInText(rest: string, clubs: readonly PickClub[], tz: string): PickClub | null {
  if (clubs.length === 0) return null;
  const names = clubs.map((c) => c.name);
  const pieces = clubPieces(rest);
  const pick = (p: string) => {
    const n = matchVenue(p, [], names);
    return n && namedEnough(p, n) ? n : null;
  };
  let named = [...new Set(pieces.map(pick).filter((n): n is string => Boolean(n)))];
  if (named.length === 0 && pieces.length > 1) {
    const whole = pick(pieces.join(" "));
    if (whole) named = [whole];
  }
  if (named.length !== 1) return null;
  return clubNamed(named[0], clubs, tz);
}

/** The club of this name: one row, or the one in the caller's zone when two share it. */
export function clubNamed(name: string, clubs: readonly PickClub[], tz: string): PickClub | null {
  const key = normalName(name);
  let rows = clubs.filter((c) => normalName(c.name) === key);
  if (rows.length === 0) {
    const named = matchVenue(name, [], clubs.map((c) => c.name));
    rows = named ? clubs.filter((c) => c.name === named) : [];
  }
  if (rows.length > 1) rows = rows.filter((c) => c.tz === tz);
  return rows.length === 1 ? rows[0] : null;
}

const realDate = (y: number, m: number, d: number): string | null => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const dowOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** A booking is for the coming year at most: a day further on is a slip (a wrong year), and the bot's answer shows no year to catch it. */
const DAYS_AHEAD_MAX = 400;
/** A day without a year this far behind today is next year's ("3 Jan" on 28 December); nearer, it is a booking played or a slip. */
const DAYS_BEHIND_NEXT_YEAR = 60;

/**
 * The day in the zone. A date with its year more than a day behind us is refused (a booking already
 * played); a Thai Buddhist-era year (2569) is the same year in the common era (2026). A day without a
 * year is this year's when it is today or later, next year's when this year's is more than sixty days
 * behind, and refused in between. Nothing more than about thirteen months ahead. A weekday is the next
 * one, a week on when it is today and the time has gone.
 */
function dayIn(s: Pick<Scan, "day" | "rel" | "weekday" | "time">, today: { date: string; time: string }): string | null {
  const ahead = (date: string | null) => (date && date <= shift(today.date, DAYS_AHEAD_MAX) ? date : null);
  if (s.day) {
    const { m, d } = s.day;
    const y = s.day.y !== null && s.day.y >= 2500 && s.day.y <= 2600 ? s.day.y - 543 : s.day.y;
    if (y !== null) {
      const date = realDate(y, m, d);
      return date && date >= shift(today.date, -1) ? ahead(date) : null;
    }
    const year = Number(today.date.slice(0, 4));
    const date = realDate(year, m, d);
    if (date && date >= today.date) return ahead(date);
    if (date && date >= shift(today.date, -DAYS_BEHIND_NEXT_YEAR)) return null;
    return ahead(realDate(year + 1, m, d));
  }
  if (s.rel !== null) return shift(today.date, s.rel);
  if (s.weekday !== null) {
    let delta = (s.weekday - dowOf(today.date) + 7) % 7;
    if (delta === 0 && s.time && s.time <= today.time) delta = 7;
    return shift(today.date, delta);
  }
  return null;
}

/**
 * Reads a pasted booking: the club, the day, the time, the length, the court, the price and the
 * players. The club comes from a pasted link first (a Setpoint checkout, a Playtomic club, a PodPlay
 * subdomain, a Book & Go app, matched against the clubs' booking links and websites), else from its
 * name in the person's text, else from the preview, else `fallbackClub` (the organiser's last venue,
 * which the caller reads). The day and the time are in the club's zone, else in `tz`.
 */
export function readBooking(input: {
  text: string;
  links?: readonly string[];
  clubs: readonly PickClub[];
  now: Date;
  tz: string;
  selfName?: string | null;
  preview?: BookingPreview | null;
  fallbackClub?: PickClub | null;
}): BookingRead {
  const text = (input.text ?? "").slice(0, PASTE_TEXT_MAX);
  const links = linksIn(text, input.links ?? []);
  // A club's own words are no player's name ("Warehaus" on a line of its own). Four letters and up, so "Ida" stays a name.
  const clubWords = new Set(input.clubs.flatMap((c) => placeWordsOf(c.name)).filter((w) => w.length >= 4));
  const mine = scan(text, { clubWords, selfName: input.selfName ?? null, names: true });
  const previewText = [input.preview?.title, input.preview?.description].filter((s): s is string => typeof s === "string" && s.trim() !== "").join("\n");
  const theirs = previewText ? scan(previewText, { clubWords, selfName: null, names: false }) : null;

  const platformOf = links.map((l) => detectPlatform(l)).find(Boolean) ?? null;
  const callerTz = isValidTimeZone(input.tz) ? input.tz : "UTC";

  let club: PickClub | null = null;
  let clubFrom: BookingRead["clubFrom"] = null;
  const found: [PickClub | null, NonNullable<BookingRead["clubFrom"]>][] = [
    [clubFromLinks(links, input.clubs), "link"],
    [clubInText(mine.rest, input.clubs, callerTz), "text"],
    [theirs ? clubInText(theirs.rest, input.clubs, callerTz) : null, "preview"],
    [input.fallbackClub ?? null, "history"],
  ];
  for (const [c, from] of found) {
    if (c) {
      club = c;
      clubFrom = from;
      break;
    }
  }
  const tz = club?.tz && isValidTimeZone(club.tz) ? club.tz : callerTz;
  const today = utcToZonedParts(input.now, tz);

  // The person's text wins, field by field; the preview fills only what it left out.
  const dayFromText = mine.day !== null || mine.rel !== null || mine.weekday !== null;
  const time = mine.time ?? theirs?.time ?? null;
  const daySource = dayFromText ? mine : theirs && (theirs.day !== null || theirs.rel !== null || theirs.weekday !== null) ? theirs : null;
  const date = daySource ? dayIn({ ...daySource, time }, today) : null;

  const read: BookingRead = {
    platform: platformOf ? { id: platformOf.id, name: platformOf.name } : null,
    ref: input.preview?.ref ?? null,
    club,
    clubFrom,
    date,
    time,
    tz,
    minutes: mine.minutes ?? theirs?.minutes ?? null,
    court: mine.court ?? theirs?.court ?? null,
    cost: mine.cost ?? theirs?.cost ?? null,
    names: mine.names,
    missing: [],
    dayClash: Boolean(date && daySource?.day && daySource.weekday !== null && dowOf(date) !== daySource.weekday),
  };
  read.missing = [...(read.club ? [] : ["club" as const]), ...(read.date ? [] : ["date" as const]), ...(read.time ? [] : ["time" as const])];
  return read;
}

/**
 * Does the paste show a booking, so that "Court booked by me" may start ticked? A platform's link, or a
 * time with something only a booking carries: the club it named, a court or a price. The organiser's
 * last venue is a guess about the club, not a sign of a booking. Pure.
 */
export const showsBooking = (read: BookingRead): boolean =>
  Boolean(read.platform) || (Boolean(read.time) && ((Boolean(read.club) && read.clubFrom !== "history") || Boolean(read.court) || Boolean(read.cost)));

/**
 * The create form, filled: `/?src=paste` and every field read, in the names the form already takes
 * (`venue`, `date`, `time`, `tz`, `names`) and the new ones (`len`, `court`, `cost`, `booked`,
 * `check`). The length goes only when it is one the form offers (60, 90 or 120); `booked=1` only when
 * the paste shows a booking (`showsBooking`); `check` names the fields the organiser must look at: the
 * venue when it is their last one, the date when the weekday disagrees with it. Pure.
 */
export function bookingHref(read: BookingRead): string {
  const q = new URLSearchParams({ src: "paste" });
  if (read.club) q.set("venue", read.club.name);
  if (read.date) q.set("date", read.date);
  if (read.time) q.set("time", read.time);
  q.set("tz", read.tz);
  const len = parseMatchLength(read.minutes);
  if (len) q.set("len", String(len));
  if (read.court) q.set("court", read.court);
  if (read.cost) q.set("cost", read.cost);
  if (read.names.length) q.set("names", read.names.join(","));
  if (showsBooking(read)) q.set("booked", "1");
  const check = [...(read.club && read.clubFrom === "history" ? ["venue"] : []), ...(read.dayClash ? ["date"] : [])];
  if (check.length) q.set("check", check.join(","));
  return `/?${q.toString()}`;
}
