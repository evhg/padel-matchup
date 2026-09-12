import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, telegramCards, telegramChats, type Event, type TelegramChat } from "@/db/schema";
import type { TgChat, TgUser } from "./api";
import { botLocale } from "./card";

/** The chats the bot is in: their rows, the zone their matches live in, their usual court. */
export const GROUP_TYPES = new Set(["group", "supergroup"]);

export async function getChat(db: Db, chatId: number): Promise<TelegramChat | null> {
  const [c] = await db.select().from(telegramChats).where(eq(telegramChats.chatId, chatId)).limit(1);
  return c ?? null;
}

export async function upsertChat(db: Db, chat: TgChat, from?: TgUser | null): Promise<{ chat: TelegramChat; created: boolean }> {
  const existing = await getChat(db, chat.id);
  if (existing) {
    if (existing.title !== (chat.title ?? null) || existing.type !== chat.type || existing.leftAt) {
      const [c] = await db.update(telegramChats).set({ title: chat.title ?? null, type: chat.type, leftAt: null }).where(eq(telegramChats.chatId, chat.id)).returning();
      return { chat: c, created: false };
    }
    return { chat: existing, created: false };
  }
  const [c] = await db
    .insert(telegramChats)
    .values({ chatId: chat.id, type: chat.type, title: chat.title ?? null, locale: botLocale(from?.language_code) })
    .onConflictDoUpdate({ target: telegramChats.chatId, set: { title: chat.title ?? null, type: chat.type, leftAt: null } })
    .returning();
  return { chat: c, created: true };
}

/** The zone a chat's matches live in: set with /tz, learned from the last match carried here, or read off the text (a city or an area). */
export
async function chatZone(db: Db, chat: TelegramChat, hint: string | null): Promise<string | null> {
  if (chat.tz) return chat.tz;
  const [row] = await db.select({ tz: events.tz }).from(telegramCards).innerJoin(events, eq(events.id, telegramCards.eventId)).where(eq(telegramCards.chatId, chat.chatId)).orderBy(desc(telegramCards.createdAt)).limit(1);
  return row?.tz ?? hint;
}

/** A chat learns its zone and its usual court from the first match made for it. */
export
async function rememberChatDefaults(db: Db, chat: TelegramChat, ev: Event): Promise<void> {
  const set: Partial<typeof telegramChats.$inferInsert> = {};
  if (!chat.tz) set.tz = ev.tz;
  if (!chat.venueName && ev.venueName) set.venueName = ev.venueName;
  if (Object.keys(set).length) await db.update(telegramChats).set(set).where(eq(telegramChats.chatId, chat.chatId));
}
