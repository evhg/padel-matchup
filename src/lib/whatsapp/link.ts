import type { Player } from "@/db/schema";
import { shortHost } from "@/lib/config";
import { isValidShareCode } from "@/lib/codes";
import { mintTicket, readTicket, uuidSubject } from "@/lib/ticket";
import { whatsappAppSecret, whatsappLinkable, whatsappNumber } from "./api";

/**
 * The hand-off. A bot cannot be in the crew's group, so a person carries the message across instead:
 * the organiser pastes this link into the chat they already have, and each tap opens a thread with
 * our number and `JOIN-7KQ2` already typed — sent only when the player presses send themselves. The
 * send takes the seat (`handleWhatsappMessage`): two taps, the link and Send. The player still leaves
 * the group for a chat with us, and the group sees nothing of it; no link can keep a player inside a
 * group, because Meta sells no bot that sits in one.
 *
 * That is what makes it their message rather than ours, and it is worth three things: the 24-hour
 * window opens without a template, the daily limit is not spent (it counts unique numbers messaged
 * *outside* an open window), and their number arrives with consent attached. The replies are not
 * free: from 1 October 2026 Meta charges each message we send inside the window at the utility rate
 * of the player's country, with no volume tiers (Meta's pricing page for non-template messages, read
 * 10 October 2026); one reseller (360dialog) reports the first 1,000 a month per number free, which
 * Meta's own pages do not say. A message the player sends us costs nothing. docs/OPERATING.md.
 *
 * Offered only where a reply can come back (`whatsappLinkable`): a number with no send token behind
 * it would open a chat that nobody answers.
 *
 * Click-to-chat is a documented Meta product, not a workaround. Nothing here bends a rule; it just
 * declines to use the one API that is closed.
 */
export const JOIN_PREFIX = "JOIN-";

export function joinLink(code: string): string | null {
  const number = whatsappNumber();
  return number && whatsappLinkable() ? `https://wa.me/${number}?text=${encodeURIComponent(`${JOIN_PREFIX}${code}`)}` : null;
}

/**
 * The match code of a JOIN message, or null when the text is something else: the link's own
 * `JOIN-7KQ2`, and what a person types by hand, `JOIN 7KQ2`, `join7KQ2`, "please join 7KQ2". The whole
 * message has to be that and nothing more, because a JOIN takes a seat at once: in "Can I join this?"
 * or "join next week", "this" and "next" are valid codes, and a reader that looked anywhere in a line
 * would put the player in a stranger's match.
 *
 * The code is returned exactly as it was typed. `CODE_ALPHABET` is mixed case, so "7kq2" and "7KQ2"
 * are two different matches; normalising the case here would look tidy and would find the wrong
 * match, or none. Only the JOIN word is matched case-insensitively, because that part is ours.
 */
export function codeInJoinText(text: string): string | null {
  const m = /^\s*(?:please\s+)?join[-\s]?([A-Za-z0-9]{4})\s*[.!]?\s*$/i.exec(text);
  return m && isValidShareCode(m[1]) ? m[1] : null;
}

/**
 * The match code in a match link pasted into the thread ("https://kicksma.sh/7KQ2?s=wa", or the
 * "kicksma.sh/7KQ2" the page prints), on this deployment's own address only. A link elsewhere, or a
 * path that is not a match, is not a code.
 */
export function codeInMatchUrl(text: string, host = shortHost()): string | null {
  const bare = host.replace(/^www\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:https?://)?(?:www\\.)?${bare}/([A-Za-z0-9]{4})(?=$|[/?#\\s.,!)])`, "i").exec(text);
  return m && isValidShareCode(m[1]) ? m[1] : null;
}

/**
 * The other hand-off: a player who joined on the web links this thread to themselves. The match
 * page's "stay updated" card opens WhatsApp with `LINK-7KQ2-<ticket>` typed, and the player presses
 * send. The ticket is the one Telegram's `p_` link carries (src/lib/ticket.ts): the player's id,
 * today's date and a signature, here made with Meta's app secret and salted with the number the
 * player holds now, so a code dies the moment a number is linked and after two days in any case.
 * Unlike JOIN- it takes no seat: the player already has one, and the reply is the match and their
 * calendar. The code only names which match to answer with; the ticket alone decides who is linked.
 */
export const LINK_PREFIX = "LINK-";
const bindSalt = (player: Pick<Player, "phone">) => `wa:${player.phone ?? ""}`;

export function bindLink(player: Pick<Player, "id" | "phone">, code: string, now = new Date()): string | null {
  const number = whatsappNumber();
  const secret = whatsappAppSecret();
  if (!whatsappLinkable() || !number || !secret) return null;
  const ticket = mintTicket(secret, uuidSubject(player.id), { salt: bindSalt(player), now });
  return `https://wa.me/${number}?text=${encodeURIComponent(`${LINK_PREFIX}${code}-${ticket}`)}`;
}

/** The ticket and the match code inside a LINK- message, or null. As with JOIN-, only the prefix is ours to match in any case. */
export function bindInText(text: string): { ticket: string; code: string | null } | null {
  const m = new RegExp(`${LINK_PREFIX}(?:([A-Za-z0-9]{4})-)?([0-9a-f]{32}_[0-9a-z]{1,8}_[0-9a-f]{16})\\b`, "i").exec(text.trim());
  return m ? { ticket: m[2], code: m[1] ?? null } : null;
}

/** True when the ticket was signed here, today or yesterday, for this player while they held the number they hold now. */
export function verifyBindTicket(ticket: string, player: Pick<Player, "id" | "phone">, now = new Date()): boolean {
  const secret = whatsappAppSecret();
  return Boolean(secret) && readTicket(secret!, ticket, { salt: bindSalt(player), now }) === uuidSubject(player.id);
}
