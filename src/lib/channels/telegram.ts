import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { events, telegramCards, telegramChats, telegramInlineCards, type TelegramCard, type TelegramChat } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { editInlineMessageText, editMessageText, editOk, sendMessage, sendPhoto, telegramEnabled, type InlineKeyboard } from "@/lib/telegram/api";
import { botLocale, renderCard, strings, type BotLocale } from "@/lib/telegram/card";
import { syncCards } from "./cards";
import type { Card, CardChannel, Room } from "./types";

/** Telegram as a card channel: chats and cards in their own tables, HTML text with an inline keyboard, edited in place. */
export type TelegramPayload = { text: string; keyboard: InlineKeyboard };
type TgRoom = Room<TelegramChat>;
type TgCard = Card<TelegramCard>;

const GROUP_TYPES = new Set(["group", "supergroup"]);
const DAY_MS = 24 * 60 * 60 * 1000;
export const chatLocale = (chat: TelegramChat | null, fallback?: string | null): BotLocale => (chat ? (chat.locale === "ru" ? "ru" : "en") : botLocale(fallback));
export const renderHash = (text: string, keyboard: unknown) => createHash("sha256").update(text).update(JSON.stringify(keyboard)).digest("hex");
export const telegramRoom = (chat: TelegramChat): TgRoom => ({ id: String(chat.chatId), locale: chatLocale(chat), groupId: chat.groupId, raw: chat });
const cardOf = (c: TelegramCard): TgCard => ({ id: c.id, kind: c.kind, messageId: c.messageId, rendered: c.rendered, completeNotedAt: c.completeNotedAt, raw: c });

export const telegramChannel: CardChannel<TelegramPayload, TelegramChat, TelegramCard> = {
  name: "telegram",
  enabled: telegramEnabled,
  canEdit: true,
  async roomsOfGroup(db, groupId) {
    const chats = await db.select().from(telegramChats).where(and(eq(telegramChats.groupId, groupId), isNull(telegramChats.leftAt))).limit(50);
    return chats.map(telegramRoom);
  },
  async cardsOf(db, eventId, kinds) {
    const rows = await db
      .select({ card: telegramCards, chat: telegramChats })
      .from(telegramCards)
      .innerJoin(telegramChats, eq(telegramChats.chatId, telegramCards.chatId))
      .where(and(eq(telegramCards.eventId, eventId), isNull(telegramChats.leftAt), ...(kinds?.length ? [inArray(telegramCards.kind, kinds)] : [])));
    return rows.map(({ card, chat }) => ({ card: cardOf(card), room: telegramRoom(chat) }));
  },
  render(detail, locale, now) {
    const { text, keyboard, complete } = renderCard(detail, baseUrl(), locale, now);
    return { payload: { text, keyboard }, hash: renderHash(text, keyboard), complete };
  },
  async post(_db, room, payload, o = {}) {
    const sent = await sendMessage(room.raw.chatId, payload.text, { keyboard: payload.keyboard, replyTo: typeof o.replyTo === "number" ? o.replyTo : null, threadId: o.threadId ?? null, silent: o.silent });
    return sent.ok ? { ok: true, messageId: sent.result.message_id } : { ok: false };
  },
  async edit(_db, room, card, payload) {
    return editOk(await editMessageText(room.raw.chatId, Number(card.messageId), payload.text, payload.keyboard));
  },
  async note(_db, room, text, o = {}) {
    const res = await sendMessage(room.raw.chatId, text, { replyTo: typeof o.replyTo === "number" ? o.replyTo : null, silent: o.silent });
    return res.ok;
  },
  async result(_db, room, summary, o = {}) {
    const s = strings(summary.locale);
    let caption = summary.title;
    if (summary.score) caption += `\n${summary.score}`;
    if (summary.winners) caption += `\n${summary.winners}\n${summary.praise}`;
    if (summary.podium) caption += `\n${summary.podium}`;
    const keyboard: InlineKeyboard = { inline_keyboard: [[{ text: s.open, url: summary.url }], ...(summary.sameTimeCode ? [[{ text: s.sameTime, callback_data: `g:${summary.sameTimeCode}` }]] : [])] };
    const replyTo = typeof o.replyTo === "number" ? o.replyTo : null;
    const photo = await sendPhoto(room.raw.chatId, summary.imageUrl, caption, { replyTo, keyboard });
    const res = photo.ok ? photo : await sendMessage(room.raw.chatId, caption, { replyTo, keyboard });
    return res.ok ? { ok: true, messageId: res.result.message_id } : { ok: false };
  },
  async saveCard(db, eventId, room, messageId, kind, rendered) {
    await db.insert(telegramCards).values({ eventId, chatId: room.raw.chatId, messageId: Number(messageId), kind, rendered }).onConflictDoNothing();
  },
  async markRendered(db, card, rendered) {
    await db.update(telegramCards).set({ rendered, updatedAt: new Date() }).where(eq(telegramCards.id, card.id));
  },
  async markCompleteNoted(db, card) {
    await db.update(telegramCards).set({ completeNotedAt: new Date() }).where(eq(telegramCards.id, card.id));
  },
  async bindGroup(db, room, groupId) {
    if (!GROUP_TYPES.has(room.raw.type)) return;
    await db.update(telegramChats).set({ groupId }).where(and(eq(telegramChats.chatId, room.raw.chatId), isNull(telegramChats.groupId)));
  },
  async remindersDue(db, now, soon) {
    return db
      .select({ id: events.id, code: events.code })
      .from(events)
      .where(and(gt(events.startsAt, now), lte(events.startsAt, soon), isNull(events.telegramReminderSentAt), inArray(events.status, ["open", "full"]), sql`exists (select 1 from ${telegramCards} c where c.event_id = ${events.id} and c.kind = 'card')`))
      .limit(50);
  },
  async markReminded(db, eventId, now) {
    await db.update(events).set({ telegramReminderSentAt: now }).where(eq(events.id, eventId));
  },
  /** Cards shared through inline mode: same render, edited by their inline message id. */
  async syncExtra(db, detail, now) {
    let edits = 0;
    const inline = await db.select().from(telegramInlineCards).where(eq(telegramInlineCards.eventId, detail.event.id)).limit(200);
    for (const c of inline) {
      const { text, keyboard } = renderCard(detail, baseUrl(), c.locale === "ru" ? "ru" : "en", now);
      const hash = renderHash(text, keyboard);
      if (hash === c.rendered) continue;
      if (editOk(await editInlineMessageText(c.inlineMessageId, text, keyboard))) {
        await db.update(telegramInlineCards).set({ rendered: hash, updatedAt: new Date() }).where(eq(telegramInlineCards.inlineMessageId, c.inlineMessageId));
        edits++;
      }
    }
    return edits;
  },
  /** Cards of matches that started in the last day and have no confirmed result are re-rendered, so the Result button shows up. The hash keeps it to one edit per card. */
  async refreshStarted(db, now) {
    const rows = await db
      .selectDistinct({ code: events.code })
      .from(events)
      .where(
        and(
          eq(events.type, "match"),
          lte(events.startsAt, now),
          gt(events.startsAt, new Date(now.getTime() - DAY_MS)),
          eq(events.scoreLockedByCreator, false),
          inArray(events.status, ["open", "full", "past"]),
          sql`(exists (select 1 from ${telegramCards} c where c.event_id = ${events.id} and c.kind = 'card') or exists (select 1 from ${telegramInlineCards} i where i.event_id = ${events.id}))`,
        ),
      )
      .limit(100);
    let edits = 0;
    for (const r of rows) edits += await syncCards(telegramChannel, db, r.code, now);
    return edits;
  },
};
