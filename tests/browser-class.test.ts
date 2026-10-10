import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily } from "@/db/schema";
import { BROWSER_CLASSES, browserClass, type BrowserClass } from "@/lib/domain/browserClass";
import { dayKey } from "@/lib/domain/metrics";
import { countNewRecord, countSignIn } from "@/lib/domain/signins";
import { freezeClock } from "./helpers/clock";
import { createTestDb } from "./helpers/db";

/**
 * The counters that find the "jar": which browser makes the second record of a player who has
 * played before. Real user-agent strings, as phones send them; the class is the whole of what is kept.
 */
const UA: [string, string, BrowserClass][] = [
  ["Safari on an iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "ios_safari"],
  ["the browser suites' iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", "ios_safari"],
  ["Chrome on an iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1", "ios_chrome"],
  ["Firefox on an iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15", "ios_other"],
  ["the home-screen icon on an iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", "ios_webview"],
  ["Instagram on an iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 337.0.3.23.54 (iPhone14,5; iOS 17_5; en_US; en; scale=3.00; 1170x2532; 614104412)", "app_instagram"],
  ["Facebook on an iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.38.109;FBBV/617553227;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5;FBRV/619004339]", "app_facebook"],
  ["LINE on an iPhone, which also says Safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.9.0", "app_line"],
  ["Chrome on Android", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36", "android_chrome"],
  ["Samsung Internet", "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36", "android_samsung"],
  ["an Android app's own view", "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36", "android_webview"],
  ["Firefox on Android", "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0", "android_other"],
  ["Telegram's browser on Android", "Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.6422.165 Mobile Safari/537.36 Telegram-Android/11.0.0 (Samsung SM-S918B; Android 14; SDK 34; HIGH)", "app_telegram"],
  ["Instagram on Android", "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240605.024; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36 Instagram 337.0.0.35.102 Android (34/14; 420dpi; 1080x2400; Google/google; Pixel 8; shiba; shiba; en_US; 614104412)", "app_instagram"],
  ["Facebook on Android", "Mozilla/5.0 (Linux; Android 14; SM-A546B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.43.108;]", "app_facebook"],
  ["LINE on Android", "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP2A.240605.024; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36 Line/14.10.0/IAB", "app_line"],
  ["a page that names WhatsApp", "Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36 WhatsApp/2.24.13.78", "app_whatsapp"],
  ["Chrome on a Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "desktop"],
  ["Edge on Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0", "desktop"],
  ["Firefox on Linux", "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0", "desktop"],
  ["Safari on an iPad, which says Macintosh", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", "desktop"],
  ["no user agent at all", "", "other"],
  ["a script", "curl/8.5.0", "other"],
];

describe("which browser made a new record", () => {
  it.each(UA)("%s", (_label, ua, cls) => {
    expect(browserClass(ua)).toBe(cls);
  });

  it("every class is one the table reaches", () => {
    const reached = new Set(UA.map(([, , cls]) => cls));
    expect(BROWSER_CLASSES.filter((c) => !reached.has(c))).toEqual([]);
  });
});

// A fixed clock (rule 11): every counter lands on this day.
const NOW = new Date(Date.UTC(2026, 9, 10, 4, 0));
freezeClock(NOW);

describe("the counters, with nothing personal in them", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  const metric = async (key: string) => Number((await db.select().from(metricsDaily).where(and(eq(metricsDaily.day, dayKey(NOW)), eq(metricsDaily.key, key))))[0]?.value ?? 0);

  it("counts a new record by its browser, the link it came through, and a name already in the match", async () => {
    await countNewRecord(db, { ua: UA[0][1], source: "wa", name: "ana", namesHere: ["Ana", "Bo", null] });
    await countNewRecord(db, { ua: UA[4][1], source: null, name: "Cy", namesHere: ["Ana", "Bo"] });
    expect(await metric("newid_ua_ios_safari")).toBe(1);
    expect(await metric("newid_ua_ios_webview")).toBe(1);
    expect(await metric("newid_src_wa")).toBe(1);
    expect(await metric("newid_name_here")).toBe(1);
    // The keys carry a class, a tag and a fixed word: never a name.
    const keys = (await db.select().from(metricsDaily)).map((r) => r.key);
    expect(keys.filter((k) => /ana|cy/i.test(k))).toEqual([]);
  });

  it("counts each way a browser signs in", async () => {
    for (const way of ["thats_me", "restore", "personal_link", "email_code", "telegram"] as const) await countSignIn(db, way);
    await countSignIn(db, "thats_me");
    expect(await metric("signin_thats_me")).toBe(2);
    expect(await metric("signin_restore")).toBe(1);
    expect(await metric("signin_personal_link")).toBe(1);
    expect(await metric("signin_email_code")).toBe(1);
    expect(await metric("signin_telegram")).toBe(1);
  });
});
