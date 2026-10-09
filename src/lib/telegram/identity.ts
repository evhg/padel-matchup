import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { players, type Player } from "@/db/schema";
import { mergePlayers, recordToKeep, recordWeights } from "@/lib/domain/merge";
import { foldSameNameRows } from "@/lib/domain/sameName";
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

/**
 * Links a Telegram account to a signed-in player, and returns the player this browser or chat is now
 * signed in as. Every caller must use the returned player, never the id it passed in: that row can
 * be gone.
 *
 * When another record already holds the account, the two are one person and become one record. The
 * one with more history survives (`recordToKeep`: seats, matches created, scores entered; on a tie
 * the older record), and the other merges into it. The owner decided this on 9 October 2026
 * (decision 2A). Until then the signed-in record always survived, which was right for a record the
 * bot made empty on first contact, and wrong the other way round: a WhatsApp link opens in a browser
 * with no cookie, the person taps Join (a new, nearly empty record), then signs in with Telegram
 * there. The real record, with the matches, the personal link the home-screen icon opens and the
 * cookie on every other phone, was merged into the new one and deleted, and a merge keeps no token.
 */
export async function linkTelegram(db: Db, playerId: string, user: TgUser): Promise<Player> {
  const other = await findTelegramPlayer(db, user.id);
  let keep = playerId;
  if (other && other.id !== playerId) {
    const weights = await recordWeights(db, [playerId, other.id]);
    const mine = weights.find((w) => w.id === playerId);
    const theirs = weights.find((w) => w.id === other.id);
    if (mine && theirs) keep = recordToKeep(mine, theirs);
    if (keep === playerId) {
      await db.update(players).set({ telegramId: null, telegramUsername: null }).where(eq(players.id, other.id));
      await mergePlayers(db, playerId, [other.id]);
    } else {
      // The record that holds the account already is the real one: the signed-in record folds into it.
      await mergePlayers(db, other.id, [playerId]);
    }
  }
  const [p] = await db.update(players).set({ telegramId: user.id, telegramUsername: user.username ?? null }).where(eq(players.id, keep)).returning();
  // A linked Telegram account is proof, as a code from an address is (`foldSameNameRows`). Never throws.
  await foldSameNameRows(db, p.id);
  return p;
}
