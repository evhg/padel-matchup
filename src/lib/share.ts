import { taggedUrl } from "./source";

/** Messenger deep links. The app never sends messages itself (decision 5). */

export function whatsappShareUrl(text: string, phone?: string | null): string {
  const digits = (phone ?? "").replace(/[^\d]/g, "");
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/**
 * The text a share button carries, with its match link tagged: `?s=wa` for WhatsApp, `?s=tg` for the
 * Telegram share, and the copied link `?s=link` (`tagMatchUrl`).
 *
 * The match page reads the tag into the source cookie (`ks_src`, src/lib/source.ts), so a join and a
 * new record that start from a tap in a WhatsApp group count as such (`join_src_wa`, `newid_src_wa`):
 * nobody could tell before whether a player who typed their name again had come from a group at all.
 * Only a bare match link is tagged, wherever it stands in the text and only where nothing follows it
 * that makes it a longer link: an invitation (`/7KQ2/i/…`) carries a personal code, a coach's page
 * counts its own doors, and a link that already says where it came from keeps saying it.
 */
const MATCH_LINK = /^https?:\/\/[^/?#\s]+\/[A-Za-z0-9]{4}$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function tagMatchLinks(text: string, url: string, tag: string): string {
  if (!MATCH_LINK.test(url)) return text;
  return text.replace(new RegExp(`${escapeRe(url)}(?![\\w/?#])`, "g"), taggedUrl(url, tag));
}

export const tagForWhatsapp = (text: string, url: string) => tagMatchLinks(text, url, "wa");

/** The link itself, tagged when it is a bare match link (the Telegram share's `url`, the copied link); any other link as it is. */
export const tagMatchUrl = (url: string, tag: string) => (MATCH_LINK.test(url) ? taggedUrl(url, tag) : url);

/**
 * What a Copy button puts on the clipboard: the link alone (`?s=link` on a bare match link), or the
 * whole message with its match link tagged the same way. "Send all invites in one message" copied the
 * match link alone until 6 November 2026, while its text held every personal link (the owner: "I also
 * fix the Copy bug"). A personal link (`/7KQ2/i/…`) in the text stays as it is.
 */
export const copiedValue = (url: string, text: string, what: "link" | "message"): string => (what === "message" ? tagMatchLinks(text, url, "link") : tagMatchUrl(url, "link"));

/**
 * The text without the link the share already carries as its own: the link itself only, never a longer
 * link that starts with it (a personal link `/7KQ2/i/…` in "Send all invites in one message" starts with
 * the match link), so the same bound as `tagMatchLinks`.
 */
export const withoutLink = (text: string, url: string): string =>
  text
    .replace(new RegExp(`${escapeRe(url)}(?![\\w/?#])`, "g"), "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

/**
 * What the phone's own share sheet gets: the link tagged `?s=share`, and the text without it. With a
 * picture the sheet takes text only, so `textWithLink` carries the tagged link.
 */
export function nativeShareData(url: string, text: string): { url: string; text: string; textWithLink: string } {
  const tagged = tagMatchUrl(url, "share");
  const plain = withoutLink(text, url);
  return { url: tagged, text: plain, textWithLink: `${plain} ${tagged}`.trim() };
}

export function telegramShareUrl(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

/**
 * The Telegram share button's address: the link tagged `?s=tg` as the share's own `url`, and the text
 * without it, as the phone's share sheet gets it (`nativeShareData`). Telegram shows the `url` beside the
 * text, so a text that kept the link put it in the message twice (review, 9 November 2026).
 */
export const telegramShareFor = (url: string, text: string): string => telegramShareUrl(tagMatchUrl(url, "tg"), withoutLink(text, url));

/**
 * Which share text a match's link goes with: on a full match with a waiting list it says so ("Full, but
 * the waitlist is open"), elsewhere the spots left. The match page and the share page ask this one rule;
 * the share page said "No spots left. Tap to join" on a full match until 9 November 2026.
 */
export const shareTextKey = (spotsLeft: number, whenFull: "waitlist" | "closed"): "shareText.eventFull" | "shareText.event" =>
  spotsLeft === 0 && whenFull === "waitlist" ? "shareText.eventFull" : "shareText.event";

export const eventUrl = (base: string, code: string) => `${base}/${code}`;
export const inviteUrl = (base: string, code: string, inviteCode: string) => `${base}/${code}/i/${inviteCode}`;
export const manageUrl = (base: string, code: string, manageCode: string) => `${base}/${code}/manage/${manageCode}`;
