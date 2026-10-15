/**
 * Where a visitor came from, when a link says so: kicksma.sh/CODE?s=ig on a
 * coach's Instagram story, ?s=poster on a printed poster. Kept in a short-lived
 * cookie so the join that follows can be counted per source. Nothing personal.
 */
export const SOURCE_COOKIE = "ks_src";
/** The coach doors keep their own cookie, so a match link's tag and a coach door's tag never count each other's sign-ups. */
export const COACH_SOURCE_COOKIE = "ks_csrc";
export const SOURCE_MAX_AGE = 24 * 60 * 60;
/** The doors a coach can come through, as their links tag them; the digest names these when none was used. */
export const COACH_DOORS = ["landing", "coachpage", "club", "citylist", "invite", "wrap"] as const;

/** Short lowercase tokens only: ig, poster, coach, tg… Anything else is ignored; a repeated parameter counts its first value. */
export function cleanSource(v: string | string[] | null | undefined): string | null {
  const s = ((Array.isArray(v) ? v[0] : v) ?? "").trim().toLowerCase();
  return /^[a-z0-9_-]{1,16}$/.test(s) ? s : null;
}

/**
 * The tags the app itself puts on a link to a match: WhatsApp's share (`wa`), an Instagram story
 * (`ig`), the printed poster, the result card, a moment, the series page, the americano generator, the
 * Telegram share (`tg`), the story picture, the copied link (`link`) and the phone's own share sheet
 * (`share`).
 */
export const MATCH_SOURCES = ["wa", "ig", "poster", "card", "moment", "series", "gen", "tg", "story", "link", "share"] as const;

/**
 * The tag as a counter may carry it (`join_src_<tag>`, `newid_src_<tag>`): one the app writes, else
 * `other`. Anybody can type `?s=` on a link, so a counter never carries a word somebody chose, a name
 * among them, and a new word never makes a new row of counters.
 */
export function countedSource(v: string | string[] | null | undefined): string | null {
  const s = cleanSource(v);
  if (!s) return null;
  return (MATCH_SOURCES as readonly string[]).includes(s) ? s : "other";
}

/**
 * A link preview, a crawler or a monitor: not a person, so no page view of theirs is counted. WhatsApp
 * builds its preview on the sender's own phone, as `WhatsApp/2.x.y A` (or `i`), with no cookie; its
 * in-app browser starts with `Mozilla/5.0` and is a person.
 */
export const isCrawler = (ua: string) => /bot|crawl|spider|slurp|facebookexternalhit|preview|uptime|monitor|curl|python-requests|Go-http-client/i.test(ua) || /^WhatsApp\//.test(ua);

/**
 * The counter for a view of a match page, the step between a shared link and a seat: a person with no
 * seat on it, under the link's tag (`view_src_<tag>`, `view_src_none` with no tag). Read beside
 * `join_src_<tag>` and `newid_src_<tag>` (docs/OPERATING.md, "From a shared link to a seat").
 * Only a full page load, which is what a tapped link makes, is a view (`isFullPageLoad`).
 */
export function viewCounter(o: { source: string | null; seated: boolean; ua: string; fullLoad: boolean }): string | null {
  if (!o.fullLoad || o.seated || isCrawler(o.ua)) return null;
  return `view_src_${countedSource(o.source) ?? "none"}`;
}

/**
 * Every day key one view bumps: `viewCounter`'s, and `view_lone` beside it when the organiser holds the
 * only seat (`lone`). A new organiser's match that never fills has no seat to count, and no step of the
 * path above said whether anybody opened its link at all; `view_lone` does. Its cost: one more
 * counter upsert after the response, on such views only.
 */
export function viewCounters(o: { source: string | null; seated: boolean; ua: string; fullLoad: boolean; lone: boolean }): string[] {
  const key = viewCounter(o);
  if (!key) return [];
  return o.lone ? [key, "view_lone"] : [key];
}

/**
 * A full page load, from the headers a page can read. Next.js deletes the `RSC` header and the other
 * router headers before `headers()` returns them, so they cannot tell a refresh from a load. The
 * browser's own `Sec-Fetch-Dest` can: a tapped link, a typed address and a reload say `document`;
 * `router.refresh()` (the live night's AutoRefresh, every 20 seconds), a prefetch and a client
 * navigation are a `fetch()` and say `empty`. A server action that re-renders the page carries
 * `Next-Action`. A browser too old to send `Sec-Fetch-Dest` (Safari before 16.4, so iOS 15) is read by its
 * `Accept`: a page load asks for `text/html`, and the router's fetch sets no `Accept`, so it sends `*\/*`.
 * A speculative load (`Sec-Purpose: prefetch;prerender`) counts: when the person opens it, the browser
 * sends no second request, so it is the only one there is.
 */
export function isFullPageLoad(h: { get(name: string): string | null }): boolean {
  if (h.get("next-action") !== null) return false;
  const dest = h.get("sec-fetch-dest");
  return dest === "document" || (dest === null && (h.get("accept") ?? "").includes("text/html"));
}

/** The link an organiser pastes into an Instagram link sticker. */
export const taggedUrl = (url: string, source: string) => `${url}${url.includes("?") ? "&" : "?"}s=${source}`;
