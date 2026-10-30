/**
 * The device hint's values, as pure rules (design B, the owner's decision of 28 October 2026). Safe in a
 * browser: the client reads the zone rule here before it reads anything else.
 *
 * The owner chose B for "the sign-in in a browser that has never seen the player": "I like A, obviously
 * the fingerprint needs to include more than just iphone model… is it really just the iphone model? Then
 * it should be B." On an iPhone in 2026 a page can read little that tells two phones apart (Safari 26
 * reports iOS 18.6 and "Apple GPU" everywhere, and adds noise to canvas and audio), so two iPhones of one
 * model look the same. The key therefore only ever leads to a question ("Welcome back, Tim?"), never to a
 * sign-in on its own.
 *
 * What a browser tells every site, and nothing more: the screen's two sides (sorted, so a turned phone
 * gives the same pair), the pixel ratio to a quarter, every language the browser asks for, the time zone,
 * the platform family (iPhone, iPad, Android or other), the touch points, the text size the phone's own
 * setting gives (`font: -apple-system-body`, where a browser knows it; else "na") and whether the person
 * asked for reduced motion.
 *
 * Since 30 October 2026 (v2), also three tests and five settings. The owner was told that a drawing test
 * and more settings add little and change the key at every iOS update, and was advised not to add them.
 * The owner answered: "I want them anyway." So the browser also sends a short hash of a small fixed
 * drawing (`canvas`), one of the WebGL renderer, four of its limits, its extensions and a small 3D drawing
 * (`webgl`), and one of a short sound rendered offline (`audio`); the hash, never the picture or the
 * sound. And the contrast, inverted colours and reduced transparency settings, the hour cycle and the
 * locale that Intl gives. Each is optional: an older client, a browser without the API, or a test that
 * throws gives "na", and that is still a good set. A test that is still running at the reader's limit
 * gives no "na": that read sends no values at all (src/lib/deviceSignals.ts), because a value that
 * depends on how busy the phone was would change the key. Every platform runs the three tests, iPhones,
 * iPads and Safari too: on 30 October 2026 the owner answered "On everywhere", and the known risk is
 * that Safari's noise differs between the browsers of one iPhone (DECIDING rule 40). Never a font list,
 * never the IP address, never the system's version, and never dark mode, which flips by itself with
 * "Automatic".
 *
 * The server checks every value here (`cleanSignals`): a type, a bound and an allowed set for each, and
 * the whole hint goes when one value fails. It keeps none of them: `canonicalSignals` is what the key is
 * made from (src/lib/deviceHint.ts), and only the key and a label in words reach the table.
 */

export const HINT_PLATFORMS = ["iphone", "ipad", "android", "other"] as const;
export type HintPlatform = (typeof HINT_PLATFORMS)[number];

/** The words a remembered phone is kept under, and listed under on My matches. Never more than the family. */
export const HINT_LABELS = { iphone: "iPhone", ipad: "iPad", android: "Android phone", other: "other" } as const satisfies Record<HintPlatform, string>;
export type HintLabel = (typeof HINT_LABELS)[HintPlatform];
/** Every label, in the order of the platforms. */
export const HINT_LABEL_LIST: readonly HintLabel[] = HINT_PLATFORMS.map((p) => HINT_LABELS[p]);
/** A label as an operator typed it, or null for anything that is not one of the four. Pure. */
export const hintLabelOf = (raw: unknown): HintLabel | null => (HINT_LABEL_LIST as readonly unknown[]).includes(raw) ? (raw as HintLabel) : null;

/** A value the browser cannot give: an older client, a missing API, or a test that threw. Never a test that was late. */
export const SIGNAL_NA = "na";
export type SignalNa = typeof SIGNAL_NA;

/** `prefers-contrast`: no-preference, more, less or custom. */
export const HINT_CONTRASTS = ["none", "more", "less", "custom"] as const;
export type HintContrast = (typeof HINT_CONTRASTS)[number];
/** `inverted-colors: inverted` and `prefers-reduced-transparency: reduce`: yes or no. */
export const HINT_FLAGS = ["yes", "no"] as const;
export type HintFlag = (typeof HINT_FLAGS)[number];
/** The hour cycle that `Intl.DateTimeFormat` resolves for an hour: the phone's 12- or 24-hour setting. */
export const HINT_HOUR_CYCLES = ["h11", "h12", "h23", "h24"] as const;
export type HintHourCycle = (typeof HINT_HOUR_CYCLES)[number];

