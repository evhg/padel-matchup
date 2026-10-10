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
 * (`ig`), the printed poster, the result card, a moment, the series page, the americano generator, a
 * Telegram card and the story picture.
 */
export const MATCH_SOURCES = ["wa", "ig", "poster", "card", "moment", "series", "gen", "tg", "story"] as const;

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

/** The link an organiser pastes into an Instagram link sticker. */
export const taggedUrl = (url: string, source: string) => `${url}${url.includes("?") ? "&" : "?"}s=${source}`;
