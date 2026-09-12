// Where a card lives: the rooms a bot is in and the cards it keeps in them, one pair of tables per channel.
import { bigint, boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { events } from "./events";
import { groups } from "./groups";

// ---------------------------------------------------------------------------
// telegram — group chats the bot sits in, and the one card per match it keeps
// edited there. Quiet by design: joins and leaves edit the card, new messages
// only for the card itself, a complete line-up, the reminder and the result.
// ---------------------------------------------------------------------------
export const telegramChats = pgTable("telegram_chats", {
  /** Telegram chat id (negative for groups). */
  chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
  type: text("type").notNull(),
  title: text("title"),
  /** Locale the bot speaks in this chat: en or ru. */
  locale: text("locale").notNull().default("en"),
  /** Defaults for matches created from the chat. */
  tz: text("tz"),
  venueName: text("venue_name"),
  /** The group behind this chat, learned from the first group match carded here: its weekly matches land here by themselves, and /new here makes group matches. */
  groupId: uuid("group_id").references(() => groups.id, { onDelete: "set null" }),
  /** Bot removed from the chat: keep the row, stop posting. */
  leftAt: timestamp("left_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const telegramCards = pgTable(
  "telegram_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    chatId: bigint("chat_id", { mode: "number" })
      .notNull()
      .references(() => telegramChats.chatId, { onDelete: "cascade" }),
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    /** card = the live match card; result = the result picture posted once; feed = the organizer's running message in their private chat. */
    kind: text("kind").notNull().default("card"),
    /** card/result: hash of the last rendered text, to skip no-op edits; feed: the JSON array of lines the running message shows. */
    rendered: text("rendered"),
    /** The "line-up complete" note has been posted for this card. */
    completeNotedAt: timestamp("complete_noted_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("telegram_cards_event_chat_kind_idx").on(t.eventId, t.chatId, t.kind), index("telegram_cards_event_idx").on(t.eventId)],
);

/**
 * Cards sent through inline mode (@bot CODE in any chat, no membership needed).
 * Telegram gives no chat id for these, only an inline message id, which is
 * enough to keep editing the card.
 */
export const telegramInlineCards = pgTable(
  "telegram_inline_cards",
  {
    inlineMessageId: text("inline_message_id").primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /** Locale the card was rendered in (the sender's). */
    locale: text("locale").notNull().default("en"),
    rendered: text("rendered"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("telegram_inline_cards_event_idx").on(t.eventId)],
);

export type TelegramInlineCard = typeof telegramInlineCards.$inferSelect;

export type TelegramChat = typeof telegramChats.$inferSelect;

export type TelegramCard = typeof telegramCards.$inferSelect;

// ---------------------------------------------------------------------------
// discord_channels / discord_cards — the same quiet bot for Discord servers:
// one card per match per channel, edited in place. Ids are Discord snowflakes
// kept as text. `last_message_id` is the listening cursor for the hourly poll.
// ---------------------------------------------------------------------------
export const discordChannels = pgTable("discord_channels", {
  channelId: text("channel_id").primaryKey(),
  guildId: text("guild_id").notNull(),
  name: text("name"),
  guildName: text("guild_name"),
  /** Locale the bot speaks in this channel: en or ru. */
  locale: text("locale").notNull().default("en"),
  tz: text("tz"),
  venueName: text("venue_name"),
  /** Newest message the listener has read in this channel. */
  lastMessageId: text("last_message_id"),
  /** The listener answers questions here (off for channels an admin turned it off in). */
  listen: boolean("listen").notNull().default(true),
  /** The group behind this channel, learned from the first group match carded here: its weekly matches land here by themselves. */
  groupId: uuid("group_id").references(() => groups.id, { onDelete: "set null" }),
  /** Bot lost access: keep the row, stop posting. */
  leftAt: timestamp("left_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const discordCards = pgTable(
  "discord_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => discordChannels.channelId, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    /** card = the live match card; result = the result posted once. */
    kind: text("kind").notNull().default("card"),
    rendered: text("rendered"),
    completeNotedAt: timestamp("complete_noted_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("discord_cards_event_channel_kind_idx").on(t.eventId, t.channelId, t.kind), index("discord_cards_event_idx").on(t.eventId)],
);

export type DiscordChannel = typeof discordChannels.$inferSelect;

export type DiscordCard = typeof discordCards.$inferSelect;