/** The platform family from the browser's own words: an iPad that asks for the desktop site says "Macintosh" and has touch points. Pure. */
export function platformOf(ua: string, touch: number): HintPlatform {
  if (/iPhone|iPod/.test(ua)) return "iphone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return "ipad";
  return /Android/.test(ua) ? "android" : "other";
}

/** The values, checked and in their canonical form. */
export type DeviceSignals = {
  /** The screen's short side, then its long side, in CSS pixels. */
  screen: readonly [number, number];
  /** The device pixel ratio, to a quarter. */
  dpr: number;
  /** Every language the browser asks for, in lower case, in its order. */
  langs: readonly string[];
  /** The time zone, as the IANA name this runtime calls it (so "GB" and "Europe/London" are one). */
  tz: string;
  platform: HintPlatform;
  /** `navigator.maxTouchPoints`. */
  touch: number;
  /** The text size of the phone's own setting, in CSS pixels to a half; "na" where the browser has none. */
  text: number | "na";
  /** `prefers-reduced-motion: reduce`. */
  motion: boolean;
  /** v2: a short hash of the pixels of a small fixed 2D drawing, or "na". */
  canvas: string;
  /** v2: a short hash of the WebGL renderer and vendor, four limits, the extensions and a small 3D drawing, or "na". */
  webgl: string;
  /** v2: a short hash of a fixed oscillator through a compressor, rendered offline, or "na". */
  audio: string;
  contrast: HintContrast | SignalNa;
  inverted: HintFlag | SignalNa;
  transparency: HintFlag | SignalNa;
  hourCycle: HintHourCycle | SignalNa;
  /** The locale `Intl` resolves for a date, in lower case, or "na". */
  locale: string;
};

/**
 * What the browser sends: `readDeviceSignals` in src/lib/deviceSignals.ts writes this shape. The v2 values
 * are optional, so a client from before 30 October 2026 still sends a good set; a missing one is "na".
 */
export type SignalsWire = {
  w: number;
  h: number;
  dpr: number;
  langs: string[];
  tz: string;
  platform: HintPlatform;
  touch: number;
  text: number | "na";
  motion: boolean;
  canvas?: string;
  webgl?: string;
  audio?: string;
  contrast?: HintContrast | SignalNa;
  inverted?: HintFlag | SignalNa;
  transparency?: HintFlag | SignalNa;
  hourCycle?: HintHourCycle | SignalNa;
  locale?: string;
};

/** `hash`: the exact length of each test's hash (base64url, 72 bits of SHA-256), as `hashPrefix` in src/lib/deviceSignals.ts keeps it. */
export const SIGNAL_BOUNDS = { side: 20000, langs: 10, lang: 35, tz: 64, touch: 256, textMin: 4, textMax: 200, dprMin: 0.25, dprMax: 10, hash: 12, locale: 35 } as const;

const LANG = /^[a-z]{1,8}(-[a-z0-9]{1,8}){0,4}$/;
/** A locale can carry a little more than a language (`zh-hant-tw`, a `-u-hc-h23` extension). */
const LOCALE = /^[a-z]{1,8}(-[a-z0-9]{1,8}){0,6}$/;
const HASH = new RegExp(`^[A-Za-z0-9_-]{${SIGNAL_BOUNDS.hash}}$`);

/** A short hash a test made, as the server takes it: exactly `SIGNAL_BOUNDS.hash` base64url characters, or "na". Pure. */
export const isSignalHash = (v: unknown): v is string => v === SIGNAL_NA || (typeof v === "string" && HASH.test(v));

/** A locale as the server takes it: a lower-case tag inside its bound, or "na"; null for anything else. Pure. */
export function cleanLocale(v: unknown): string | null {
  if (v === SIGNAL_NA) return SIGNAL_NA;
  if (typeof v !== "string" || v.length < 1 || v.length > SIGNAL_BOUNDS.locale) return null;
  const lower = v.toLowerCase();
  return LOCALE.test(lower) ? lower : null;
}

