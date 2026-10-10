/**
 * Which kind of browser a request came from, in one word, for the counters that find the "jar".
 *
 * A browser keeps its own cookies, and so does every app's own browser on an iPhone and the icon on
 * an iPhone's home screen. A player whose identity lives in one of them and who taps a match link
 * that opens another meets a page that has never seen them, types their name and becomes a second
 * record (the owner, 10 October 2026: "you have to basically log in each and every time you click a
 * link from within the whatsapp group"). Which pair of jars does it is a question of numbers, not of
 * reasoning, so each new record made from a name counts its browser here (`newid_ua_<class>`,
 * docs/OPERATING.md). Nothing personal is kept: the class is the whole of what the user agent gives.
 *
 * What the user agent cannot say, the class does not claim:
 *   - `ios_webview` is an iPhone page with no Safari token and no app named: the home-screen icon, or
 *     an app's own view that names no app (Telegram's on iPhone among them). The two look the same.
 *   - An iPad on iPadOS 13 or later says "Macintosh" and counts as `desktop`.
 *   - `app_whatsapp` exists to prove or refute that WhatsApp ever opens a page in a browser of its own
 *     for a link in a chat. The research of 10 October 2026 found no source that it does.
 *
 * Pure: the user agent in, the class out. Order matters: an app's token is read before the platform's
 * browser, because an app's own view still carries "Safari/" or "Chrome/" in its string.
 */

export const BROWSER_CLASSES = [
  "ios_safari",
  "ios_chrome",
  "ios_other",
  "ios_webview",
  "android_chrome",
  "android_samsung",
  "android_webview",
  "android_other",
  "app_whatsapp",
  "app_telegram",
  "app_instagram",
  "app_facebook",
  "app_line",
  "desktop",
  "other",
] as const;

export type BrowserClass = (typeof BROWSER_CLASSES)[number];

const APPS: [RegExp, BrowserClass][] = [
  [/\bWhatsApp\//i, "app_whatsapp"],
  [/Telegram/i, "app_telegram"],
  [/Instagram/, "app_instagram"],
  [/FBAN\/|FBAV\/|FB_IAB|FBIOS|FB4A|Messenger/, "app_facebook"],
  [/\bLine\//i, "app_line"],
];

export function browserClass(ua: string | null | undefined): BrowserClass {
  const s = (ua ?? "").trim();
  if (!s) return "other";
  for (const [re, cls] of APPS) if (re.test(s)) return cls;
  if (/iPhone|iPad|iPod/.test(s)) {
    if (/CriOS\//.test(s)) return "ios_chrome";
    if (/FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|GSA\//.test(s)) return "ios_other";
    // Safari names itself "Safari/604.1". A view that does not is the home-screen icon or an app's own.
    if (/Safari\//.test(s)) return "ios_safari";
    return "ios_webview";
  }
  if (/Android/.test(s)) {
    if (/SamsungBrowser\//.test(s)) return "android_samsung";
    if (/; wv\)/.test(s)) return "android_webview";
    if (/Firefox\/|OPR\/|EdgA\/|YaBrowser|UCBrowser|MiuiBrowser|HuaweiBrowser|DuckDuckGo/.test(s)) return "android_other";
    if (/Chrome\//.test(s)) return "android_chrome";
    return "android_other";
  }
  if (/Windows NT|Macintosh|X11|CrOS/.test(s)) return "desktop";
  return "other";
}
