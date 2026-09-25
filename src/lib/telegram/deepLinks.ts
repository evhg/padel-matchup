import type { Player } from "@/db/schema";
import { playerTicket } from "@/lib/coach/link";
import { botDeepLink } from "./api";

/**
 * The t.me links that open the bot on the right door, each one tap for the person who gets it.
 * They are made here, away from the bot's handlers, so a page or an email can mint one without
 * loading the bot. Every one is null until the bot has a username (TELEGRAM_BOT_USERNAME).
 */

/** A coach's student invite: the student lands on the coach's list with the buttons under the text field. */
export const studentDeepLink = (inviteCode: string) => botDeepLink(`s_${inviteCode}`);
/** A tournament partner's claim: the partner confirms the spot in the chat, and the reminders follow. */
export const claimDeepLink = (token: string) => botDeepLink(`claim_${token}`);
/**
 * The email's "get this on Telegram" line, and the match page's "stay updated" choice: the ticket names
 * the player, the tap binds this Telegram account to them. From a match page the match's code rides at
 * the end (`p_<ticket>_<code>`, sixty characters of the sixty-four a start parameter may carry), so the
 * bot answers with that match's card. The code is not signed and needs no signature: the ticket alone
 * decides who is bound, and any card can already be opened with `?start=<code>`.
 */
export const bindDeepLink = (player: Pick<Player, "id" | "telegramId">, code?: string | null) => botDeepLink(`p_${playerTicket(player)}${code ? `_${code}` : ""}`);

/** What follows `p_` in a start parameter: the ticket, and the match code when the link came from a match page. */
export function readBindPayload(rest: string): { ticket: string; code: string | null } {
  // A ticket ends in sixteen hex digits, so a trailing `_` and four more characters can only be a code.
  const m = /^(.+_[0-9a-f]{16})_([A-Za-z0-9]{4})$/.exec(rest);
  return m ? { ticket: m[1], code: m[2] } : { ticket: rest, code: null };
}