/** One optional value: missing is "na", one of `allowed` or "na" is itself, anything else is null. */
const tokenOf = <T extends string>(v: unknown, allowed: readonly T[]): T | SignalNa | null => (v === undefined || v === SIGNAL_NA ? SIGNAL_NA : typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null);
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/**
 * The zone's IANA name as this runtime knows it, or null for anything that is not a zone. Case and the
 * old aliases fold into one name ("gb" and "Europe/London"), so the key and the European rule see one
 * spelling.
 */
export function canonicalZone(tz: unknown): string | null {
  if (typeof tz !== "string" || tz.length < 1 || tz.length > SIGNAL_BOUNDS.tz || !ZONE.test(tz)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * Zones outside `Europe/` where EU or UK law, or the EEA's, reaches the device: the Atlantic islands of
 * Portugal, Spain, Iceland, Denmark and Norway, Spain's Ceuta, Cyprus (whose zone is in Asia), and the
 * EU's outermost regions overseas. The old names that Intl still accepts (CET, GB, Eire) are here too, for
 * a runtime that does not fold them into a `Europe/` name. The owner's rule names "Europe/* and the
 * Atlantic zones of EU countries"; the rest is the same rule read with care, because a zone that is
 * left out saves a key that the law asks consent for.
 */
const EUROPEAN_ZONES: readonly string[] = [
  "Atlantic/Azores",
  "Atlantic/Madeira",
  "Atlantic/Canary",
  "Atlantic/Reykjavik",
  "Atlantic/Faroe",
  "Atlantic/Faeroe",
  "Atlantic/Jan_Mayen",
  "Arctic/Longyearbyen",
  "Africa/Ceuta",
  "Asia/Nicosia",
  "Asia/Famagusta",
  "America/Cayenne",
  "America/Guadeloupe",
  "America/Martinique",
  "America/Marigot",
  "Indian/Reunion",
  "Indian/Mayotte",
  "CET",
  "EET",
  "WET",
  "MET",
  "GB",
  "GB-Eire",
  "Eire",
  "Portugal",
  "Poland",
  "Iceland",
];
const EUROPEAN_LOWER: ReadonlySet<string> = new Set(EUROPEAN_ZONES.map((z) => z.toLowerCase()));

/**
 * Is this zone in Europe? EU and UK law asks consent before a site keeps a key made from what a device
 * tells it, so a browser set to a European zone gets no device hint at all: the browser does not send
 * its values, and the server saves nothing if they come anyway. A zone only suggests where a phone is;
 * that is the owner's accepted limit. Pure.
 */
export function isEuropeanZone(tz: string): boolean {
  return [canonicalZone(tz), tz].some((name) => typeof name === "string" && (name.toLowerCase().startsWith("europe/") || EUROPEAN_LOWER.has(name.toLowerCase())));
}

/**
 * The values a browser sent, checked one by one: the right type, inside its bounds, from its allowed set.
 * One bad value drops the whole hint (null), because a key made from part of the values would never match
 * the same phone again. Pure.
 */
export function cleanSignals(raw: unknown): DeviceSignals | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isInt(r.w, 1, SIGNAL_BOUNDS.side) || !isInt(r.h, 1, SIGNAL_BOUNDS.side)) return null;
  if (typeof r.dpr !== "number" || !Number.isFinite(r.dpr)) return null;
  const dpr = Math.round(r.dpr * 4) / 4;
  if (dpr < SIGNAL_BOUNDS.dprMin || dpr > SIGNAL_BOUNDS.dprMax) return null;
  if (!Array.isArray(r.langs) || r.langs.length < 1 || r.langs.length > SIGNAL_BOUNDS.langs) return null;
  const langs: string[] = [];
  for (const l of r.langs) {
    if (typeof l !== "string" || l.length > SIGNAL_BOUNDS.lang) return null;
    const lower = l.toLowerCase();
    if (!LANG.test(lower)) return null;
    langs.push(lower);
  }
  const tz = canonicalZone(r.tz);
  if (!tz) return null;
  if (typeof r.platform !== "string" || !(HINT_PLATFORMS as readonly string[]).includes(r.platform)) return null;
  if (!isInt(r.touch, 0, SIGNAL_BOUNDS.touch)) return null;
  let text: number | "na";
  if (r.text === "na") text = "na";
  else if (typeof r.text === "number" && Number.isFinite(r.text) && r.text >= SIGNAL_BOUNDS.textMin && r.text <= SIGNAL_BOUNDS.textMax) text = Math.round(r.text * 2) / 2;
  else return null;
  if (typeof r.motion !== "boolean") return null;
  // v2 (30 October 2026): each optional, each "na" when missing, and the whole hint goes when one comes bad.
  const hash = (v: unknown) => (v === undefined ? SIGNAL_NA : isSignalHash(v) ? v : null);
  const canvas = hash(r.canvas);
  const webgl = hash(r.webgl);
  const audio = hash(r.audio);
  const contrast = tokenOf(r.contrast, HINT_CONTRASTS);
  const inverted = tokenOf(r.inverted, HINT_FLAGS);
  const transparency = tokenOf(r.transparency, HINT_FLAGS);
  const hourCycle = tokenOf(r.hourCycle, HINT_HOUR_CYCLES);
  const locale = r.locale === undefined ? SIGNAL_NA : cleanLocale(r.locale);
  if (canvas === null || webgl === null || audio === null || contrast === null || inverted === null || transparency === null || hourCycle === null || locale === null) return null;
  return { screen: [Math.min(r.w, r.h), Math.max(r.w, r.h)], dpr, langs, tz, platform: r.platform as HintPlatform, touch: r.touch, text, motion: r.motion, canvas, webgl, audio, contrast, inverted, transparency, hourCycle, locale };
}

