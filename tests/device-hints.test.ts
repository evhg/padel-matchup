import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { deviceHints, metricsDaily, players } from "@/db/schema";
import { anonymizePlayer } from "@/lib/domain/anonymize";
import { deviceHintsOf, forgetDeviceHints, forgetHintRow, HINT_KEEP_DAYS, HINTS_PER_PLAYER, pruneDeviceHints, saveDeviceHint, setHintsOff } from "@/lib/domain/deviceHints";
import { findDisposablePlayers, removeDisposablePlayers, DISPOSABLE_AFTER_DAYS } from "@/lib/domain/disposable";
import { createEvent } from "@/lib/domain/events";
import { canonicalSignals, cleanSignals, hintDecision, hintModeOf, isEuropeanZone, platformOf, SIGNALS_COOKIE_MAX_CHARS, type SignalsWire } from "@/lib/domain/hintSignals";
import { mergePlayers } from "@/lib/domain/merge";
import { dayKey } from "@/lib/domain/metrics";
import { exportPlayerData } from "@/lib/domain/profile";
import { joinEvent } from "@/lib/domain/slots";
import { HINT_PURPOSE, hintKey, saveHintLater, signalsFromCookie } from "@/lib/deviceHint";
import { AUDIO_START_MS, HINT_ASKED_KEY, hashPrefix, hintAnswerValues, hintAskOnce, readDeviceSignals, SIGNAL_BUDGET_MS, SIGNAL_GRACE_MS, SIGNAL_PROBES, type SignalProbes } from "@/lib/deviceSignals";
import { MyHints } from "@/components/MyHints";
import { freezeClock } from "./helpers/clock";
import { catalogue, renderIn } from "./helpers/render";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

/**
 * Device hints, design B (the owner's decision of 28 October 2026): "I like A, obviously the fingerprint
 * needs to include more than just iphone model… is it really just the iphone model? Then it should be B."
 * A key made on the server from what a browser tells every site, kept for a player at a join and at a
 * sign-in, so part 2 can ask "Welcome back, Tim?" in another browser on the same phone. Never a sign-in.
 */
const NOW = new Date(Date.UTC(2026, 9, 28, 5, 0));
freezeClock(NOW);
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

/** An iPhone in Phuket, as an older `readDeviceSignals` sends it: the v1 values, none of the 30 October 2026 ones. */
const PHONE: SignalsWire = { w: 390, h: 844, dpr: 3, langs: ["en-US", "th-TH"], tz: "Asia/Bangkok", platform: "iphone", touch: 5, text: 17, motion: false };
/** The same iPhone as the reader of 30 October 2026 sends it: the drawing, the 3D shape and the sound as short hashes, and five settings. */
const PHONE_V2: SignalsWire = { ...PHONE, canvas: "Qm9vbS1jYW52", webgl: "V2ViR0wtaGFz", audio: "QXVkaW8taGFz", contrast: "none", inverted: "no", transparency: "no", hourCycle: "h23", locale: "en-GB" };
/** What each new value is when the browser sends none of it. */
const NONE_NEW = { canvas: "na", webgl: "na", audio: "na", contrast: "na", inverted: "na", transparency: "na", hourCycle: "na", locale: "na" } as const;

// ------------------------------------------------------------------ the values, pure

describe("the canonical string", () => {
  it("is the checked values in a fixed order, versioned", () => {
    // v2 since the owner's "I want them anyway" (30 October 2026): the v1 values, then the drawing, the 3D
    // shape, the sound, the contrast, the inverted colours, the reduced transparency, the hour cycle and the locale.
    expect(canonicalSignals(cleanSignals(PHONE_V2)!)).toBe("v2|390x844|3|en-us,th-th|Asia/Bangkok|iphone|5|17|0|Qm9vbS1jYW52|V2ViR0wtaGFz|QXVkaW8taGFz|none|no|no|h23|en-gb");
  });

  it("is still a valid key from an older client or a browser with none of the new tests: each missing value is na", () => {
    expect(canonicalSignals(cleanSignals(PHONE)!)).toBe("v2|390x844|3|en-us,th-th|Asia/Bangkok|iphone|5|17|0|na|na|na|na|na|na|na|na");
    expect(cleanSignals(PHONE)).toEqual(cleanSignals({ ...PHONE, ...NONE_NEW }));
    // A browser that ran out of time on the sound sends "na" for it, and that is another key, not a refusal.
    expect(canonicalSignals(cleanSignals({ ...PHONE_V2, audio: "na" })!)).not.toBe(canonicalSignals(cleanSignals(PHONE_V2)!));
  });

  it("stays the same when the phone turns, and after rounding", () => {
    const turned = cleanSignals({ ...PHONE, w: 844, h: 390, dpr: 3.04, text: 17.1 })!;
    expect(canonicalSignals(turned)).toBe(canonicalSignals(cleanSignals(PHONE)!));
    // A pixel ratio goes to a quarter, a text size to a half.
    expect(cleanSignals({ ...PHONE, dpr: 2.6 })!.dpr).toBe(2.5);
    expect(cleanSignals({ ...PHONE, text: 19.3 })!.text).toBe(19.5);
  });

  it("folds case and an old zone name into one spelling", () => {
    expect(cleanSignals({ ...PHONE, tz: "asia/bangkok" })!.tz).toBe("Asia/Bangkok");
    expect(cleanSignals({ ...PHONE, langs: ["EN-us"] })!.langs).toEqual(["en-us"]);
  });

  it("changes with every value it reads", () => {
    const base = canonicalSignals(cleanSignals(PHONE_V2)!);
    const changes: Partial<SignalsWire>[] = [
      { w: 393 },
      { dpr: 2 },
      { langs: ["en-us"] },
      { tz: "Asia/Singapore" },
      { platform: "android" },
      { touch: 0 },
      { text: "na" },
      { motion: true },
      { canvas: "Q2FudmFzLXR3" },
      { webgl: "na" },
      { audio: "QXVkaW8tdHdv" },
      { contrast: "more" },
      { inverted: "yes" },
      { transparency: "na" },
      { hourCycle: "h12" },
      { locale: "en-us" },
    ];
    for (const change of changes) expect(canonicalSignals(cleanSignals({ ...PHONE_V2, ...change })!), JSON.stringify(change)).not.toBe(base);
  });

  it("folds the locale's case, as it does the languages'", () => {
    expect(cleanSignals({ ...PHONE_V2, locale: "EN-gb" })!.locale).toBe("en-gb");
    expect(cleanSignals({ ...PHONE_V2, locale: "zh-Hant-TW" })!.locale).toBe("zh-hant-tw");
  });
});

