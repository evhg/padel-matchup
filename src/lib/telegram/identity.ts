import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { players, type Player } from "@/db/schema";
import { mergePlayers } from "@/lib/domain/merge";
import { createPlayer } from "@/lib/domain/players";
import { telegramWebhookSecret, type TgUser } from "./api";
import { botLocale } from "./card";

/**
 * Who is talking: the player behind a Telegram account, created on first contact, and the chat
 * tickets that prove a create link came from a chat the bot is in, so a stranger cannot make the
 * bot post into someone's group.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

const ticketSecret = () => telegramWebhookSecret() ?? createHash("sha256").update(process.env.TELEGRAM_BOT_TOKEN ?? "").digest("hex");
const ticketSig = (chatId: number, bucket: number) => createHmac("sha256", ticketSecret()).update(`${chatId}.${bucket}`).digest("hex").slice(0, 20);

export function chatTicket(chatId: number, now = new Date()): string {
  const bucket = Math.floor(now.getTime() / DAY_MS);
  return `${chatId}.${bucket}.${ticketSig(chatId, bucket)}`;
}

/** The chat id behind a ticket issued in the last two days, or null. */
export function verifyChatTicket(ticket: string | null | undefined, now = new Date()): number | null {
  if (!ticket) return null;
  const [id, b, sig] = ticket.split(".");
  const chatId = Number(id);
  const bucket = Number(b);
  if (!Number.isInteger(chatId) || !Number.isInteger(bucket) || !sig) return null;
  const current = Math.floor(now.getTime() / DAY_MS);
  if (bucket !== current && bucket !== current - 1) return null;
  const want = ticketSig(chatId, bucket);
  if (want.length !== sig.length) return null;
  return timingSafeEqual(Buffer.from(want), Buffer.from(sig)) ? chatId : null;
}

export async function findTelegramPlayer(db: Db, telegramId: number): Promise<Player | null> {
  const [p] = await db.select().from(players).where(eq(players.telegramId, telegramId)).limit(1);
  return p ?? null;
}

/** The player behind a Telegram account, created on first contact with just the first name. */
export async function findOrCreateTelegramPlayer(db: Db, user: TgUser): Promise<Player> {
  const existing = await findTelegramPlayer(db, user.id);
  if (existing) {
    if ((user.username ?? null) !== existing.telegramUsername) {
      const [p] = await db.update(players).set({ telegramUsername: user.username ?? null }).where(eq(players.id, existing.id)).returning();
      return p;
    }
    return existing;
  }
  const created = await createPlayer(db, { displayName: user.first_name, locale: botLocale(user.language_code) });
  const [p] = await db.update(players).set({ telegramId: user.id, telegramUsername: user.username ?? null }).where(eq(players.id, created.id)).returning();
  return p;
}

/** Links a Telegram account to a signed-in player; a player the bot created earlier for that account merges in. */
export async function linkTelegram(db: Db, playerId: string, user: TgUser): Promise<Player> {
  const other = await findTelegramPlayer(db, user.id);
  if (other && other.id !== playerId) {
    await db.update(players).set({ telegramId: null, telegramUsername: null }).where(eq(players.id, other.id));
    await mergePlayers(db, playerId, [other.id]);
  }
  const [p] = await db.update(players).set({ telegramId: user.id, telegramUsername: user.username ?? null }).where(eq(players.id, playerId)).returning();
  return p;
}
