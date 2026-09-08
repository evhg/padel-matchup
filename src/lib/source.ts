/**
 * Where a visitor came from, when a link says so: kicksma.sh/CODE?s=ig on a
 * coach's Instagram story, ?s=poster on a printed poster. Kept in a short-lived
 * cookie so the join that follows can be counted per source. Nothing personal.
 */
export const SOURCE_COOKIE = "ks_src";
export const SOURCE_MAX_AGE = 24 * 60 * 60;

/** Short lowercase tokens only: ig, poster, coach, tg… Anything else is ignored. */
export function cleanSource(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().toLowerCase();
  return /^[a-z0-9_-]{1,16}$/.test(s) ? s : null;
}

/** The link an organiser pastes into an Instagram link sticker. */
export const taggedUrl = (url: string, source: string) => `${url}${url.includes("?") ? "&" : "?"}s=${source}`;
