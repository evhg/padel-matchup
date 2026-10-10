import type { Player } from "@/db/schema";
import { botTicketSecret, playerTicket } from "@/lib/coach/link";
import { hexUuid, mintTicket, readTicket, ticketSubject, uuidSubject } from "@/lib/ticket";
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
 * A crew's own Telegram group (DECIDING rule 30). The bot cannot make a group; this link lets a crew's
 * admin pick one, or make one, and add the bot to it as an admin in one step, with the rights below
 * already ticked. Telegram then sends `/start crew_<ticket>` into that group, and the ticket ties it to
 * the crew.
 *
 * The rights are the fewest the bot needs, one job each: `pin_messages` pins the notice (without a
 * pinned notice the bot does not read anything), `invite_users` makes the link the crew page hands to
 * members. Being an admin at all is what lets a bot with privacy mode on read the group's messages,
 * which is the consent: in a group where it is a plain member it sees commands and replies to its own
 * messages only. It never deletes, bans, restricts or promotes anybody, and never touches the group's
 * name, photo or description, so it asks for none of those.
 */
export const CREW_ADMIN_RIGHTS = ["invite_users", "pin_messages"] as const;

/**
 * The salt binds a crew ticket to the crew admin it was minted for: it verifies only while that person
 * is still an admin of the crew, and it can never read as a player ticket made from the same 32 digits.
 */
const crewSalt = (adminPlayerId: string) => `crew:${adminPlayerId}`;

/** `crew_` plus a day ticket naming the crew's id, signed for one of its admins: 58 characters of the 64 a start parameter may carry. */
export const crewStartPayload = (groupId: string, adminPlayerId: string, now = new Date()) => `crew_${mintTicket(botTicketSecret(), uuidSubject(groupId), { salt: crewSalt(adminPlayerId), now })}`;

/** The crew a `crew_…` payload names, before it is checked (the check needs the crew's admins). */
export function crewPayloadGroup(payload: string): string | null {
  const m = /^crew_(.+)$/.exec(payload.trim());
  return m ? hexUuid(ticketSubject(m[1])) : null;
}

/** True when the payload was minted today or yesterday by this deployment for this crew admin: a forged, stale or foreign one binds nothing. */
export function verifyCrewPayload(payload: string, adminPlayerId: string, now = new Date()): boolean {
  const m = /^crew_(.+)$/.exec(payload.trim());
  const groupId = m ? hexUuid(readTicket(botTicketSecret(), m[1], { salt: crewSalt(adminPlayerId), now })) : null;
  return Boolean(groupId) && groupId === crewPayloadGroup(payload);
}

/** The crew page's "Run a Telegram group for this crew", for one of its admins: null until the bot has a username. */
export function crewGroupLink(groupId: string, adminPlayerId: string, now = new Date()): string | null {
  const bot = telegramBotUsername();
  return bot ? `https://t.me/${bot}?startgroup=${crewStartPayload(groupId, adminPlayerId, now)}&admin=${CREW_ADMIN_RIGHTS.join("+")}` : null;
}
