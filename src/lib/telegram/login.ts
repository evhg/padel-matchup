/**
 * Sign in with Telegram without the Login Widget's popup. The widget opens
 * oauth.telegram.org in a popup; on phones that popup is a second tab, and
 * when the phone switches to the Telegram app and back the popup loses its
 * opener, so Telegram finishes the sign-in in that tab and the page the
 * player started from is left behind. Telegram's own fallback for a blocked
 * popup is a plain navigation with return_to: the same tab goes out, and comes
 * back to return_to with the signed fields in the hash as
 * #tgAuthResult=<base64url JSON>. That is the only path we use.
 */
export const TELEGRAM_OAUTH = "https://oauth.telegram.org/auth";

const widgetLang = (lang: string) => (lang === "ru" ? "ru" : lang === "es" ? "es" : "en");

/** Where the button sends this tab. origin must be the domain set for the bot in BotFather; return_to must be on it. */
export function telegramAuthUrl(botId: string, origin: string, returnTo: string, lang: string): string {
  const q = new URLSearchParams({ bot_id: botId, origin, request_access: "write", lang: widgetLang(lang), return_to: returnTo });
  return `${TELEGRAM_OAUTH}?${q}`;
}

/** The signed fields Telegram put in the hash on the way back, as strings, or null when there are none. */
export function readAuthResult(hash: string): Record<string, string> | null {
  const m = /[#?&]tgAuthResult=([A-Za-z0-9\-_=]*)$/.exec(hash);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "string" || typeof v === "number") out[k] = String(v);
    return out.id && out.hash && out.auth_date ? out : null;
  } catch {
    return null;
  }
}

/** The page without its hash (and without a stale ?telegram= note): what Telegram should come back to. */
export function returnToFor(loc: { origin: string; pathname: string }): string {
  return `${loc.origin}${loc.pathname}`;
}
