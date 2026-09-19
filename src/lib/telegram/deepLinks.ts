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
/** The email's "get this on Telegram" line: the ticket names the player, the tap binds this Telegram account to them. */
export const bindDeepLink = (player: Pick<Player, "id" | "telegramId">) => botDeepLink(`p_${playerTicket(player)}`);