describe("the key", () => {
  const canonical = canonicalSignals(cleanSignals(PHONE)!);
  it("is an HMAC-SHA256 under a secret derived for the purpose device-hint:v1, base64url", () => {
    const secret = "a-session-secret-of-some-length";
    const derived = createHmac("sha256", secret).update("device-hint:v1").digest();
    expect(HINT_PURPOSE).toBe("device-hint:v1");
    expect(hintKey(canonical, secret)).toBe(createHmac("sha256", derived).update(canonical).digest("base64url"));
    expect(hintKey(canonical, secret)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Not the session secret used straight: a key from another purpose never equals it.
    expect(hintKey(canonical, secret)).not.toBe(createHmac("sha256", secret).update(canonical).digest("base64url"));
  });

  it("is the same for the same values and another for another secret, and carries none of the values", () => {
    expect(hintKey(canonical, "secret-one-secret-one")).toBe(hintKey(canonical, "secret-one-secret-one"));
    expect(hintKey(canonical, "secret-one-secret-one")).not.toBe(hintKey(canonical, "secret-two-secret-two"));
    const key = hintKey(canonical, "secret-one-secret-one");
    for (const v of ["390", "844", "Bangkok", "en-us", "iphone"]) expect(key.toLowerCase()).not.toContain(v.toLowerCase());
  });
});

describe("the server checks every value", () => {
  it("takes a good set", () => {
    expect(cleanSignals(PHONE)).toEqual({ screen: [390, 844], dpr: 3, langs: ["en-us", "th-th"], tz: "Asia/Bangkok", platform: "iphone", touch: 5, text: 17, motion: false, ...NONE_NEW });
    expect(cleanSignals(PHONE_V2)).toEqual({ screen: [390, 844], dpr: 3, langs: ["en-us", "th-th"], tz: "Asia/Bangkok", platform: "iphone", touch: 5, text: 17, motion: false, canvas: "Qm9vbS1jYW52", webgl: "V2ViR0wtaGFz", audio: "QXVkaW8taGFz", contrast: "none", inverted: "no", transparency: "no", hourCycle: "h23", locale: "en-gb" });
    expect(cleanSignals({ ...PHONE, text: "na", platform: "other", touch: 0 })).not.toBeNull();
    // Every token of each new value, and "na" for each.
    for (const contrast of ["none", "more", "less", "custom", "na"] as const) expect(cleanSignals({ ...PHONE_V2, contrast }), contrast).not.toBeNull();
    for (const flag of ["yes", "no", "na"] as const) expect(cleanSignals({ ...PHONE_V2, inverted: flag, transparency: flag }), flag).not.toBeNull();
    for (const hourCycle of ["h11", "h12", "h23", "h24", "na"] as const) expect(cleanSignals({ ...PHONE_V2, hourCycle }), hourCycle).not.toBeNull();
    expect(cleanSignals({ ...PHONE_V2, ...NONE_NEW })).toEqual(cleanSignals(PHONE));
  });

  it.each([
    ["nothing", null],
    ["a string", "390x844"],
    ["a list", [390, 844]],
    ["no width", { ...PHONE, w: undefined }],
    ["a width with a fraction", { ...PHONE, w: 390.5 }],
    ["a width of 0", { ...PHONE, w: 0 }],
    ["a height past the bound", { ...PHONE, h: 20001 }],
    ["a ratio that is not a number", { ...PHONE, dpr: Number.NaN }],
    ["a ratio under a quarter", { ...PHONE, dpr: 0.1 }],
    ["a ratio past ten", { ...PHONE, dpr: 11 }],
    ["no language", { ...PHONE, langs: [] }],
    ["eleven languages", { ...PHONE, langs: Array.from({ length: 11 }, () => "en") }],
    ["a language that is not a tag", { ...PHONE, langs: ["en_US"] }],
    ["a language too long", { ...PHONE, langs: [`en-${"a".repeat(40)}`] }],
    ["a language that is not text", { ...PHONE, langs: [7] }],
    ["languages as text", { ...PHONE, langs: "en-us" }],
    ["a zone nobody has", { ...PHONE, tz: "Foo/Bar" }],
    ["a path for a zone", { ...PHONE, tz: "../../etc/passwd" }],
    ["a zone too long", { ...PHONE, tz: `Asia/${"B".repeat(70)}` }],
    ["a platform outside the four", { ...PHONE, platform: "windows" }],
    ["negative touch points", { ...PHONE, touch: -1 }],
    ["touch points with a fraction", { ...PHONE, touch: 1.5 }],
    ["touch points past the bound", { ...PHONE, touch: 257 }],
    ["a text size as CSS", { ...PHONE, text: "17px" }],
    ["a text size too small", { ...PHONE, text: 3 }],
    ["a text size too big", { ...PHONE, text: 201 }],
    ["motion as a word", { ...PHONE, motion: "yes" }],
    // The values of 30 October 2026: each one optional, and when it comes it must be good.
    ["a drawing hash as a number", { ...PHONE_V2, canvas: 12345 }],
    ["a drawing hash too long", { ...PHONE_V2, canvas: "Qm9vbS1jYW52X" }],
    ["a drawing hash too short", { ...PHONE_V2, canvas: "Qm9vbS1jYW5" }],
    ["a drawing hash that is not base64url", { ...PHONE_V2, canvas: "Qm9vbS1jYW+/" }],
    ["a drawing sent as the picture", { ...PHONE_V2, canvas: `data:image/png;base64,${"A".repeat(200)}` }],
    ["a drawing hash with the separator", { ...PHONE_V2, canvas: "Qm9vbS|jYW52" }],
    ["a drawing hash of null", { ...PHONE_V2, canvas: null }],
    ["a 3D shape hash as a list", { ...PHONE_V2, webgl: ["V2ViR0wtaGFz"] }],
    ["a 3D shape hash too long", { ...PHONE_V2, webgl: "V2ViR0wtaGFzV2ViR0wtaGFz" }],
    ["the renderer's words instead of a hash", { ...PHONE_V2, webgl: "Apple GPU" }],
    ["a sound hash as a number", { ...PHONE_V2, audio: 124.04347527516074 }],
    ["an empty sound hash", { ...PHONE_V2, audio: "" }],
    ["a missing value spelled NA", { ...PHONE_V2, audio: "NA" }],
    ["a contrast outside the tokens", { ...PHONE_V2, contrast: "high" }],
    ["a contrast as the media query", { ...PHONE_V2, contrast: "prefers-contrast: more" }],
    ["a contrast as a number", { ...PHONE_V2, contrast: 1 }],
    ["inverted colours as a boolean", { ...PHONE_V2, inverted: true }],
    ["inverted colours as the media value", { ...PHONE_V2, inverted: "inverted" }],
    ["reduced transparency as the media value", { ...PHONE_V2, transparency: "reduce" }],
    ["an hour cycle nobody has", { ...PHONE_V2, hourCycle: "h25" }],
    ["an hour cycle as a number", { ...PHONE_V2, hourCycle: 24 }],
    ["a locale that is not a tag", { ...PHONE_V2, locale: "en_GB" }],
    ["a locale too long", { ...PHONE_V2, locale: `en-${"a".repeat(40)}` }],
    ["a locale with the separator", { ...PHONE_V2, locale: "en|gb" }],
    ["a locale as a number", { ...PHONE_V2, locale: 7 }],
  ] as const)("refuses %s", (_label, raw) => {
    expect(cleanSignals(raw)).toBeNull();
  });
});

describe("a browser in Europe keeps nothing", () => {
  it.each(["Europe/Madrid", "Europe/London", "Europe/Moscow", "Europe/Lisbon", "Atlantic/Canary", "Atlantic/Azores", "Atlantic/Madeira", "Atlantic/Reykjavik", "Atlantic/Faroe", "Africa/Ceuta", "Asia/Nicosia", "Indian/Reunion", "America/Martinique", "GB", "CET", "europe/paris"])("%s is European", (tz) => {
    expect(isEuropeanZone(tz)).toBe(true);
  });
  it.each(["Asia/Bangkok", "Asia/Singapore", "Asia/Ho_Chi_Minh", "America/New_York", "Atlantic/Bermuda", "Atlantic/St_Helena", "Australia/Perth", "UTC", "Africa/Casablanca"])("%s is not", (tz) => {
    expect(isEuropeanZone(tz)).toBe(false);
  });

  it("decides with the switch first, then every value, then the zone", () => {
    expect(hintDecision(PHONE, "off")).toEqual({ save: false, why: "off" });
    expect(hintDecision({ ...PHONE, w: -1 }, "ask")).toEqual({ save: false, why: "invalid" });
    expect(hintDecision({ ...PHONE, tz: "Europe/Madrid" }, "save")).toEqual({ save: false, why: "europe" });
    expect(hintDecision({ ...PHONE, tz: "Atlantic/Canary" }, "ask")).toEqual({ save: false, why: "europe" });
    expect(hintDecision(PHONE, "save")).toMatchObject({ save: true, label: "iPhone" });
    expect(hintDecision({ ...PHONE, platform: "android" }, "ask")).toMatchObject({ save: true, label: "Android phone" });
    expect(hintDecision({ ...PHONE, platform: "other" }, "ask")).toMatchObject({ save: true, label: "other" });
  });

  it("reads the switch: unset is ask, a word it does not know is off", () => {
    expect(hintModeOf(undefined)).toBe("ask");
    expect(hintModeOf("")).toBe("ask");
    expect(hintModeOf(" save ")).toBe("save");
    expect(hintModeOf("OFF")).toBe("off");
    expect(hintModeOf("ask")).toBe("ask");
    expect(hintModeOf("maybe")).toBe("off");
  });

  it("the Telegram return's cookie gives the values back, never a European set or a bad one", () => {
    expect(signalsFromCookie(encodeURIComponent(JSON.stringify(PHONE)))).toEqual(PHONE);
    expect(signalsFromCookie(encodeURIComponent(JSON.stringify(PHONE_V2)))).toEqual(PHONE_V2);
    expect(signalsFromCookie(encodeURIComponent(JSON.stringify({ ...PHONE_V2, contrast: "high" })))).toBeNull();
    // The largest set the server takes still fits the cookie: ten languages at the bound, the longest zone
    // name Intl takes, the longest token of each setting and a locale at its bound.
    const largest: SignalsWire = { ...PHONE_V2, w: 20000, h: 20000, dpr: 2.75, langs: Array.from({ length: 10 }, (_, i) => `e${"n".repeat(7)}-${String(i).repeat(8)}-${"a".repeat(8)}-${"b".repeat(8)}`), tz: "America/Argentina/ComodRivadavia", platform: "android", touch: 256, text: 17.5, contrast: "custom", inverted: "yes", transparency: "yes", hourCycle: "h23", locale: `${"l".repeat(8)}-${"m".repeat(8)}-${"n".repeat(8)}-${"o".repeat(8)}` };
    expect(largest.langs.every((l) => l.length === 35) && largest.locale!.length === 35).toBe(true);
    expect(cleanSignals(largest), "the largest set is a good set").not.toBeNull();
    const cookie = encodeURIComponent(JSON.stringify(largest));
    expect(cookie.length).toBeLessThanOrEqual(SIGNALS_COOKIE_MAX_CHARS);
    expect(signalsFromCookie(cookie)).toEqual(largest);
    expect(signalsFromCookie(encodeURIComponent(JSON.stringify({ ...PHONE, tz: "Europe/Madrid" })))).toBeNull();
    expect(signalsFromCookie(encodeURIComponent(JSON.stringify({ ...PHONE, w: "390" })))).toBeNull();
    expect(signalsFromCookie("{not json")).toBeNull();
    expect(signalsFromCookie("x".repeat(SIGNALS_COOKIE_MAX_CHARS + 1))).toBeNull();
    expect(signalsFromCookie(undefined)).toBeNull();
  });
});

describe("the browser's own reader", () => {
  /** Chrome on an Android phone. */
  const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
  /** Safari on an iPhone: the three tests run here too (the owner, 30 October 2026: "On everywhere"). */
  const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  /**
   * A phone, as the browser's globals: stubbed for one test and taken back after it (`vi.unstubAllGlobals`),
   * so the next file starts clean. The zone is the one value a test cannot set in a running process (a
   * worker ignores TZ), so `Intl.DateTimeFormat()` with no zone answers the phone's, and the one with an
   * hour answers the phone's clock (`clock`); with a zone it is Intl's own. `media` lists the media queries
   * that match; `asked` logs every media query the page asks. The phone is Chrome on Android unless `ua`
   * says otherwise; every platform runs the three tests.
   */
  type Phone = { sessionStorage?: unknown; media?: string[]; asked?: string[]; clock?: { hourCycle?: string; locale?: string }; ua?: string; touch?: number };
  const asPhone = (zone: string, probes: string[], { sessionStorage, media = [], asked = [], clock = { hourCycle: "h23", locale: "en-GB" }, ua = ANDROID_UA, touch = 5 }: Phone = {}) => {
    const Real = Intl.DateTimeFormat;
    const Fake = function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      if (args.length === 0) return { resolvedOptions: () => ({ timeZone: zone }) };
      if (args[1]?.hour === "numeric" && !args[1]?.timeZone) return { resolvedOptions: () => ({ timeZone: zone, ...clock }) };
      return new Real(...args);
    } as unknown as typeof Intl.DateTimeFormat;
    vi.stubGlobal("Intl", { ...Intl, DateTimeFormat: Fake });
    vi.stubGlobal("window", { devicePixelRatio: 3, location: { protocol: "https:" }, matchMedia: (q: string) => (asked.push(q), { matches: media.includes(q) }), sessionStorage });
    vi.stubGlobal("navigator", { userAgent: ua, maxTouchPoints: touch, languages: ["en-US", "th-TH"], language: "en-US" });
    vi.stubGlobal("screen", { width: 390, height: 844 });
    vi.stubGlobal("CSS", { supports: (p: string, v: string) => p === "font" && v === "-apple-system-body" });
    const span = { style: {} as Record<string, string>, remove: () => probes.push("removed") };
    vi.stubGlobal("document", { createElement: (tag: string) => (probes.push(`create:${tag}`), span), body: { appendChild: () => probes.push("append") } });
    vi.stubGlobal("getComputedStyle", () => ({ fontSize: span.style.font === "-apple-system-body" ? "17px" : "16px" }));
  };
  /** The three tests as stubs that log their call and answer a fixed short hash: the page's own drawing, 3D shape and sound are below. */
  const stubProbes = (probes: string[], answers: Partial<Record<keyof SignalProbes, () => Promise<string>>> = {}): SignalProbes => ({
    audio: () => (probes.push("audio"), (answers.audio ?? (async () => "QXVkaW8taGFz"))()),
    canvas: () => (probes.push("canvas"), (answers.canvas ?? (async () => "Qm9vbS1jYW52"))()),
    webgl: () => (probes.push("webgl"), (answers.webgl ?? (async () => "V2ViR0wtaGFz"))()),
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the values of a phone outside Europe: the text size through the phone's own font, the five settings, and each test once", async () => {
    const probes: string[] = [];
    asPhone("Asia/Bangkok", probes, { media: ["(prefers-contrast: no-preference)", "(inverted-colors: none)", "(prefers-reduced-transparency: no-preference)"] });
    const values = await readDeviceSignals(stubProbes(probes));
    expect(values).toEqual({ w: 390, h: 844, dpr: 3, langs: ["en-us", "th-th"], tz: "Asia/Bangkok", platform: "android", touch: 5, text: 17, motion: false, canvas: "Qm9vbS1jYW52", webgl: "V2ViR0wtaGFz", audio: "QXVkaW8taGFz", contrast: "none", inverted: "no", transparency: "no", hourCycle: "h23", locale: "en-gb" });
    // One span for the text size, put in and taken out; the sound starts first, so it renders while the page draws.
    expect(probes).toEqual(["create:span", "append", "removed", "audio", "canvas", "webgl"]);
    expect(cleanSignals(values)).not.toBeNull();
    expect(canonicalSignals(cleanSignals(values)!)).toBe(canonicalSignals(cleanSignals({ ...PHONE_V2, platform: "android" })!));
  });

  it("runs the three tests on every platform, iPhones, iPads and Safari included: each sends its three hashes", async () => {
    // The owner, 30 October 2026, asked "What should the iPhone do with the three tests?", answered "On
    // everywhere". The known risk: Safari may add noise that differs between Safari, Chrome and the
    // home-screen icon of one iPhone, so one phone can keep several keys (DECIDING rule 40). No engine and no
    // platform skips a test: the values never go without the three answers.
    const EVERY = [
      ["Safari on an iPhone", IPHONE_UA, 5, "iphone"],
      ["Chrome on an iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1", 5, "iphone"],
      ["Telegram's view on an iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", 5, "iphone"],
      ["an iPad that asks for the desktop site", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15", 5, "ipad"],
      ["Safari on a Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15", 0, "other"],
      ["Chrome on an Android phone", ANDROID_UA, 5, "android"],
      ["Samsung Internet", "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36", 5, "android"],
      ["Chrome on a Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36", 0, "other"],
      ["Edge on Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0", 0, "other"],
      ["Firefox on a Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0", 0, "other"],
    ] as const;
    for (const [who, ua, touch, platform] of EVERY) {
      // A new set of tests for each browser: one page, one set (`running`).
      const probes: string[] = [];
      asPhone("Asia/Bangkok", probes, { ua, touch, media: ["(prefers-contrast: no-preference)"] });
      const values = await readDeviceSignals(stubProbes(probes));
      expect(values, who).toMatchObject({ platform, canvas: "Qm9vbS1jYW52", webgl: "V2ViR0wtaGFz", audio: "QXVkaW8taGFz", contrast: "none", hourCycle: "h23" });
      expect(probes.filter((p) => p === "audio" || p === "canvas" || p === "webgl"), who).toEqual(["audio", "canvas", "webgl"]);
      expect(cleanSignals(values), who).not.toBeNull();
      // The family only names the label: an iPad that asks for the desktop site says "Macintosh" and has touch points.
      expect(platformOf(ua, touch), who).toBe(platform);
      vi.unstubAllGlobals();
    }
    // On an iPhone too, the rules of every read hold: a test still running at the limit makes the read null,
    // and a European zone runs no test at all.
    asPhone("Asia/Bangkok", [], { ua: IPHONE_UA });
    expect(await readDeviceSignals(stubProbes([], { canvas: () => new Promise<string>(() => undefined) }), 20)).toBeNull();
    vi.unstubAllGlobals();
    const spies = { audio: vi.fn(async () => "QXVkaW8taGFz"), canvas: vi.fn(async () => "Qm9vbS1jYW52"), webgl: vi.fn(async () => "V2ViR0wtaGFz") };
    asPhone("Europe/Madrid", [], { ua: IPHONE_UA });
    expect(await readDeviceSignals(spies)).toBeNull();
    expect(spies.audio).not.toHaveBeenCalled();
    expect(spies.canvas).not.toHaveBeenCalled();
    expect(spies.webgl).not.toHaveBeenCalled();
  });

  it("reads each setting as a short token, and na where the browser knows no such setting", async () => {
    const probes: string[] = [];
    asPhone("Asia/Bangkok", probes, { media: ["(prefers-contrast: more)", "(inverted-colors: inverted)", "(prefers-reduced-transparency: reduce)", "(prefers-reduced-motion: reduce)"], clock: { hourCycle: "h12", locale: "th-TH" } });
    expect(await readDeviceSignals(stubProbes(probes))).toMatchObject({ contrast: "more", inverted: "yes", transparency: "yes", motion: true, hourCycle: "h12", locale: "th-th" });
    vi.unstubAllGlobals();
    // A browser that matches no value of a feature does not know it (Chrome and inverted-colors): na, never "no".
    asPhone("Asia/Bangkok", probes, { media: ["(prefers-contrast: custom)"], clock: {} });
    expect(await readDeviceSignals(stubProbes(probes))).toMatchObject({ contrast: "custom", inverted: "na", transparency: "na", hourCycle: "na", locale: "na" });
    vi.unstubAllGlobals();
    asPhone("Asia/Bangkok", probes, { media: ["(prefers-contrast: less)"], clock: { hourCycle: "h24", locale: "en_GB" } });
    const odd = await readDeviceSignals(stubProbes(probes));
    // A locale the server would refuse goes as na, so one odd value never drops the whole hint.
    expect(odd).toMatchObject({ contrast: "less", hourCycle: "h24", locale: "na" });
    expect(cleanSignals(odd)).not.toBeNull();
  });

  it("reads nothing more, and sends nothing, in a European zone: no drawing, no 3D shape, no sound, no setting", async () => {
    const probes: string[] = [];
    const asked: string[] = [];
    const spies = { audio: vi.fn(async () => "QXVkaW8taGFz"), canvas: vi.fn(async () => "Qm9vbS1jYW52"), webgl: vi.fn(async () => "V2ViR0wtaGFz") };
    for (const zone of ["Europe/Madrid", "Atlantic/Canary", "Asia/Nicosia", "GB"]) {
      asPhone(zone, probes, { asked });
      expect(await readDeviceSignals(spies), zone).toBeNull();
      vi.unstubAllGlobals();
    }
    expect(spies.audio).not.toHaveBeenCalled();
    expect(spies.canvas).not.toHaveBeenCalled();
    expect(spies.webgl).not.toHaveBeenCalled();
    expect(probes).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("a browser without the APIs still sends a good set: each of the page's own tests gives na", async () => {
    // The real tests, in a "browser" with no canvas context, no WebGL and no OfflineAudioContext.
    const probes: string[] = [];
    asPhone("Asia/Bangkok", probes);
    const values = await readDeviceSignals({ ...SIGNAL_PROBES });
    expect(values).toMatchObject({ canvas: "na", webgl: "na", audio: "na" });
    expect(cleanSignals(values)).not.toBeNull();
  });

  it("a test that throws, fails, or answers anything but a short hash gives na", async () => {
    const probes: string[] = [];
    asPhone("Asia/Bangkok", probes);
    const values = await readDeviceSignals(
      stubProbes(probes, {
        canvas: () => {
          throw new Error("SecurityError");
        },
        webgl: async () => {
          throw new Error("context lost");
        },
        audio: async () => "Apple GPU",
      }),
    );
    expect(values).toMatchObject({ canvas: "na", webgl: "na", audio: "na", w: 390 });
    expect(cleanSignals(values)).not.toBeNull();
  });

  it(`finishes within ${SIGNAL_BUDGET_MS} ms: a test that hangs makes the read null at the limit, never a key with a late "na" in it`, async () => {
    // A "na" for a late test would put a timing into the key: one phone would save a key at an idle tap and
    // ask with another while the page was still busy (review of 30 October 2026). So a late read sends nothing.
    expect(SIGNAL_BUDGET_MS).toBe(150);
    const probes: string[] = [];
    asPhone("Asia/Bangkok", probes);
    const began = performance.now();
    const values = await readDeviceSignals(stubProbes(probes, { audio: () => new Promise<string>(() => undefined) }));
    const took = performance.now() - began;
    expect(values).toBeNull();
    expect(took).toBeGreaterThanOrEqual(SIGNAL_BUDGET_MS - 5);
    expect(took).toBeLessThan(SIGNAL_BUDGET_MS + 150);
    // A shorter budget, for a test that is late rather than stuck.
    const slow = await readDeviceSignals(stubProbes(probes, { webgl: () => new Promise<string>((done) => setTimeout(() => done("V2ViR0wtaGFz"), 80)) }), 20);
    expect(slow).toBeNull();
  });

  it(`a drawing that alone runs past the limit (a cold WebGL start) still gives its hash, and the others theirs, within ${SIGNAL_GRACE_MS} ms more`, async () => {
    // No timer can stop a synchronous step. Without the grace, the limit's timer would fire before the hashes
    // already asked for come back, and one slow start would turn every value into "na" and change the key.
    const probes: string[] = [];
    asPhone("Asia/Bangkok", probes);
    const busy = (ms: number) => {
      const until = performance.now() + ms;
      while (performance.now() < until) {
        // A drawing that takes the whole budget.
      }
    };
    const began = performance.now();
    const values = await readDeviceSignals(
      stubProbes(probes, {
        audio: () => hashPrefix("sound"),
        canvas: () => hashPrefix("drawing"),
        // The drawing takes the whole budget, and its hash comes back 10 ms later, as a digest does.
        webgl: () => (busy(SIGNAL_BUDGET_MS + 20), new Promise<string>((done) => setTimeout(() => done("V2ViR0wtaGFz"), 10))),
      }),
    );
    const took = performance.now() - began;
    expect(values).toMatchObject({ audio: await hashPrefix("sound"), canvas: await hashPrefix("drawing"), webgl: "V2ViR0wtaGFz" });
    expect(took).toBeLessThan(SIGNAL_BUDGET_MS + 20 + SIGNAL_GRACE_MS + 60);
    // A test that hangs still ends the read then, at the grace, and the read is null.
    const hungAt = performance.now();
    const hung = await readDeviceSignals(stubProbes(probes, { audio: () => new Promise<string>(() => undefined), webgl: () => (busy(SIGNAL_BUDGET_MS + 5), hashPrefix("shape")) }));
    expect(hung).toBeNull();
    expect(performance.now() - hungAt).toBeLessThan(SIGNAL_BUDGET_MS + 5 + SIGNAL_GRACE_MS + 60);
  });

  it("a second read in the same page runs no test again: a read while a test is late is null, and every later read gets the same whole set", async () => {
    const probes: string[] = [];
    asPhone("Asia/Bangkok", probes);
    const page = stubProbes(probes, { audio: () => new Promise<string>((done) => setTimeout(() => done("QXVkaW8taGFz"), 60)) });
    expect(await readDeviceSignals(page, 20)).toBeNull();
    await new Promise((done) => setTimeout(done, 80));
    probes.length = 0;
    const second = await readDeviceSignals(page, 20);
    expect(second).toMatchObject({ audio: "QXVkaW8taGFz", canvas: "Qm9vbS1jYW52", webgl: "V2ViR0wtaGFz" });
    expect(probes).toEqual(["create:span", "append", "removed"]);
    // A test that gave "na" gives it at every read of the page, never a hash at one and "na" at another.
    const missing = stubProbes(probes, { canvas: async () => "na" });
    const one = await readDeviceSignals(missing);
    expect(one).toMatchObject({ canvas: "na", audio: "QXVkaW8taGFz" });
    expect(await readDeviceSignals(missing)).toEqual(one);
    expect(await readDeviceSignals(page, 20)).toEqual(second);
  });

  it("hashes with SHA-256 and keeps a short base64url prefix, so only the hash ever leaves the browser", async () => {
    expect(await hashPrefix("abc")).toBe(createHash("sha256").update("abc").digest("base64url").slice(0, 12));
    const bytes = new Uint8Array([1, 2, 3, 250]);
    expect(await hashPrefix(bytes)).toBe(createHash("sha256").update(bytes).digest("base64url").slice(0, 12));
    expect(await hashPrefix("abc")).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  /** A context of any kind as a stub: every call is logged and answers nothing, but what `answers` names. */
  const fakeContext = (log: string[], answers: Record<string, (...a: unknown[]) => unknown>) =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, k) => (typeof k !== "string" ? undefined : k in answers ? answers[k] : /^[A-Z_0-9]+$/.test(k) ? k : (...a: unknown[]) => void log.push(`${k}(${a.length})`)),
      set: () => true,
    });
  const withCanvas = (probes: string[], contexts: Record<string, unknown>) => {
    vi.stubGlobal("document", {
      createElement: (tag: string) => (probes.push(`create:${tag}`), { width: 0, height: 0, getContext: (kind: string) => contexts[kind] ?? null }),
    });
  };

  it("the drawing: a fixed scene in two fonts with an emoji, a gradient and arcs, hashed from its pixels", async () => {
    const probes: string[] = [];
    const drawn: string[] = [];
    const pixels = new Uint8ClampedArray(240 * 60 * 4).map((_, i) => i % 251);
    const fonts: string[] = [];
    const texts: string[] = [];
    const g = fakeContext(drawn, {
      createLinearGradient: () => ({ addColorStop: () => drawn.push("stop") }),
      getImageData: () => ({ data: pixels }),
      fillText: (text: unknown) => void texts.push(String(text)),
    });
    const setFont = new Proxy(g, { set: (_t, k, v) => (k === "font" && fonts.push(String(v)), true) });
    withCanvas(probes, { "2d": setFont });
    const hash = await SIGNAL_PROBES.canvas();
    expect(hash).toBe(await hashPrefix(pixels));
    expect(hash).toHaveLength(12);
    expect(new Set(fonts.map((f) => f.split(" ").at(-1))).size).toBe(2);
    expect(texts.some((t) => /\p{Extended_Pictographic}/u.test(t))).toBe(true);
    expect(drawn.filter((d) => d.startsWith("arc(")).length).toBeGreaterThanOrEqual(2);
    expect(drawn).toContain("stop");
    // No context: na.
    withCanvas(probes, {});
    expect(await SIGNAL_PROBES.canvas()).toBe("na");
  });

  it("the 3D shape: the renderer, four limits, the extensions and a small drawing in one hash, and the context is let go", async () => {
    const probes: string[] = [];
    const log: string[] = [];
    const released: string[] = [];
    const glOf = (renderer: string) =>
      fakeContext(log, {
        getParameter: (p: unknown) => (p === "MAX_VIEWPORT_DIMS" ? new Int32Array([16384, 16384]) : p === "ALIASED_LINE_WIDTH_RANGE" ? new Float32Array([1, 1]) : p === "RENDERER" ? "WebKit WebGL" : p === "UNMASKED_RENDERER_WEBGL" ? renderer : p === "UNMASKED_VENDOR_WEBGL" ? "Apple Inc." : p === "MAX_TEXTURE_SIZE" || p === "MAX_RENDERBUFFER_SIZE" ? 16384 : null),
        getSupportedExtensions: () => ["OES_texture_float", "WEBGL_lose_context", "ANGLE_instanced_arrays"],
        getExtension: (name: unknown) => (name === "WEBGL_lose_context" ? { loseContext: () => released.push("lost") } : name === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: "UNMASKED_RENDERER_WEBGL", UNMASKED_VENDOR_WEBGL: "UNMASKED_VENDOR_WEBGL" } : null),
        createShader: () => ({}),
        createProgram: () => ({}),
        createBuffer: () => ({}),
        getAttribLocation: () => 0,
        getShaderParameter: () => true,
        getProgramParameter: () => true,
        readPixels: (...a: unknown[]) => void (a[6] as Uint8Array).fill(7),
      });
    withCanvas(probes, { webgl: glOf("Apple GPU") });
    const one = await SIGNAL_PROBES.webgl();
    expect(one).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(log).toContain("drawArrays(3)");
    expect(released).toEqual(["lost"]);
    withCanvas(probes, { webgl: glOf("Apple GPU") });
    expect(await SIGNAL_PROBES.webgl()).toBe(one);
    withCanvas(probes, { webgl: glOf("Adreno (TM) 740") });
    expect(await SIGNAL_PROBES.webgl()).not.toBe(one);
    withCanvas(probes, {});
    expect(await SIGNAL_PROBES.webgl()).toBe("na");
  });

  it("the sound: a fixed oscillator through a compressor, rendered offline with no gesture, its samples summed into one hash", async () => {
    const samples = Float32Array.from({ length: 5000 }, (_, i) => Math.sin(i / 7) / 3);
    const nodes: string[] = [];
    class FakeOffline {
      destination = { name: "out" };
      constructor(channels: number, length: number, rate: number) {
        nodes.push(`ctx(${channels},${length},${rate})`);
      }
      createOscillator() {
        return { type: "", frequency: { value: 0 }, connect: () => nodes.push("osc>"), start: () => nodes.push("start") };
      }
      createDynamicsCompressor() {
        const p = () => ({ value: 0 });
        return { threshold: p(), knee: p(), ratio: p(), attack: p(), release: p(), connect: () => nodes.push("comp>") };
      }
      startRendering() {
        return Promise.resolve({ getChannelData: () => samples });
      }
    }
    vi.stubGlobal("window", { OfflineAudioContext: FakeOffline });
    let sum = 0;
    for (let i = 4500; i < 5000; i++) sum += Math.abs(samples[i]);
    expect(await SIGNAL_PROBES.audio()).toBe(await hashPrefix(sum.toString()));
    expect(nodes).toEqual(["ctx(1,5000,44100)", "osc>", "comp>", "start"]);
    vi.stubGlobal("window", {});
    expect(await SIGNAL_PROBES.audio()).toBe("na");
  });

  it(`the sound: a browser that never renders without a tap gives na after ${AUDIO_START_MS} ms, every time, and a slow render that began still gives its hash`, async () => {
    // Such a browser leaves the context suspended and the sound never comes. As a late test it would make
    // every read null and turn the hints off for that browser; as "na" it is a value like any other.
    const samples = Float32Array.from({ length: 5000 }, (_, i) => Math.cos(i / 5) / 4);
    const offline = (render: (ctx: { state: string; currentTime: number }) => Promise<{ getChannelData: () => Float32Array }>) =>
      class {
        state = "suspended";
        currentTime = 0;
        destination = {};
        createOscillator() {
          return { type: "", frequency: { value: 0 }, connect: () => undefined, start: () => undefined };
        }
        createDynamicsCompressor() {
          const p = () => ({ value: 0 });
          return { threshold: p(), knee: p(), ratio: p(), attack: p(), release: p(), connect: () => undefined };
        }
        startRendering() {
          return render(this);
        }
      };
    const within = (p: Promise<string>, ms: number) => Promise.race([p, new Promise<string>((done) => setTimeout(() => done("still waiting"), ms))]);
    vi.stubGlobal("window", { OfflineAudioContext: offline(() => new Promise(() => undefined)) });
    for (let i = 0; i < 2; i++) expect(await within(SIGNAL_PROBES.audio(), AUDIO_START_MS + 100)).toBe("na");
    // Begun on the audio thread (its clock moved), though the page has not yet heard so: it waits for the sound.
    vi.stubGlobal("window", {
      OfflineAudioContext: offline((ctx) => {
        ctx.currentTime = 0.01;
        return new Promise((done) => setTimeout(() => done({ getChannelData: () => samples }), AUDIO_START_MS + 30));
      }),
    });
    let sum = 0;
    for (let i = 4500; i < 5000; i++) sum += Math.abs(samples[i]);
    expect(await within(SIGNAL_PROBES.audio(), AUDIO_START_MS + 200)).toBe(await hashPrefix(sum.toString()));
  });

  /** The tab's storage, as a log of what the page asked of it: a read is `get:`, a write is `set:`. */
  const tabStorage = (probes: string[]) => {
    const kept = new Map<string, string>();
    return {
      kept,
      storage: {
        getItem: (k: string) => (probes.push(`get:${k}`), kept.get(k) ?? null),
        setItem: (k: string, v: string) => void (probes.push(`set:${k}`), kept.set(k, v)),
        removeItem: (k: string) => void (probes.push(`remove:${k}`), kept.delete(k)),
      },
    };
  };

  it("the question writes nothing to the tab and sends nothing in a European zone, though the page mounts it there", async () => {
    // The server cannot know a browser's zone, so a European browser mounts `WelcomeBack` on a match with a
    // remembered player. EU and UK law asks consent for any storage on the device, personal data or not: the
    // zone comes before the tab's note (review, 28 October 2026).
    const probes: string[] = [];
    const tab = tabStorage(probes);
    for (const zone of ["Europe/Madrid", "Europe/London", "Atlantic/Canary", "Asia/Nicosia"]) {
      asPhone(zone, probes, { sessionStorage: tab.storage });
      expect(await hintAskOnce("ABC234", stubProbes(probes)), zone).toBeNull();
      vi.unstubAllGlobals();
    }
    expect(probes).toEqual([]);
    expect(tab.kept.size).toBe(0);
  });

  it("elsewhere the question writes one note a match in the tab, then reads the values; a second mount reads nothing", async () => {
    const probes: string[] = [];
    const tab = tabStorage(probes);
    asPhone("Asia/Bangkok", probes, { sessionStorage: tab.storage });
    const page = stubProbes(probes);
    expect(await hintAskOnce("ABC234", page)).toMatchObject({ tz: "Asia/Bangkok", w: 390, canvas: "Qm9vbS1jYW52" });
    expect(probes).toEqual([`get:${HINT_ASKED_KEY}ABC234`, `set:${HINT_ASKED_KEY}ABC234`, "create:span", "append", "removed", "audio", "canvas", "webgl"]);
    probes.length = 0;
    expect(await hintAskOnce("ABC234", page)).toBeNull();
    expect(probes).toEqual([`get:${HINT_ASKED_KEY}ABC234`]);
    // Another match in the same tab is asked once too.
    expect(await hintAskOnce("XYZ789", page)).not.toBeNull();
    expect([...tab.kept.keys()]).toEqual([`${HINT_ASKED_KEY}ABC234`, `${HINT_ASKED_KEY}XYZ789`]);
  });

  it("\"It's me\" and \"Not me\" send exactly the values that the question sent, and read nothing again", async () => {
    // A question and the tap that answers it send the same input: a tap that read again could make another
    // key, find no question, and cost the player a "That's me" attempt (review of 30 October 2026).
    const probes: string[] = [];
    const tab = tabStorage(probes);
    asPhone("Asia/Bangkok", probes, { sessionStorage: tab.storage, media: ["(prefers-contrast: no-preference)"] });
    const page = stubProbes(probes);
    expect(hintAnswerValues("TAP234", page)).toBeNull();
    const asked = await hintAskOnce("TAP234", page);
    expect(asked).toMatchObject({ contrast: "none", w: 390 });
    // The page changes under the question: another setting, another window. The taps still send the question's values.
    vi.stubGlobal("screen", { width: 412, height: 915 });
    vi.stubGlobal("window", { devicePixelRatio: 2, location: { protocol: "https:" }, matchMedia: (q: string) => ({ matches: q === "(prefers-contrast: more)" }), sessionStorage: tab.storage });
    probes.length = 0;
    expect(hintAnswerValues("TAP234", page)).toBe(asked);
    expect(probes).toEqual([]);
    // Another match in the page, and the same match in another page, have values of their own.
    expect(hintAnswerValues("XYZ789", page)).toBeNull();
    expect(hintAnswerValues("TAP234", stubProbes([]))).toBeNull();
    // And the question's two buttons send these, not a new read (a node test cannot tap, so it reads the component).
    const welcome = readFileSync(path.resolve(process.cwd(), "src/components/WelcomeBack.tsx"), "utf8");
    expect(welcome).toContain("deviceHintYesAction(code, hintAnswerValues(code))");
    expect(welcome).toContain("deviceHintNotMeAction(code, hintAnswerValues(code))");
    expect(welcome).not.toContain("readDeviceSignals");
  });

  it("a question whose read is late sends nothing and takes its note back, so a later view of the match may ask", async () => {
    const probes: string[] = [];
    const tab = tabStorage(probes);
    asPhone("Asia/Bangkok", probes, { sessionStorage: tab.storage });
    const slow = stubProbes(probes, { audio: () => new Promise<string>(() => undefined) });
    expect(await hintAskOnce("LATE34", slow)).toBeNull();
    expect(probes).toContain(`remove:${HINT_ASKED_KEY}LATE34`);
    expect(tab.kept.has(`${HINT_ASKED_KEY}LATE34`)).toBe(false);
    expect(hintAnswerValues("LATE34", slow)).toBeNull();
    // The next view, with every test in time, asks.
    expect(await hintAskOnce("LATE34", stubProbes(probes))).not.toBeNull();
    expect(tab.kept.has(`${HINT_ASKED_KEY}LATE34`)).toBe(true);
  });

  it("a tab whose storage refuses asks nothing, rather than once per view", async () => {
    const probes: string[] = [];
    asPhone("Asia/Bangkok", probes, {
      sessionStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      },
    });
    expect(await hintAskOnce("ABC234", stubProbes(probes))).toBeNull();
    expect(probes).toEqual([]);
  });
});

