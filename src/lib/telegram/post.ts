import type { Db } from "@/db";
import type { TelegramChat } from "@/db/schema";
import { postCard as postCardIn, postCardsForGroup as postCardsForGroupIn, postResult, sendReminders, syncCards } from "@/lib/channels/cards";
import { telegramChannel, telegramRoom } from "@/lib/channels/telegram";
import { getEventByCode, type EventDetail } from "@/lib/domain/queries";
import { telegramEnabled } from "./api";
import { getChat, rememberChatDefaults } from "./chats";
import { verifyChatTicket } from "./identity";

/** Cards into chats: Telegram's names for the one card algorithm in src/lib/channels. */

/** Posts the card of a match into a chat, or refreshes the one already there. The algorithm lives in src/lib/channels. */
export async function postCard(db: Db, detail: EventDetail, chat: TelegramChat, o: { replyTo?: number | null; threadId?: number | null } = {}): Promise<"posted" | "refreshed" | "failed"> {
  return postCardIn(telegramChannel, db, detail, telegramRoom(chat), { replyTo: o.replyTo ?? null, threadId: o.threadId ?? null });
}

/** A match of a group: its card goes into every chat tied to that group. */
export const postCardsForGroup = (db: Db, code: string): Promise<number> => postCardsForGroupIn(telegramChannel, db, code);

/** Called after anything changed on a match: edits every card silently, notes a complete line-up once. Never throws. */
export const syncTelegram = (db: Db, code: string, now = new Date()): Promise<number> => syncCards(telegramChannel, db, code, now);

/** Posts the card into the chat behind a /new ticket, once the match exists. */
export async function postCardForTicket(db: Db, code: string, ticket: string | null | undefined): Promise<boolean> {
  const chatId = verifyChatTicket(ticket);
  if (!chatId || !telegramEnabled()) return false;
  const [chat, detail] = await Promise.all([getChat(db, chatId), getEventByCode(db, code)]);
  if (!chat || chat.leftAt || !detail) return false;
  await rememberChatDefaults(db, chat, detail.event);
  return (await postCard(db, detail, chat)) !== "failed";
}

/** Every few minutes: cards of matches that just started grow their Result button. */
export const refreshStartedCards = (db: Db, now = new Date()): Promise<number> => telegramChannel.refreshStarted!(db, now);

/** About an hour before: one reminder per match into each chat that carries its card. */
export const sendTelegramReminders = (db: Db, now = new Date()): Promise<number> => sendReminders(telegramChannel, db, now);

/** The first result anyone records: the picture, once per chat, with a line for the winners and "same time next week?". Never throws. */
export const postTelegramResult = (db: Db, code: string): Promise<number> => postResult(telegramChannel, db, code);
