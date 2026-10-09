import { utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";
import { CITIES } from "@/lib/domain/cities";
import type { TournamentFormat } from "@/db/schema";
import { ASK_PREFIX, readWords } from "./words";

/**
 * "/new tomorrow 19:00 Rawai 400฿" → a match. Free word order, English, Russian
 * and Spanish, forgiving about formats: the organizer types what they would have
 * typed to the group anyway, and the bot fills the form. The same reader takes a
 * crew's own question ("who's in Thursday 7pm Rawai?"), so the question's words
 * and a seat word ("I'm in") are dropped rather than kept as the place. What is
 * left is the venue: one the chat already knows when the caller passes the known
 * courts and the words point at exactly one, else the words themselves. Pure: no
 * database, no clock of its own.
 */
export type ParsedNew = {
  /** Null when no time was found (a day alone is not enough). */
  startsAt: Date | null;
  date: string | null;
  time: string | null;
  venue: string | null;
  court: string | null;
  type: "match" | "tournament";
  format: TournamentFormat | null;
  capacity: number | null;
  levelMin: number | null;
  levelMax: number | null;
  cost: string | null;
  /** A time zone the text itself points at (a city name or area), or null. */
  tzHint: string | null;
  /** "public" / "открытый": list the match on the venue and city boards, where strangers find it. */
  publicListing: boolean;
};

// Cyrillic has no \b in JS regexes; these lookarounds are the word boundary for both alphabets.
const word = (re: string, flags = "iu") => new RegExp(`(?<![\\p{L}\\d])(?:${re})(?![\\p{L}\\d])`, flags);

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
  вс: 0, воскресенье: 0, пн: 1, понедельник: 1, вт: 2, вторник: 2, ср: 3, среда: 3, среду: 3, чт: 4, четверг: 4, пт: 5, пятница: 5, пятницу: 5, сб: 6, суббота: 6, субботу: 6,
  // "mar" for martes is left out on purpose: it is the sea in half the court names of a Spanish coast.
  domingo: 0, dom: 0, lunes: 1, lun: 1, martes: 2, miércoles: 3, miercoles: 3, mié: 3, mie: 3, jueves: 4, jue: 4, viernes: 5, vie: 5, sábado: 6, sabado: 6, sáb: 6, sab: 6,
};
// "el jueves": the article goes with the day, or it would be left behind as the place.
const WEEKDAY_RE = word(`(?:el\\s+)?(?:${Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join("|")})`);
const CURRENCY = "฿|thb|baht|бат(?:ов|а)?|б|€|eur|евро|\\$|usd|₽|руб(?:лей|ля)?|р|sgd|s\\$|aed|дирхам(?:ов)?|£|gbp";

/** Cities the text can name, in either alphabet, and the zone that goes with each. */
const CITY_WORDS: { needles: string[]; tz: string }[] = [
  ...CITIES.map((c) => ({ needles: [c.name.toLowerCase(), ...c.needles], tz: c.tz })),
  { needles: ["пхукет", "патонг", "равай", "ката", "карон", "чалонг", "бангтао", "банг тао", "камала", "най харн", "найхарн", "сурин", "лагуна"], tz: "Asia/Bangkok" },
  { needles: ["сингапур"], tz: "Asia/Singapore" },
];

/** Time zone shortcuts for /tz: a city or country name a person would type. Unknown input is checked as an IANA zone by the caller. */
export const ZONE_ALIASES: Record<string, string> = {
  phuket: "Asia/Bangkok", пхукет: "Asia/Bangkok", bangkok: "Asia/Bangkok", бангкок: "Asia/Bangkok", thailand: "Asia/Bangkok", таиланд: "Asia/Bangkok", таи: "Asia/Bangkok",
  singapore: "Asia/Singapore", сингапур: "Asia/Singapore", bali: "Asia/Makassar", бали: "Asia/Makassar", dubai: "Asia/Dubai", дубай: "Asia/Dubai", uae: "Asia/Dubai", оаэ: "Asia/Dubai",
  moscow: "Europe/Moscow", москва: "Europe/Moscow", spb: "Europe/Moscow", питер: "Europe/Moscow", tbilisi: "Asia/Tbilisi", тбилиси: "Asia/Tbilisi", almaty: "Asia/Almaty", алматы: "Asia/Almaty",
  yerevan: "Asia/Yerevan", ереван: "Asia/Yerevan", istanbul: "Europe/Istanbul", стамбул: "Europe/Istanbul", cyprus: "Asia/Nicosia", кипр: "Asia/Nicosia", limassol: "Asia/Nicosia", лимассол: "Asia/Nicosia",
  madrid: "Europe/Madrid", мадрид: "Europe/Madrid", barcelona: "Europe/Madrid", барселона: "Europe/Madrid", spain: "Europe/Madrid", испания: "Europe/Madrid", lisbon: "Europe/Lisbon", лиссабон: "Europe/Lisbon",
  london: "Europe/London", лондон: "Europe/London", berlin: "Europe/Berlin", берлин: "Europe/Berlin", amsterdam: "Europe/Amsterdam", paris: "Europe/Paris", stockholm: "Europe/Stockholm", belgrade: "Europe/Belgrade", белград: "Europe/Belgrade",
  buenosaires: "America/Argentina/Buenos_Aires", mexico: "America/Mexico_City", miami: "America/New_York", newyork: "America/New_York", losangeles: "America/Los_Angeles",
};

