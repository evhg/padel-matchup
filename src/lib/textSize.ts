/**
 * "Bigger text": one switch that lifts every size in the app a step (16px to 18px at the root, the
 * chips to 13.5px). Every size is in rem, so the root is the only number that has to move.
 *
 * It lives in a cookie, not on the player's row: it belongs to the phone in someone's hand, it needs
 * no account, and reading it costs the root layout no query. The layout reads it on the server and
 * sets `data-text` on <html>, so the first paint is already the right size and nothing jumps.
 */
export const TEXT_SIZE_COOKIE = "km_text";

export type TextSize = "big" | "normal";

/** What a cookie value means. Anything but the one word we write is the normal size. */
export function textSizeOf(value: string | null | undefined): TextSize {
  return value === "big" ? "big" : "normal";
}

/** The `data-text` value for <html>, or nothing at the normal size so the markup is unchanged. */
export function htmlTextAttr(size: TextSize): "big" | undefined {
  return size === "big" ? "big" : undefined;
}

/**
 * The cookie the switch writes from the browser: a year, the whole site, never sent from another
 * site. Turning it off deletes it, so the normal size is the absence of a cookie.
 */
export function textSizeCookie(size: TextSize): string {
  return size === "big" ? `${TEXT_SIZE_COOKIE}=big; path=/; max-age=31536000; samesite=lax` : `${TEXT_SIZE_COOKIE}=; path=/; max-age=0; samesite=lax`;
}