// ------------------------------------------------------------------ the rows

describe("the rows", () => {
  let db: Db;
  let close: () => Promise<void>;
  const envBefore = process.env.DEVICE_HINTS;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => {
    if (envBefore === undefined) delete process.env.DEVICE_HINTS;
    else process.env.DEVICE_HINTS = envBefore;
    await close();
  });

  const rowsOf = async (playerId: string) => db.select().from(deviceHints).where(eq(deviceHints.playerId, playerId));
  const metric = async (key: string) => Number((await db.select({ v: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.day, dayKey(NOW)), eq(metricsDaily.key, key))))[0]?.v ?? 0);
  const save = (playerId: string, key: string, days = 0, scope: Parameters<typeof saveDeviceHint>[1]["scope"] = null) => saveDeviceHint(db, { playerId, key, label: "iPhone", scope, now: at(days) });

  it("a second save of one key moves its last day and keeps its first", async () => {
    const ana = await makePlayer(db, "Ana");
    expect(await save(ana.id, "k-one", -10)).toEqual({ saved: true, collide: false });
    expect(await save(ana.id, "k-one", -2)).toEqual({ saved: true, collide: false });
    const rows = await rowsOf(ana.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt.toISOString()).toBe(at(-10).toISOString());
    expect(rows[0].lastSeenAt.toISOString()).toBe(at(-2).toISOString());
  });

  it("keeps three a player: a fourth key pushes out the one seen least recently", async () => {
    const bo = await makePlayer(db, "Bo");
    await save(bo.id, "k1", -30);
    await save(bo.id, "k2", -20);
    await save(bo.id, "k3", -10);
    // k1 is used again, so k2 is now the one seen least recently.
    await save(bo.id, "k1", -5);
    await save(bo.id, "k4", -1);
    const keys = (await rowsOf(bo.id)).map((r) => r.key).sort();
    expect(HINTS_PER_PLAYER).toBe(3);
    expect(keys).toEqual(["k1", "k3", "k4"]);
  });

  it("counts a save and, in a match, a clash with another remembered record of the match", async () => {
    const org = await makePlayer(db, "Kai");
    const tim = await makePlayer(db, "Tim");
    const ben = await makePlayer(db, "Ben");
    const far = await makePlayer(db, "Far");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(2), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: tim.id, now: NOW });
    await joinEvent(db, { eventId: ev.id, playerId: ben.id, now: NOW });
    const savedBefore = await metric("hint_saved");
    const collideBefore = await metric("hint_collide");
    // Somebody outside the match with the same key is no clash.
    expect(await save(far.id, "same-phone", 0, { eventId: ev.id })).toEqual({ saved: true, collide: false });
    expect(await save(tim.id, "same-phone", 0, { eventId: ev.id })).toEqual({ saved: true, collide: false });
    // Tim's own row of the key, seen again in the same match, is no clash with himself.
    expect(await save(tim.id, "same-phone", 0, { eventId: ev.id })).toEqual({ saved: true, collide: false });
    // Ben's phone gives Tim's key: one clash, found by the match's code too.
    expect(await save(ben.id, "same-phone", 0, { code: ev.code })).toEqual({ saved: true, collide: true });
    // With no match (a sign-in on My matches), nothing can clash.
    expect(await save(ben.id, "same-phone", 0, null)).toEqual({ saved: true, collide: false });
    // The organiser counts as in the match.
    expect(await save(org.id, "same-phone", 0, { eventId: ev.id })).toEqual({ saved: true, collide: true });
    expect((await metric("hint_saved")) - savedBefore).toBe(6);
    expect((await metric("hint_collide")) - collideBefore).toBe(2);
  });

  it("a key last seen more than a year ago is no clash", async () => {
    const org = await makePlayer(db, "Lea");
    const old = await makePlayer(db, "Old");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(3), tz: "Asia/Bangkok", venueName: "Kata Padel", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: old.id, now: NOW });
    await save(old.id, "stale-phone", -(HINT_KEEP_DAYS + 1));
    expect(await save(org.id, "stale-phone", 0, { eventId: ev.id })).toEqual({ saved: true, collide: false });
  });

  it("forgets one key, one row, or all; never another player's", async () => {
    const cy = await makePlayer(db, "Cy");
    const dee = await makePlayer(db, "Dee");
    await save(cy.id, "a");
    await save(cy.id, "b");
    await save(cy.id, "c");
    await save(dee.id, "a");
    expect(await forgetDeviceHints(db, cy.id, "a")).toBe(1);
    expect((await rowsOf(cy.id)).map((r) => r.key).sort()).toEqual(["b", "c"]);
    const [deeRow] = await rowsOf(dee.id);
    expect(await forgetHintRow(db, cy.id, deeRow.id)).toBe(false);
    expect(await forgetHintRow(db, cy.id, "not-an-id")).toBe(false);
    const [b] = (await rowsOf(cy.id)).filter((r) => r.key === "b");
    expect(await forgetHintRow(db, cy.id, b.id)).toBe(true);
    expect(await forgetDeviceHints(db, cy.id)).toBe(1);
    expect(await rowsOf(cy.id)).toHaveLength(0);
    expect(await rowsOf(dee.id)).toHaveLength(1);
  });

  it("the hourly job deletes rows last seen more than a year ago, a bounded batch a run", async () => {
    // The tests above left old rows of their own; this one counts from an empty table.
    await db.delete(deviceHints);
    const eve = await makePlayer(db, "Eve");
    const fay = await makePlayer(db, "Fay");
    const gus = await makePlayer(db, "Gus");
    await save(eve.id, "old-1", -(HINT_KEEP_DAYS + 1));
    await save(fay.id, "old-2", -(HINT_KEEP_DAYS + 30));
    await save(gus.id, "old-3", -(HINT_KEEP_DAYS + 2));
    await save(gus.id, "recent", -(HINT_KEEP_DAYS - 1));
    expect(await pruneDeviceHints(db, NOW, 2)).toBe(2);
    expect(await pruneDeviceHints(db, NOW, 2)).toBe(1);
    expect(await pruneDeviceHints(db, NOW, 2)).toBe(0);
    expect((await rowsOf(gus.id)).map((r) => r.key)).toEqual(["recent"]);
  });

  it("a merge moves the rows to the record that stays, drops a key both held, and keeps three", async () => {
    const keep = await makePlayer(db, "Hal");
    const gone = await makePlayer(db, "Hal");
    await save(keep.id, "x", -9);
    await save(keep.id, "shared", -8);
    await save(gone.id, "shared", -1);
    await save(gone.id, "y", -3);
    await save(gone.id, "z", -2);
    await mergePlayers(db, keep.id, [gone.id], { door: "operator" });
    const rows = await rowsOf(keep.id);
    // Four distinct keys arrived; the one seen least recently (x) goes, and one row of "shared" stays.
    expect(rows.map((r) => r.key).sort()).toEqual(["shared", "y", "z"]);
    expect(await rowsOf(gone.id)).toHaveLength(0);
  });

  it("an account deletion takes them", async () => {
    const ivy = await makePlayer(db, "Ivy");
    await save(ivy.id, "ivy-phone");
    await anonymizePlayer(db, ivy.id, NOW);
    expect(await rowsOf(ivy.id)).toHaveLength(0);
  });

  it("a hint keeps no record alive: a record with nothing else goes at the disposal, and its rows with it", async () => {
    const jo = await makePlayer(db, "Jo", { createdAt: at(-(DISPOSABLE_AFTER_DAYS + 1)) });
    await save(jo.id, "jo-phone", -1);
    expect((await findDisposablePlayers(db, NOW)).map((p) => p.id)).toContain(jo.id);
    expect((await removeDisposablePlayers(db, NOW)).map((p) => p.id)).toContain(jo.id);
    expect(await rowsOf(jo.id)).toHaveLength(0);
  });

  it("the download lists each remembered phone by its label and two days, never its key", async () => {
    const kim = await makePlayer(db, "Kim");
    await save(kim.id, "kim-secret-key-value", -4);
    await save(kim.id, "kim-secret-key-value", -1);
    const [player] = await db.select().from(players).where(eq(players.id, kim.id));
    const data = await exportPlayerData(db, player, "https://example.test", NOW);
    expect(data.deviceHints).toEqual([{ label: "iPhone", savedAt: at(-4), lastSeenAt: at(-1) }]);
    expect(JSON.stringify(data)).not.toContain("kim-secret-key-value");
    expect((await deviceHintsOf(db, kim.id)).map((r) => Object.keys(r).sort())).toEqual([["createdAt", "id", "label", "lastSeenAt"]]);
  });

  it("a door's save: kept outside Europe with the switch on, nothing in Europe or with the switch off", async () => {
    const lou = await makePlayer(db, "Lou");
    delete process.env.DEVICE_HINTS;
    await saveHintLater(db, lou.id, { ...PHONE, tz: "Europe/Madrid" }, null, NOW);
    await saveHintLater(db, lou.id, { ...PHONE, w: "390" }, null, NOW);
    expect(await rowsOf(lou.id)).toHaveLength(0);
    process.env.DEVICE_HINTS = "off";
    await saveHintLater(db, lou.id, PHONE, null, NOW);
    expect(await rowsOf(lou.id)).toHaveLength(0);
    process.env.DEVICE_HINTS = "save";
    await saveHintLater(db, lou.id, PHONE, null, NOW);
    const rows = await rowsOf(lou.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("iPhone");
    expect(rows[0].key).toBe(hintKey(canonicalSignals(cleanSignals(PHONE)!)));
    // Never the values: the row has only these columns, and none but the random id, the player's id and the
    // HMAC (checked above) can hold text, so only the label is searched. Searching the whole row failed at
    // random once, on 28 October 2026: a fresh uuid, b0313907-…, holds "390".
    expect(Object.keys(rows[0]).sort()).toEqual(["createdAt", "id", "key", "label", "lastSeenAt", "playerId"]);
    expect(rows[0].label).not.toMatch(/390|844|Bangkok|en-us/i);
    delete process.env.DEVICE_HINTS;
    // Unset is "ask", which saves too: another browser on the same phone refreshes the same row.
    await saveHintLater(db, lou.id, { ...PHONE, w: 844, h: 390 }, null, at(1));
    expect(await rowsOf(lou.id)).toHaveLength(1);
  });
});

