import { cleanUrl, madeToShare } from "@/lib/booking/platforms";

/** What a paste may carry: a chat's worth. */
export const PASTE_TEXT_MAX = 4000;
/** Links read from one paste. */
export const PASTE_LINKS_MAX = 5;

export const LINK_RE = /https?:\/\/[^\s<>"'«»“”]+/giu;

/** The http(s) links in a paste, then `extra` (a Telegram message's link entities), cleaned, the first spelling of each, five at most. */
export function linksIn(text: string, extra: readonly string[] = []): string[] {
  const found = [...((text ?? "").slice(0, PASTE_TEXT_MAX).match(LINK_RE) ?? []), ...extra.slice(0, 20)];
  const out: string[] = [];
  for (const raw of found) {
    if (typeof raw !== "string") continue;
    const clean = cleanUrl(raw.replace(/[.,;:!?)\]}>»"'”]+$/u, ""));
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= PASTE_LINKS_MAX) break;
  }
  return out;
}

/** What the "Court booking link" field holds: no link (`url: null`), a link, or a text with no link in it (`ok: false`). */
export type BookingField = { ok: true; url: string | null } | { ok: false };

/**
 * What a match keeps from its "Court booking link" field, on the create form and the edit form (the
 * owner's report of 9 November 2026: a pasted share message became no link, and the form said nothing).
 * An empty field is no link. One word is a link as before: http(s) only, and a bare host
 * (`krosspadel.com/book`) gets https, if its host has a dot. A text of several words is a paste:
 * its first made-to-share link (`madeToShare`, the choice the booking paste makes), else its first link
 * (`linksIn`). A text with no link is `ok: false`, which every door refuses, so a text is never
 * dropped in silence. Pure, and safe in a browser.
 */
export function bookingLinkOf(raw: unknown): BookingField {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { ok: true, url: null };
  if (!/\s/.test(s)) {
    const url = cleanUrl(s);
    return url && (s.includes("://") || new URL(url).hostname.includes(".")) ? { ok: true, url } : { ok: false };
  }
  const links = linksIn(s);
  const url = links.map((l) => madeToShare(l)?.url).find(Boolean) ?? links[0];
  return url ? { ok: true, url } : { ok: false };
}
