import { isEuropeanZone, SIGNALS_COOKIE, SIGNALS_COOKIE_MAX_AGE, SIGNALS_COOKIE_PATH, type HintPlatform, type SignalsWire } from "@/lib/domain/hintSignals";

/**
 * What a browser tells every site, read in the browser for a device hint (design B, the owner's decision
 * of 28 October 2026; the rules are in src/lib/domain/hintSignals.ts). Our own few lines, no library, read
 * at two moments only: when a person acts (a join, a sign-in, "Sign out on this browser"), and the values
 * go with that act's own request; and once per match in a tab for the question "Welcome back, Tim?"
 * (`WelcomeBack`), only on a page whose server found a remembered phone among the records it shows. A plain view reads nothing. A
 * browser set to a European zone reads nothing more and sends nothing. No canvas, WebGL,
 * audio or font read, no IP address, no system version and no dark mode. Null on the server, in Europe,
 * or when anything throws.
 */
export function readDeviceSignals(): SignalsWire | null {
  try {
    if (typeof window === "undefined" || typeof navigator === "undefined") return null;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz || isEuropeanZone(tz)) return null;
    const ua = navigator.userAgent;
    const touch = navigator.maxTouchPoints || 0;
    const platform: HintPlatform = /iPhone|iPod/.test(ua) ? "iphone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1) ? "ipad" : /Android/.test(ua) ? "android" : "other";
    let text: number | "na" = "na";
    // The phone's own text size (Dynamic Type), where the browser knows the font; else "na".
    if (typeof CSS !== "undefined" && CSS.supports?.("font", "-apple-system-body")) {
      const probe = document.createElement("span");
      probe.style.font = "-apple-system-body";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      document.body.appendChild(probe);
      const size = parseFloat(getComputedStyle(probe).fontSize);
      probe.remove();
      if (Number.isFinite(size)) text = size;
    }
    const langs = (navigator.languages?.length ? navigator.languages : [navigator.language]).slice(0, 10).map((l) => l.toLowerCase());
    return {
      w: screen.width,
      h: screen.height,
      dpr: Math.round((window.devicePixelRatio || 1) * 4) / 4,
      langs,
      tz,
      platform,
      touch,
      text,
      motion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
    };
  } catch {
    return null;
  }
}

/** The tab's own note that it asked about one match: one question per match in a tab, never one per view. */
export const HINT_ASKED_KEY = "km_hint_asked:";

/**
 * The values for the question "Welcome back, Tim?" (`WelcomeBack`), once per match in a tab, or null. The
 * zone comes first: in a European zone, on the server, or when anything throws, nothing is written to the
 * tab's storage and nothing is sent, because EU and UK law asks consent for any storage on the device,
 * personal data or not. Only then the tab's note (`sessionStorage`, which goes with the tab), and then the
 * values. A tab with no storage asks nothing, rather than once per view.
 */
export function hintAskOnce(code: string): SignalsWire | null {
  try {
    if (typeof window === "undefined") return null;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz || isEuropeanZone(tz)) return null;
    const note = HINT_ASKED_KEY + code;
    if (window.sessionStorage.getItem(note)) return null;
    window.sessionStorage.setItem(note, "1");
  } catch {
    return null;
  }
  return readDeviceSignals();
}

/**
 * For the one door that is a plain navigation, the Telegram return: the values ride in a cookie bound to
 * the login route for one minute, which the route reads and deletes (`SIGNALS_COOKIE`, named on /privacy).
 * Nothing is written in Europe.
 */
export function writeSignalsCookie(): void {
  const values = readDeviceSignals();
  if (!values) return;
  const secure = window.location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${SIGNALS_COOKIE}=${encodeURIComponent(JSON.stringify(values))}; path=${SIGNALS_COOKIE_PATH}; max-age=${SIGNALS_COOKIE_MAX_AGE}; samesite=lax${secure}`;
}
