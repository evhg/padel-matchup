import { whatsappNumber } from "./api";

/**
 * The hand-off. A bot cannot be in the crew's group, so a person carries the message across instead:
 * the organiser pastes this link into the chat they already have, and each tap opens a thread with
 * our number and `JOIN-7KQ2` already typed — sent only when the player presses send themselves.
 *
 * That is what makes it their message rather than ours, and it is worth three things at once: the
 * next 24 hours of replies are free and need no template, the daily limit is not spent (it counts
 * unique numbers messaged *outside* an open window), and their number arrives with consent attached.
 *
 * Click-to-chat is a documented Meta product, not a workaround. Nothing here bends a rule; it just
 * declines to use the one API that is closed.
 */
export const JOIN_PREFIX = "JOIN-";

export function joinLink(code: string): string | null {
  const number = whatsappNumber();
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(`${JOIN_PREFIX}${code}`)}` : null;
}

/**
 * The match code inside an opening message, or null when the text is something else entirely.
 *
 * The code is returned exactly as it was typed. `CODE_ALPHABET` is mixed case, so "7kq2" and "7KQ2"
 * are two different matches; normalising the case here would look tidy and would find the wrong
 * match, or none. Only the JOIN- prefix is matched case-insensitively, because that part is ours.
 */
export function codeInJoinText(text: string): string | null {
  const m = new RegExp(`${JOIN_PREFIX}([A-Za-z0-9]{4})\\b`, "i").exec(text.trim());
  return m ? m[1] : null;
}
