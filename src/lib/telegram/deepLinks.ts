import type { Player } from "@/db/schema";
import { botTicketSecret, playerTicket } from "@/lib/coach/link";
import { hexUuid, mintTicket, readTicket, uuidSubject } from "@/lib/ticket";
import { botDeepLink, telegramBotUsername } from "./api";

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

/**
 * A crew's own Telegram group (DECIDING rule 30). The bot cannot make a group; this link lets a person
 * pick one, or make one, and add the bot to it as an admin in one step, with the rights below already
 * ticked. Telegram then sends `/start crew_<ticket>` into that group, and the ticket ties it to the crew.
 *
 * The rights are the fewest the bot needs, one job each: `pin_messages` pins the notice (without a
 * pinned notice the bot does not read anything), `change_info` puts the same notice in the group's
 * description, `invite_users` makes the link the crew page hands to members. Being an admin at all is
 * what lets a bot with privacy mode on read the group's messages, which is the consent: in a group
 * where it is a plain member it sees commands and replies to its own messages only. It never deletes,
 * bans, restricts or promotes anybody, so it asks for none of those.
 */
export const CREW_ADMIN_RIGHTS = ["change_info", "invite_users", "pin_messages"] as const;

/** The salt that keeps a crew ticket from ever reading as a player ticket made from the same 32 digits. */
const CREW_SALT = "crew";

/** `crew_` plus a day ticket naming the crew's id: 58 characters of the 64 a start parameter may carry. */
export const crewStartPayload = (groupId: string, now = new Date()) => `crew_${mintTicket(botTicketSecret(), uuidSubject(groupId), { salt: CREW_SALT, now })}`;

/** The crew behind a `crew_…` payload minted today or yesterday by this deployment, or null: a forged or stale one binds nothing. */
export function readCrewPayload(payload: string, now = new Date()): string | null {
  const m = /^crew_(.+)$/.exec(payload.trim());
  return m ? hexUuid(readTicket(botTicketSecret(), m[1], { salt: CREW_SALT, now })) : null;
}

/** The crew page's "Run a Telegram group for this crew": null until the bot has a username. */
export function crewGroupLink(groupId: string, now = new Date()): string | null {
  const bot = telegramBotUsername();
  return bot ? `https://t.me/${bot}?startgroup=${crewStartPayload(groupId, now)}&admin=${CREW_ADMIN_RIGHTS.join("+")}` : null;
}
