import { createHash } from "node:crypto";
import type { Player } from "@/db/schema";
import { telegramWebhookSecret } from "@/lib/telegram/api";
import { mintTicket, readTicket, ticketSubject } from "@/lib/ticket";

/**
 * The ticket in the "open your assistant in Telegram" link: proves the tap came
 * from the coach's own signed-in browser, so the bot can bind that Telegram
 * account to the coach's player. Two-day window, same secret as chat tickets,
 * and salted with the player's current Telegram binding, so the moment an
 * account is bound every ticket minted before it is dead. With its `coach_`
 * prefix the whole start parameter is sixty characters of [A-Za-z0-9_], which
 * is what Telegram accepts (sixty-four at most).
 */
const secret = () => telegramWebhookSecret() ?? createHash("sha256").update(process.env.TELEGRAM_BOT_TOKEN ?? "").digest("hex");
const salt = (player: Pick<Player, "telegramId">) => `tg:${player.telegramId ?? ""}`;
const subjectOf = (playerId: string) => playerId.replace(/-/g, "").toLowerCase();

export function playerTicket(player: Pick<Player, "id" | "telegramId">, now = new Date()): string {
  return mintTicket(secret(), subjectOf(player.id), { salt: salt(player), now });
}

/** The player id a ticket names, before it is checked; the check needs that player's current binding. */
export function ticketPlayerId(ticket: string | null | undefined): string | null {
  const s = ticketSubject(ticket);
  if (!s || !/^[0-9a-f]{32}$/.test(s)) return null;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** True when the ticket was minted for this player, today or yesterday, while their Telegram binding was what it is now. */
export function verifyPlayerTicket(ticket: string | null | undefined, player: Pick<Player, "id" | "telegramId">, now = new Date()): boolean {
  return readTicket(secret(), ticket, { salt: salt(player), now }) === subjectOf(player.id);
}
