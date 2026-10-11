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

export function telegramShareUrl(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

export const eventUrl = (base: string, code: string) => `${base}/${code}`;
export const inviteUrl = (base: string, code: string, inviteCode: string) => `${base}/${code}/i/${inviteCode}`;
export const manageUrl = (base: string, code: string, manageCode: string) => `${base}/${code}/manage/${manageCode}`;
