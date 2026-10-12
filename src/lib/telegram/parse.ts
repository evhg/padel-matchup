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
 * courts and the words point at exactly one, else the words themselves. The
 * result also says how it read the time and whether the place is a known court,
 * because a crew's question may make a match only from an hour named outright and
 * a court the chat knows (`askForMatch`). Pure: no database, no clock of its own.
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
  /** How the time was read: "clock" for 19:00, 7pm, at 19 or 19h; "bare" for a lone number ("tmr 19"); null without a time. */
  timeFrom: "clock" | "bare" | null;
  /** True when the day was typed (a date, a day word, a weekday); false when the hour alone placed it. */
  dayTyped: boolean;
  /** True when the hour cannot be twelve hours off: am/pm, or a part of the day ("de la tarde"). */
  meridiem: boolean;
  /** The words left over for the place, as typed (in memory only: never stored as they are by a crew's question). */
  place: string | null;
  /** True when `venue` is a court from the known lists rather than the words as typed. */
  venueKnown: boolean;
  /**
   * A club of the directory that the line names in full (`matchVenue`'s `inFull`, the owner's decision of
   * 10 October 2026: "Yes, but only on the club's own words"), or null. `venue` may be the chat's own
   * spelling of it. `createFromChat` lists the match on the club's board when it sits there.
   */
  club: string | null;
};

// Cyrillic has no \b in JS regexes; these lookarounds are the word boundary for both alphabets.
const word = (re: string, flags = "iu") => new RegExp(`(?<![\\p{L}\\d])(?:${re})(?![\\p{L}\\d])`, flags);