/**
 * The one string the key is made from. Versioned, so a change of what is read is a new string and the old
 * keys simply stop matching: `v2` since 30 October 2026, the v1 values and then the new ones in a fixed
 * order (production held no key that day, so none had to match). No value can hold the "|". Pure.
 */
export function canonicalSignals(s: DeviceSignals): string {
  return ["v2", `${s.screen[0]}x${s.screen[1]}`, String(s.dpr), s.langs.join(","), s.tz, s.platform, String(s.touch), String(s.text), s.motion ? "1" : "0", s.canvas, s.webgl, s.audio, s.contrast, s.inverted, s.transparency, s.hourCycle, s.locale].join("|");
}

/** The switch, `DEVICE_HINTS`: `off` saves nothing, `save` saves and asks nothing, `ask` saves and (part 2) asks. */
export type HintMode = "off" | "save" | "ask";

/** The switch as written: unset or empty is `ask`, the owner's default; a word it does not know is `off`, so a typo never saves more. Pure. */
export function hintModeOf(raw: string | null | undefined): HintMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return "ask";
  return v === "off" || v === "save" || v === "ask" ? v : "off";
}

export type HintDecision = { save: true; signals: DeviceSignals; label: HintLabel } | { save: false; why: "off" | "invalid" | "europe" };

/** Whether a door keeps a hint for what this browser sent: the switch on, every value good, and a zone outside Europe. Pure. */
export function hintDecision(raw: unknown, mode: HintMode): HintDecision {
  if (mode === "off") return { save: false, why: "off" };
  const signals = cleanSignals(raw);
  if (!signals) return { save: false, why: "invalid" };
  if (isEuropeanZone(signals.tz)) return { save: false, why: "europe" };
  return { save: true, signals, label: HINT_LABELS[signals.platform] };
}

/**
 * The cookie the Telegram return carries the values in: a sign-in by Telegram is a plain navigation, so
 * the values cannot travel as an argument. `writeSignalsCookie` (src/lib/deviceSignals.ts) writes it just
 * before the tab goes to the login route, which reads it and deletes it (`signalsFromCookie`). Bound to
 * that route, one minute, never for a European zone; /privacy names it.
 */
export const SIGNALS_COOKIE = "km_signals";
export const SIGNALS_COOKIE_PATH = "/api/telegram/login";
export const SIGNALS_COOKIE_MAX_AGE = 60;
/** The longest cookie value `signalsFromCookie` reads: the largest good set of v2, encoded, is about 960 and fits (`tests/device-hints.test.ts`). */
export const SIGNALS_COOKIE_MAX_CHARS = 1024;