describe("the objection: \"Don't recognise my phones\"", () => {
  // Thai PDPA s.32: the key is saved with no tap, under a legitimate interest, so a player may object for
  // good. `players.hints_off` holds the moment; while it is set, no door keeps a key (DECIDING rule 40).
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => {
    await close();
  });

  const rowsOf = async (playerId: string) => db.select().from(deviceHints).where(eq(deviceHints.playerId, playerId));
  const markOf = async (playerId: string) => (await db.select({ off: players.hintsOff }).from(players).where(eq(players.id, playerId)))[0]?.off ?? null;
  const metric = async (key: string) => Number((await db.select({ v: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.day, dayKey(NOW)), eq(metricsDaily.key, key))))[0]?.v ?? 0);
  const save = (d: Db, playerId: string, key: string, days = 0, scope: Parameters<typeof saveDeviceHint>[1]["scope"] = null) => saveDeviceHint(d, { playerId, key, label: "iPhone", scope, now: at(days) });

  /** The database, counting every query that reaches it: a save must stay one statement, with no read before it. */
  const counting = () => {
    const calls: string[] = [];
    const QUERIES = new Set(["execute", "select", "insert", "update", "delete", "transaction", "query"]);
    const proxied = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop === "string" && QUERIES.has(prop) && typeof value === "function") {
          return (...args: unknown[]) => {
            calls.push(prop);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });
    return { db: proxied as Db, calls };
  };

  it("the switch deletes every row of the player, keeps the moment, and counts hint_objected once", async () => {
    const ana = await makePlayer(db, "Ana");
    const bo = await makePlayer(db, "Bo");
    await save(db, ana.id, "a1", -3);
    await save(db, ana.id, "a2", -2);
    await save(db, ana.id, "a3", -1);
    await save(db, bo.id, "a1", -1);
    const before = await metric("hint_objected");
    expect(await setHintsOff(db, ana.id, true, NOW)).toEqual({ changed: true, forgotten: 3 });
    expect(await rowsOf(ana.id)).toHaveLength(0);
    expect((await markOf(ana.id))?.toISOString()).toBe(NOW.toISOString());
    // Another player with the same key keeps his row.
    expect(await rowsOf(bo.id)).toHaveLength(1);
    expect((await metric("hint_objected")) - before).toBe(1);
    // A second tap changes nothing: the first moment stays, and nothing is counted twice.
    expect(await setHintsOff(db, ana.id, true, at(1))).toEqual({ changed: false, forgotten: 0 });
    expect((await markOf(ana.id))?.toISOString()).toBe(NOW.toISOString());
    expect((await metric("hint_objected")) - before).toBe(1);
  });

  it("no save while it is set, inside the save's own one statement: no row, no counter, no clash", async () => {
    const org = await makePlayer(db, "Kai");
    const tim = await makePlayer(db, "Tim");
    const cy = await makePlayer(db, "Cy");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: at(2), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: tim.id, now: NOW });
    await joinEvent(db, { eventId: ev.id, playerId: cy.id, now: NOW });
    await save(db, tim.id, "one-phone", 0, { eventId: ev.id });
    await setHintsOff(db, cy.id, true, NOW);
    const saved = await metric("hint_saved");
    const collide = await metric("hint_collide");
    const c = counting();
    // Cy's phone gives Tim's key in the same match: with the mark set, nothing is kept and no clash is counted.
    expect(await save(c.db, cy.id, "one-phone", 0, { eventId: ev.id })).toEqual({ saved: false, collide: false });
    expect(c.calls).toEqual(["execute"]);
    expect(await rowsOf(cy.id)).toHaveLength(0);
    expect((await metric("hint_saved")) - saved).toBe(0);
    expect((await metric("hint_collide")) - collide).toBe(0);
    // A door's save goes through the same statement.
    await saveHintLater(db, cy.id, PHONE, { eventId: ev.id }, NOW);
    expect(await rowsOf(cy.id)).toHaveLength(0);
    // Tim, who never objected, still saves in one statement.
    const t = counting();
    expect(await save(t.db, tim.id, "one-phone", 0, { eventId: ev.id })).toEqual({ saved: true, collide: false });
    expect(t.calls).toEqual(["execute"]);
  });

  it("clearing it lets the next act save again", async () => {
    const dee = await makePlayer(db, "Dee");
    await setHintsOff(db, dee.id, true, NOW);
    expect((await save(db, dee.id, "dee-phone")).saved).toBe(false);
    expect(await setHintsOff(db, dee.id, false, NOW)).toEqual({ changed: true, forgotten: 0 });
    expect(await markOf(dee.id)).toBeNull();
    expect((await save(db, dee.id, "dee-phone")).saved).toBe(true);
    expect(await rowsOf(dee.id)).toHaveLength(1);
    // Clearing a mark that is not there changes nothing.
    expect(await setHintsOff(db, dee.id, false, NOW)).toEqual({ changed: false, forgotten: 0 });
    expect(await rowsOf(dee.id)).toHaveLength(1);
  });

  it("a merge keeps the mark when either record has it, and then keeps no row", async () => {
    // The source objected: the survivor takes the mark, and the rows of both go.
    const keep = await makePlayer(db, "Eve");
    const gone = await makePlayer(db, "Eve");
    await save(db, keep.id, "eve-1", -2);
    await setHintsOff(db, gone.id, true, at(-1));
    await mergePlayers(db, keep.id, [gone.id], { door: "operator" });
    expect((await markOf(keep.id))?.toISOString()).toBe(at(-1).toISOString());
    expect(await rowsOf(keep.id)).toHaveLength(0);
    // The survivor objected: the source's rows arrive and go, and the survivor keeps its own moment.
    const fay = await makePlayer(db, "Fay");
    const fay2 = await makePlayer(db, "Fay");
    await setHintsOff(db, fay.id, true, at(-5));
    await save(db, fay2.id, "fay-1", -1);
    await mergePlayers(db, fay.id, [fay2.id], { door: "operator" });
    expect((await markOf(fay.id))?.toISOString()).toBe(at(-5).toISOString());
    expect(await rowsOf(fay.id)).toHaveLength(0);
    // Both objected: the earlier moment stays.
    const gus = await makePlayer(db, "Gus");
    const gus2 = await makePlayer(db, "Gus");
    await setHintsOff(db, gus.id, true, at(-1));
    await setHintsOff(db, gus2.id, true, at(-9));
    await mergePlayers(db, gus.id, [gus2.id], { door: "operator" });
    expect((await markOf(gus.id))?.toISOString()).toBe(at(-9).toISOString());
    // Neither objected: no mark, and the rows stay as before.
    const hal = await makePlayer(db, "Hal");
    const hal2 = await makePlayer(db, "Hal");
    await save(db, hal2.id, "hal-1", -1);
    await mergePlayers(db, hal.id, [hal2.id], { door: "operator" });
    expect(await markOf(hal.id)).toBeNull();
    expect(await rowsOf(hal.id)).toHaveLength(1);
  });

  it("an account deletion clears the mark with the rest", async () => {
    const ivy = await makePlayer(db, "Ivy");
    await setHintsOff(db, ivy.id, true, NOW);
    await anonymizePlayer(db, ivy.id, NOW);
    expect(await markOf(ivy.id)).toBeNull();
  });

  const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
  const page = (l: "en" | "ru" | "es", props: Parameters<typeof MyHints>[0]) => renderIn(l, createElement(AppRouterContext.Provider, { value: router as never }, createElement(MyHints, props)));
  const unquote = (html: string) => html.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

  it("My matches shows the switch by its own name, says what it does, and tells a session by name why it is locked", () => {
    const row = { id: "00000000-0000-4000-8000-000000000001", label: "iPhone", first: "Oct 1", last: "Oct 27" };
    // A record with no phone and no mark, on a deployment that keeps no key (`DEVICE_HINTS=off`): no block at all.
    expect(page("en", { rows: [] })).toBe("");
    for (const l of ["en", "ru", "es"] as const) {
      const id = catalogue(l).identity as Record<string, string>;
      const on = unquote(page(l, { rows: [], off: true }));
      // On: no phone listed, the switch checked, and the line says it lasts until it is switched off.
      expect(on, l).toContain(`role="switch" aria-checked="true" aria-label="${id.hintsOff}"`);
      expect(on, l).toContain(id.hintsOffOn);
      expect(on, l).not.toContain('data-testid="my-hint"');
      const plain = unquote(page(l, { rows: [row] }));
      expect(plain, l).toContain(`role="switch" aria-checked="false" aria-label="${id.hintsOff}"`);
      expect(plain, l).toContain(id.hintsOffHelp);
      expect(plain, l).not.toContain('data-testid="hints-off-locked"');
      // A session by name: the switch is there, locked, and the line names the doors below that prove it.
      const locked = unquote(page(l, { rows: [row], locked: true, doors: "email" }));
      expect(locked, l).toMatch(/role="switch"[^>]*disabled=""/);
      expect(locked, l).toContain('data-testid="hints-off-locked"');
      expect(locked, l).toContain(id.hintsOffLocked.split(" {doors")[0]);
    }
    expect(unquote(page("en", { rows: [row], locked: true, doors: "both" }))).toContain("confirm your email with the code we send, or link Telegram, below");
    expect(unquote(page("en", { rows: [row], locked: true, doors: "other" }))).toContain("Change it from the browser where you first joined.");
  });

  it("the switch stays with no phone while the deployment keeps keys: before the first key, and after the last one went", () => {
    // The privacy page sends the player to this switch "at any time" (PDPA s.32). "Forget this phone" on the
    // last row, the yearly prune or a stranger's "Not me" leave no row; the switch must still be there, or
    // the next join keeps a key before the player can object.
    for (const l of ["en", "ru", "es"] as const) {
      const id = catalogue(l).identity as Record<string, string>;
      const html = unquote(page(l, { rows: [], enabled: true }));
      expect(html, l).toContain('data-testid="my-hints"');
      expect(html, l).toMatch(/role="switch" aria-checked="false"[^>]*data-testid="hints-off-switch"/);
      expect(html, l).toContain(id.hintsOffHelp);
      // No list, no help about the list, no line about the deletion of rows that are not there.
      expect(html, l).not.toContain('data-testid="my-hint"');
      expect(html, l).not.toContain(id.hintsHelp);
    }
  });

  it("the download lists the mark", async () => {
    const jo = await makePlayer(db, "Jo");
    const read = async () => exportPlayerData(db, (await db.select().from(players).where(eq(players.id, jo.id)))[0], "https://example.test", NOW);
    expect((await read()).player.hintsOff).toBeNull();
    await setHintsOff(db, jo.id, true, at(-2));
    expect((await read()).player.hintsOff).toEqual(at(-2));
  });
});