/** Weekday words in English, Russian and Spanish, to 0 (Sunday) … 6. Shared with the pasted booking's reader (`src/lib/domain/bookingPaste.ts`). */
export const WEEKDAYS: Record<string, number> = {
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

/**
 * `venues`: the courts the chat already knows, most likely first (its usual court, then the ones the
 * organizer played at). `clubs`: the clubs the directory lists in its zone, which a city or area word
 * alone never picks (`matchVenue`).
 */
export function parseNewCommand(args: string, opts: { tz: string; now?: Date; venues?: readonly string[]; clubs?: readonly string[] }): ParsedNew {
  const now = opts.now ?? new Date();
  const out: ParsedNew = { startsAt: null, date: null, time: null, venue: null, court: null, type: "match", format: null, capacity: null, levelMin: null, levelMax: null, cost: null, tzHint: tzHintFor(args), publicListing: false, timeFrom: null, dayTyped: false, meridiem: false, place: null, venueKnown: false, club: null };
  let text = ` ${args.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, " ").trim()} `;
  const take = (re: RegExp, on: (m: RegExpMatchArray) => boolean | void) => {
    text = text.replace(re, (...m) => {
      const match = m.slice(0, -2) as unknown as RegExpMatchArray;
      return on(match) === false ? match[0] : " ";
    });
  };

  // A crew's question ("who's in …?", "кто играет …?", "¿quién juega …?") asks for players; its words are not the place,
  // and neither are the small words after it ("who's in for the 7pm?", "who's in this Thursday …"). "next" stays: it moves the day.
  take(new RegExp(`^\\s*[¿¡]?\\s*(?:${ASK_PREFIX})(?:\\s+(?:for|on|the|this))*(?![\\p{L}\\d])`, "iu"), () => undefined);

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
  // Spanish "mañana" is also "morning": "por la mañana" and "de la mañana" name a part of the day, never
  // tomorrow, and "esta mañana" is this morning. "De la tarde" and "de la noche" say the hour is after noon.
  let half: "am" | "pm" | null = null;
  take(word("(?:por|de) la ma[ñn]ana"), () => {
    half = "am";
  });
  take(word("esta ma[ñn]ana"), () => {
    half = "am";
    dayOffset = 0;
  });
  take(word("(?:por|de) la (?:tarde|noche)"), () => {
    half = "pm";
  });
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
      take(word("tomorrow|tmr|tmrw|завтра"), () => {
        dayOffset = 1;
      });
    if (dayOffset == null)
      take(WEEKDAY_RE, (m) => {
        weekday = WEEKDAYS[m[0].toLowerCase().replace(/^el\s+/, "")];
      });
    // A bare "mañana" is tomorrow, unless a day was named: then "el jueves mañana" is Thursday morning.
    take(word("ma[ñn]ana"), () => {
      if (dayOffset == null && weekday == null) dayOffset = 1;
      else half ??= "am";
    });
  }
  out.dayTyped = Boolean(out.date) || dayOffset != null || weekday != null;

  // The time: 7pm, 19:00, 19.00, at 19, в 19, 19h, or a bare hour.
  let ampm = false;
  take(word("(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)"), (m) => {
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase() === "pm") h += 12;
    out.time = `${pad(h)}:${pad(Number(m[2] ?? 0))}`;
    ampm = true;
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
  if (out.time) out.timeFrom = "clock";
  if (!out.time)
    take(word("(\\d{1,2})"), (m) => {
      const h = Number(m[1]);
      if (h < 6 || h > 23) return false;
      out.time = `${pad(h)}:00`;
      out.timeFrom = "bare";
    });
  // "a las 7 de la tarde" is 19:00; an hour from 13 up is already past noon.
  const halfOfDay = half as "am" | "pm" | null;
  if (out.time && halfOfDay === "pm" && !ampm && Number(out.time.slice(0, 2)) < 12) out.time = `${pad(Number(out.time.slice(0, 2)) + 12)}${out.time.slice(2)}`;
  out.meridiem = ampm || halfOfDay != null;

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
  // Every preposition goes, not only the first: "в четверг в 19:00 Равай" leaves "Равай", not "в Равай".
  // `place` keeps the seat word as typed, so a crew's question with one in it ("Thursday 7pm I'm out,
  // anyone?") names no court it could be held at.
  const words = readWords(text.trim())?.kind;
  const left = text
    .replace(/[?!¿¡"«»“”]+/g, " ")
    .replace(word("at|in|on|в|во|на|у|@|с|from|en|a las|a la", "giu"), " ")
    .replace(/[,;·]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—.]+|[\s\-–—.]+$/g, "")
    .trim();
  const venue = words === "join" || words === "leave" ? "" : left;
  const known = venue && (opts.venues?.length || opts.clubs?.length) ? matchVenue(venue, opts.venues ?? [], opts.clubs ?? [], { inFull: true }) : null;
  // A club of the directory named in full by the line itself, not found through the chat's own courts.
  // The chat may know the same club by its own spelling ("Warehaus" for WAREHAUS.club): whether the match
  // sits at this club is the venue's slug's question (`createFromChat`), not a question of spelling.
  out.club = known && opts.clubs?.length ? matchVenue(venue, [], opts.clubs, { inFull: true }) : null;
  out.place = (words === "join" || words === "leave" ? text.trim() : venue) || null;
  out.venueKnown = Boolean(known);
  out.venue = known ?? (venue ? venue.slice(0, 80) : null);
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

// Words that name what a court is rather than which one, and the small words around a name: they point at no court in particular.
const GENERIC = new Set(["padel", "club", "the", "co", "sports", "sport", "tennis", "indoor", "outdoor", "hotel", "arena", "racquet", "racket", "court", "courts", "center", "centre", "academy", "and", "for", "this", "клуб", "падел", "корт", "de", "del", "la", "el"]);
// A city or a country ("phuket", "bangkok", "madrid"): it names no court, wherever it is typed.
const CITY_NAMES = new Set([...CITIES.flatMap((c) => [c.slug, c.name.toLowerCase()]), ...Object.keys(ZONE_ALIASES)]);
/**
 * The cities, islands and districts of Thailand and Singapore where the directory lists clubs, as single
 * words (a two-word name, "Chiang Mai", is both its words). Only the club matcher reads them: they decide
 * no time zone, because `tzHintFor` finds its needles inside other words.
 */
const PLACES_TH_SG = [
  // Thailand: the cities and islands, then Bangkok's districts and the streets the clubs are named for.
  "bangkok", "bkk", "samui", "kohsamui", "chaweng", "lamai", "bophut", "maenam", "phangan", "koh", "tao", "krabi", "aonang", "lanta", "phi", "pattaya", "jomtien", "naklua", "pratumnak", "chonburi", "sriracha", "rayong", "chiang", "mai", "chiangmai", "cnx", "nimman", "hua", "hin", "huahin", "pranburi", "trat", "chang", "khao", "lak", "khaolak", "phangnga", "sukhumvit", "asoke", "asok", "thonglor", "thonglo", "ekkamai", "ekamai", "phrom", "phong", "onnut", "nut", "silom", "sathorn", "sathon", "ari", "ratchada", "ladprao", "lat", "phrao", "bangna", "rama", "ramkhamhaeng", "chatuchak", "siam", "ploenchit", "nonthaburi", "banthatthong", "bangsaen",
  // Phuket's areas the time zone hints do not already name.
  "cherngtalay", "thalang", "kathu", "maikhao", "naiyang", "panwa", "layan", "chalong",
  // Singapore's districts.
  "orchard", "bedok", "changi", "bugis", "dempsey", "havelock", "holland", "ayer", "rajah", "jalan", "kayu", "sentosa", "chinatown", "tanjong", "pagar", "marina", "novena", "tampines", "jurong", "woodlands", "yishun", "punggol", "sengkang", "serangoon", "toa", "payoh", "bishan", "clementi", "buona", "vista", "kallang", "katong", "tiong", "bahru", "raffles", "newton", "tanglin", "bukit", "timah", "pasir", "ris", "queenstown", "alexandra", "harbourfront", "keppel", "seletar", "thomson", "kranji", "outram", "geylang", "paya", "lebar", "simei", "siglap", "kembangan", "eunos", "dover", "laguna",
];
// An area of a city ("rawai", "kata", "samui", "orchard"): a court the chat already knows may go by it ("Rawai" for the crew's
// Rawai Padel), a club in the directory may not, or "/new tmr 19:00 Samui" would land on a club's board and reach its regulars.
const AREA_WORDS = new Set([...CITY_WORDS.flatMap((c) => c.needles), ...PLACES_TH_SG].filter((n) => /^[\p{L}\d]+$/u.test(n) && !CITY_NAMES.has(n)));
/**
 * Words of a club's name that are everybody's words too ("Padel Asia", "Pad Thai Padel", "Padel Bay
 * Indoor Club", "No Drama Padel"): a /new line or a crew's question of these alone names no club, so "no
 * drama" in a chat is not a club in Bangkok. With the club's other words they still do ("Koh Tao Athletic").
 */
const COMMON_WORDS = new Set(["asia", "asian", "thai", "bay", "beach", "sky", "top", "pop", "swiss", "soi", "baan", "tropical", "lodge", "city", "park", "island", "east", "west", "north", "south", "central", "river", "valley", "coast", "hill", "garden", "house", "home", "prime", "station", "drama", "athletic", "destination"]);
/** The words a club's name carries beside its own: "Pattaya Padel" is Pattaya Padel Club, "Padel Bay" is Padel Bay Indoor Club. */
const FILLER = new Set([...GENERIC].filter((w) => !["padel", "падел", "tennis", "racquet", "racket"].includes(w)));
const filled = (words: string[]) => [...new Set(words.filter((w) => !FILLER.has(w)))].sort().join(" ");
// The same areas typed in Cyrillic, read as their Latin names, so "Равай" finds the crew's Rawai Padel.
const LATIN: Record<string, string> = { пхукет: "phuket", патонг: "patong", равай: "rawai", ката: "kata", карон: "karon", чалонг: "chalong", бангтао: "bangtao", камала: "kamala", найхарн: "naiharn", сурин: "surin", лагуна: "laguna", сингапур: "singapore" };
const placeWords = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\d]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => LATIN[w] ?? w);
/** The words of a name that tell one court from another: no generic word, no city, nothing under three letters. */
const distinct = (words: string[]) => words.filter((w) => w.length >= 3 && !GENERIC.has(w) && !CITY_NAMES.has(w));

/** The words of a name that tell one court from another, as `matchVenue` reads them ("WAREHAUS.club" → ["warehaus"]). */
export const distinctWords = (text: string): string[] => distinct(placeWords(text));

/** What a /new line must type to name a club of the directory in full: its distinct words, a district or a city aside ("Kross Padel Asoke" → ["kross"]). */
export const clubKeyWords = (name: string): string[] => distinctWords(name).filter((w) => !AREA_WORDS.has(w));

/** Words a crew's question may carry beside its day and hour that name no court: the game itself. */
const ASK_FILLER = new Set(["padel", "падел", "pádel", "game", "games", "match", "court", "корт", "игру", "игра", "матч", "партию", "partido", "pista", "juego", "the", "for", "this", "some", "one", "una", "uno"]);
/** Words that say no, short ones too: "No padel tomorrow 7pm, anyone?" asks for no match. */
const ASK_NO = new Set(["no", "not", "nobody", "none", "never", "nope", "не", "нет", "никто", "ни", "nadie", "ni", "nunca"]);

/**
 * True when what a crew's question leaves over names no court at all: nothing, or only the game itself
 * and small words ("who's in for a game Thursday 7pm?", "anyone for padel Sat 18:00?"). Then the crew's
 * usual court answers it. Anything else ("beers", "tennis", "I'm out", "no padel") is a place the chat
 * does not know, or no place for a match, and the question makes nothing.
 */
export const asksNoPlace = (text: string | null | undefined): boolean => !text || placeWords(text).every((w) => !ASK_NO.has(w) && (w.length < 3 || ASK_FILLER.has(w)));

/**
 * The known court the words point at, or null; `venues` are the chat's own courts (its usual court, the
 * sender's), `clubs` the directory's. In order:
 *
 * 1. The same words in any order ("bangkok padel club" is Padel Club Bangkok).
 * 2. The whole name inside the words, when every other word typed is generic ("Rawai Padel Club" is
 *    Rawai Padel; "Rawai Padel Park" stays the park, and "Top Padel Rawai" never becomes Top Padel).
 * 3. The one court that owns every word typed ("rawai", "blue tree"), so a new court that shares one
 *    word with a known one ("Rawai Beach Club") stays the new court. A city never decides, and an area
 *    decides only for the chat's own courts: "Rawai" is the crew's Rawai Padel, never the directory's.
 *    A word several courts own decides nothing, unless those are the chat's court spelled twice
 *    ("Rawai Padel Club" the chat typed and "Rawai Padel" in the directory), where the chat's first
 *    spelling wins; two clubs of the directory are never one court.
 *
 * `inFull` (the /new line, the owner's decision of 10 October 2026: "only on the club's own words"): a
 * club of the directory is named by its whole name, or by its name without the words around it
 * ("Pattaya Padel"), or by every word that tells it from other clubs, a district or a city aside
 * ("Kross Asoke", "Capella"); never by a word everybody uses ("Asia", "Thai", "Bay").
 */
export function matchVenue(text: string, venues: readonly string[], clubs: readonly string[] = [], o: { inFull?: boolean } = {}): string | null {
  const said = placeWords(text);
  if (said.length === 0) return null;
  const seen = new Set<string>();
  const known = [...venues.map((name) => ({ name, club: false })), ...clubs.map((name) => ({ name, club: true }))]
    .map((k) => ({ ...k, words: placeWords(k.name) }))
    .filter((k) => {
      const key = k.words.join(" ");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const saidSet = [...new Set(said)].sort().join(" ");
  const exact = known.find((k) => [...new Set(k.words)].sort().join(" ") === saidSet);
  if (exact) return exact.name;
  // In full: the club's name without the words around it ("club", "indoor", "the") is a club's name too,
  // when two words or more are left, or one that is the club's own ("Swiss" and "Racket" are anybody's).
  if (o.inFull) {
    const bare = filled(said);
    const left = bare.split(" ").filter(Boolean);
    const named = left.length >= 2 || (left.length === 1 && !GENERIC.has(left[0]) && !AREA_WORDS.has(left[0]) && !COMMON_WORDS.has(left[0])) ? known.filter((k) => k.club && filled(k.words) === bare) : [];
    if (named.length === 1) return named[0].name;
  }
  const typed = distinct(said);
  const joined = ` ${said.join(" ")} `;
  const whole = known
    .filter((k) => joined.includes(` ${k.words.join(" ")} `) && typed.every((w) => distinct(k.words).includes(w)))
    .sort((a, b) => b.words.length - a.words.length)[0];
  if (whole) return whole.name;
  if (typed.length === 0) return null;
  // A club of the directory needs every word typed, like any court, and a line of area words alone picks none.
  // In full (the /new line): a line of everybody's words picks none either, and the club's own words are
  // all typed ("Kross Asoke", never "Asoke"; "Pad Thai", never "Thai"), a district or a city aside.
  const weak = (w: string) => AREA_WORDS.has(w) || (o.inFull === true && COMMON_WORDS.has(w));
  const forClubs = typed.some((w) => !weak(w)) ? typed : [];
  const owners = known
    .map((k) => ({ ...k, own: distinct(k.words) }))
    .filter((k) => {
      const need = k.club ? forClubs : typed;
      if (!(need.length > 0 && need.every((w) => k.own.includes(w)))) return false;
      return !(k.club && o.inFull) || clubKeyWords(k.name).every((w) => typed.includes(w));
    });
  if (owners.length === 0) return null;
  const one = owners.every((o) => o.own.join(" ") === owners[0].own.join(" ")) && owners.filter((o) => o.club).length <= 1;
  return one ? owners[0].name : null;
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
