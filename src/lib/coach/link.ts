import { createHash, createHmac } from "node:crypto";
import { telegramWebhookSecret } from "@/lib/telegram/api";

/**
 * The ticket in the "open your assistant in Telegram" link: proves the tap came
 * from the coach's own signed-in browser, so the bot can bind that Telegram
 * account to the coach's player. Two-day window, same secret as chat tickets.
 */
const DAY_MS = 86_400_000;
const secret = () => telegramWebhookSecret() ?? createHash("sha256").update(process.env.TELEGRAM_BOT_TOKEN ?? "").digest("hex");
const sig = (playerId: string, bucket: number) => createHmac("sha256", secret()).update(`p.${playerId}.${bucket}`).digest("hex").slice(0, 20);

export function playerTicket(playerId: string, now = new Date()): string {
  const bucket = Math.floor(now.getTime() / DAY_MS);
  return `${playerId}.${bucket}.${sig(playerId, bucket)}`;
}

/** The player id behind a ticket issued today or yesterday, or null. */
export function verifyPlayerTicket(ticket: string | null | undefined, now = new Date()): string | null {
  if (!ticket) return null;
  const m = /^([0-9a-f-]{36})\.(\d+)\.([0-9a-f]{20})$/i.exec(ticket);
  if (!m) return null;
  const [, playerId, b, given] = m;
  const bucket = Number(b);
  const current = Math.floor(now.getTime() / DAY_MS);
  if (bucket !== current && bucket !== current - 1) return null;
  return given === sig(playerId, bucket) ? playerId : null;
}
