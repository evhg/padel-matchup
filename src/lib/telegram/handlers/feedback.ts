import type { Db } from "@/db";
import type { TelegramChat } from "@/db/schema";
import type { OpContext } from "@/lib/api/operations";
import { composeAck } from "@/lib/feedback/ack";
import { proposeToOwner } from "@/lib/feedback/propose";
import { appendFeedbackReply, createFeedback, FEEDBACK_LIMITS, feedbackCountToday, findNoteForReply, markAcknowledged, markNotFeedback, markOwnNote, saidBefore } from "@/lib/feedback/store";
import { ownerTelegramId } from "@/lib/config";
import { feedbackStrings } from "@/lib/feedback/strings";
import { esc, sendMessage, telegramBotId, type TgMessage, type TgUser } from "../api";
import { strings, type BotLocale } from "../card";
import { findTelegramPlayer } from "../identity";

/** Feedback: /feedback and its words, thanked at once and proposed to the owner; a reply to the thank-you joins the note. */

/** /feedback and your words: stored, thanked at once; the owner gets the proposal, and the person hears here if something gets built. */
export
async function feedbackFromChat(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, args: string, locale: BotLocale, ctx: OpContext): Promise<string> {
  const fs = feedbackStrings(locale);
  const text = args.trim();
  const isPrivate = msg.chat.type === "private";
  if (text.length < 3) {
    await sendMessage(chat.chatId, esc(fs.how), { silent: !isPrivate, replyTo: msg.message_id });
    return "feedback:how";
  }
  if ((await feedbackCountToday(db, { telegramUserId: from.id })) >= FEEDBACK_LIMITS.perPersonPerDay) return "feedback:too_many";
  const player = await findTelegramPlayer(db, from.id);
  // Asked before the row exists, so the count is notes left *before* this one. By Telegram id alone
  // and not also by player: that is the key `feedback_tg_user_idx` is on, and an OR across two
  // columns would not use it (rule 12). It is the same key this channel counts the daily cap by.
  const said = await saidBefore(db, { telegramUserId: from.id });
  const row = await createFeedback(db, {
    source: "telegram",
    text,
    locale,
    name: from.first_name,
    playerId: player?.id ?? null,
    context: isPrivate ? null : ((msg.chat as { title?: string }).title ?? null),
    telegramChatId: chat.chatId,
    telegramUserId: from.id,
    telegramThreadId: msg.message_thread_id ?? null,
    telegramMessageId: msg.message_id,
  });
  // The owner writing as a player: the proposal is already on its way to this same chat, and it is
  // the useful one. Nothing is said back and nothing is counted as sent, because nothing was.
  if (ownerTelegramId() !== null && from.id === ownerTelegramId()) {
    await markOwnNote(db, row.id);
    ctx.afterwards(async () => {
      await proposeToOwner(db, row.id).catch(() => undefined);
    });
    return `feedback:own:${row.id}`;
  }
  const ack = await composeAck(db, { text, name: from.first_name, locale, source: "telegram", said });
  const res = await sendMessage(chat.chatId, esc(ack.reply), { silent: !isPrivate, replyTo: msg.message_id });
  if (ack.kind === "not_feedback") {
    await markNotFeedback(db, row.id, ack.reply);
    return `feedback_not:${row.id}`;
  }
  if (res.ok) {
    await markAcknowledged(db, row.id, ack.reply);
    // The note is the trigger: the owner's proposal follows the thank-you, after the webhook has answered.
    ctx.afterwards(async () => {
      await proposeToOwner(db, row.id).catch(() => undefined);
    });
  }
  return `feedback:${row.id}`;
}

/** A reply to the thank-you (or any of our messages) from someone with a recent note: it joins that note. */
export
async function feedbackReply(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, locale: BotLocale): Promise<string | null> {
  const replied = msg.reply_to_message;
  if (!replied || !msg.text || !replied.from?.is_bot) return null;
  const botId = telegramBotId();
  if (botId && String(replied.from.id) !== botId) return null;
  const note = await findNoteForReply(db, { telegramUserId: from.id, telegramChatId: chat.chatId });
  if (!note) return null;
  const updated = await appendFeedbackReply(db, note.id, msg.text);
  if (!updated) return null;
  if (updated.messagesSent < FEEDBACK_LIMITS.messagesPerItem) await sendMessage(chat.chatId, esc(strings(locale).feedbackAdded), { replyTo: msg.message_id, silent: true });
  return `feedback:added:${note.id}`;
}