export function resolveZone(input: string): string | null {
  const key = input.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!key) return null;
  if (ZONE_ALIASES[key]) return ZONE_ALIASES[key];
  const asIana = input.trim().replace(/\s+/g, "_");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: asIana }).format(new Date());
    // Canonical casing: "asia/bangkok" → "Asia/Bangkok".
    return asIana
      .split("/")
      .map((part) => part.split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join("_"))
      .join("/");
  } catch {
    return null;
  }
}

export function tzHintFor(text: string): string | null {
  const lower = ` ${text.toLowerCase()} `;
  const slugged = lower.replace(/\s+/g, "-");
  for (const c of CITY_WORDS) {
    if (c.needles.some((n) => (n.includes("-") ? slugged.includes(n) : lower.includes(n)))) return c.tz;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const shiftDate = (date: string, days: number) => new Date(`${date}T12:00:00Z`).getTime() + days * 86_400_000;
const dateStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dowOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const toNum = (s: string) => Number(s.replace(",", "."));

/** `venues`: the courts the chat already knows, most likely first (its usual court, the organizer's, the clubs in its zone). */
export function parseNewCommand(args: string, opts: { tz: string; now?: Date; venues?: readonly string[] }): ParsedNew {
  const now = opts.now ?? new Date();
  const out: ParsedNew = { startsAt: null, date: null, time: null, venue: null, court: null, type: "match", format: null, capacity: null, levelMin: null, levelMax: null, cost: null, tzHint: tzHintFor(args), publicListing: false };
  let text = ` ${args.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, " ").trim()} `;
  const take = (re: RegExp, on: (m: RegExpMatchArray) => boolean | void) => {
    text = text.replace(re, (...m) => {
      const match = m.slice(0, -2) as unknown as RegExpMatchArray;
      return on(match) === false ? match[0] : " ";
    });
  };

  // A crew's question ("who's in …?", "кто играет …?", "¿quién juega …?") asks for players; its words are not the place.
  take(new RegExp(`^\\s*[¿¡]?\\s*(?:${ASK_PREFIX})(?![\\p{L}\\d])`, "iu"), () => undefined);

  take(word("public|open game|открыт(?:ый|о|ая)|публичн(?:ый|о)"), () => {
    out.publicListing = true;
  });
  // Money first: "400฿", "400 thb", "€8", "8 евро".
  take(new RegExp(`(?<![\\p{L}\\d])(?:([฿€$£])\\s?(\\d{1,5}(?:[.,]\\d{1,2})?)|(\\d{1,5}(?:[.,]\\d{1,2})?)\\s?(${CURRENCY}))(?![\\p{L}\\d])`, "iu"), (m) => {
    if (out.cost) return false;
    out.cost = m[1] ? `${m[1]}${m[2]}` : `${m[3]} ${m[4]}`.replace(/ (฿|€|\$|£|₽)$/, "$1");
  });
  // A tournament format, optionally with the head count: "americano 8", "мексикано 12".
  take(word("(americano|американо|mexicano|мексикано|king(?: of the court)?|король(?: корта)?)(?:\\s*(\\d{1,2}))?"), (m) => {
    out.type = "tournament";
    const f = m[1].toLowerCase();
    out.format = f.startsWith("mex") || f.startsWith("мек") ? "mexicano" : f.startsWith("king") || f.startsWith("кор") ? "king" : "americano";
    if (m[2]) out.capacity = Number(m[2]);
  });
  take(word("(\\d{1,2})\\s*(?:players?|ppl|pax|игрок(?:а|ов)?|чел(?:овек|\\.)?)"), (m) => {
    out.capacity = Number(m[1]);
  });
  take(word("(?:court|корт)\\s*#?\\s*([\\p{L}\\d]{1,12})"), (m) => {
    out.court = m[1];
  });
  // Levels: "level 3-4", "3.5-4.5", "3+", "ур 3".
  take(word("(?:lvl|level|уровень|ур\\.?)\\s*(\\d(?:[.,]\\d{1,2})?)(?:\\s*[-–]\\s*(\\d(?:[.,]\\d{1,2})?))?\\+?"), (m) => {
    out.levelMin = toNum(m[1]);
    out.levelMax = m[2] ? toNum(m[2]) : null;
  });
  if (out.levelMin == null) {
    take(word("(\\d(?:[.,]\\d{1,2})?)\\s*[-–]\\s*(\\d(?:[.,]\\d{1,2})?)"), (m) => {
      const a = toNum(m[1]);
      const b = toNum(m[2]);
      if (a > 7 || b > 7 || a > b) return false;
      out.levelMin = a;
      out.levelMax = b;
    });
  }
  if (out.levelMin == null) {
    take(/(?<![\p{L}\d.,])(\d(?:[.,]\d{1,2})?)\+(?![\p{L}\d])/u, (m) => {
      const a = toNum(m[1]);
      if (a > 7) return false;
      out.levelMin = a;
    });
  }

  // The day: an explicit date, a relative word, or a weekday.
  const today = utcToZonedParts(now, opts.tz);
  let dayOffset: number | null = null;
  let weekday: number | null = null;
  take(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/, (m) => {
    out.date = `${m[1]}-${m[2]}-${m[3]}`;
  });
  if (!out.date) {
    take(/(?<![\d.,])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?!\d|[.,:]\d)/, (m) => {
      const d = Number(m[1]);
      const mo = Number(m[2]);
      if (d < 1 || d > 31 || mo < 1 || mo > 12) return false;
      let y = m[3] ? Number(m[3]) : Number(today.date.slice(0, 4));
      if (y < 100) y += 2000;
      let date = `${y}-${pad(mo)}-${pad(d)}`;
      // Without a year: a date more than a day behind us means next year.
      if (!m[3] && shiftDate(date, 0) < shiftDate(today.date, -1)) date = `${y + 1}-${pad(mo)}-${pad(d)}`;
      out.date = date;
    });
  }
  if (!out.date) {
    take(word("day after tomorrow|послезавтра|pasado ma[ñn]ana"), () => {
      dayOffset = 2;
    });
    if (dayOffset == null)
      take(word("today|tdy|сегодня|tonight|вечером|hoy|esta noche|esta tarde"), () => {
        dayOffset = 0;
      });
    if (dayOffset == null)
      take(word("tomorrow|tmr|tmrw|завтра|ma[ñn]ana"), () => {
        dayOffset = 1;
      });
    if (dayOffset == null)
      take(WEEKDAY_RE, (m) => {
        weekday = WEEKDAYS[m[0].toLowerCase().replace(/^el\s+/, "")];
      });
  }

  // The time: 7pm, 19:00, 19.00, at 19, в 19, 19h, or a bare hour.
  take(word("(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)"), (m) => {
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase() === "pm") h += 12;
    out.time = `${pad(h)}:${pad(Number(m[2] ?? 0))}`;
  });
  if (!out.time)
    take(/(?<![\d.,])(\d{1,2})[:.](\d{2})(?!\d|[.,]\d)/, (m) => {
      const h = Number(m[1]);
      const mi = Number(m[2]);
      if (h > 23 || mi > 59) return false;
      out.time = `${pad(h)}:${pad(mi)}`;
    });
  if (!out.time)
    take(word("(?:at|в|@|a las|a la)\\s*(\\d{1,2})(?:\\s*[hч])?"), (m) => {
      const h = Number(m[1]);
      if (h > 23) return false;
      out.time = `${pad(h)}:00`;
    });
  if (!out.time)
    take(word("(\\d{1,2})\\s*[hч]"), (m) => {
      const h = Number(m[1]);
      if (h > 23) return false;
      out.time = `${pad(h)}:00`;
    });
  if (!out.time)
    take(word("(\\d{1,2})"), (m) => {
      const h = Number(m[1]);
      if (h < 6 || h > 23) return false;
      out.time = `${pad(h)}:00`;
    });

  // Resolve the day now that the time is known (a weekday or a bare time that already passed rolls forward).
  if (out.time) {
    if (!out.date) {
      if (dayOffset != null) out.date = dateStr(shiftDate(today.date, dayOffset));
      else if (weekday != null) {
        let delta = (weekday - dowOf(today.date) + 7) % 7;
        if (delta === 0 && out.time <= today.time) delta = 7;
        out.date = dateStr(shiftDate(today.date, delta));
      } else {
        const soon = pad(Number(today.time.slice(0, 2))) + ":" + pad(Math.min(59, Number(today.time.slice(3)) + 5));
        out.date = out.time > soon ? today.date : dateStr(shiftDate(today.date, 1));
      }
    }
    out.startsAt = zonedTimeToUtc(out.date, out.time, opts.tz);
  }

  // Whatever is left is the place, unless it is a seat word ("I'm in" in reply to a prompt is not a court).
  const words = readWords(text.trim())?.kind;
  const venue =
    words === "join" || words === "leave"
      ? ""
      : text
          .replace(/[?!¿¡"«»“”]+/g, " ")
          .replace(word("at|in|on|в|во|на|у|@|с|from|en|a las|a la"), " ")
          .replace(/[,;·]+/g, " ")
          .replace(/\s+/g, " ")
          .replace(/^[\s\-–—.]+|[\s\-–—.]+$/g, "")
          .trim();
  out.venue = venue ? (opts.venues?.length ? matchVenue(venue, opts.venues) : null) ?? venue.slice(0, 80) : null;
  if (out.type === "tournament" && out.capacity == null) out.capacity = 8;
  if (out.capacity != null) out.capacity = Math.min(64, Math.max(4, Math.ceil(out.capacity / 4) * 4));
  if (out.type === "match") out.capacity = out.capacity && out.capacity > 4 ? out.capacity : null;
  if (out.type === "match" && out.capacity) {
    // "8 players" without a format word: an americano.
    out.type = "tournament";
    out.format = "americano";
  }
  return out;
}

// Words that name what a court is rather than which one: they point at no court in particular.
const GENERIC = new Set(["padel", "club", "the", "co", "sports", "sport", "tennis", "indoor", "outdoor", "hotel", "arena", "racquet", "racket", "court", "courts", "center", "centre", "academy", "and", "клуб", "падел", "корт", "de", "del", "la", "el"]);
const placeWords = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\d]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/**
 * The known court the words point at, or null. The whole name wins ("xplore padel phuket"); else the
 * court whose own words ("rawai", "blue tree") the text carries most of. A word several courts share
 * ("phuket") decides nothing, unless those courts are one court spelled twice ("Rawai Padel Club" the
 * chat typed and "Rawai Padel" in the directory), where the first in the list (the chat's own) wins.
 */
export function matchVenue(text: string, venues: readonly string[]): string | null {
  const said = placeWords(text);
  if (said.length === 0) return null;
  const joined = ` ${said.join(" ")} `;
  const seen = new Set<string>();
  const known = venues.filter((v) => {
    const key = placeWords(v).join(" ");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const whole = known.filter((v) => joined.includes(` ${placeWords(v).join(" ")} `)).sort((a, b) => placeWords(b).length - placeWords(a).length)[0];
  if (whole) return whole;
  const saidSet = new Set(said);
  let best: { name: string; own: string; hits: number }[] = [];
  for (const name of known) {
    const own = placeWords(name).filter((w) => w.length >= 3 && !GENERIC.has(w));
    const hits = own.filter((w) => saidSet.has(w)).length;
    if (hits === 0) continue;
    if (!best.length || hits > best[0].hits) best = [{ name, own: own.join(" "), hits }];
    else if (hits === best[0].hits) best.push({ name, own: own.join(" "), hits });
  }
  if (best.length === 0) return null;
  return best.every((b) => b.own === best[0].own) ? best[0].name : null;
}

/** The cities offered as taps when a chat or a coach has no time zone yet. One list, two flows. */
export const GUIDED_ZONES: [string, string][] = [
  ["phuket", "Phuket"],
  ["singapore", "Singapore"],
  ["bali", "Bali"],
  ["dubai", "Dubai"],
  ["moscow", "Moscow"],
  ["madrid", "Madrid"],
  ["cyprus", "Cyprus"],
  ["tbilisi", "Tbilisi"],
];
