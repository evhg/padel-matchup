// Where a card lives: the rooms a bot is in and the cards it keeps in them, one pair of tables per channel.
import { bigint, boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { events } from "./events";
import { groups } from "./groups";

// ---------------------------------------------------------------------------
// telegram — group chats the bot sits in, and the one card per match it keeps
// edited there. Quiet by design: joins and leaves edit the card, new messages
// only for the card itself, a complete line-up, the reminder and the result.
// ---------------------------------------------------------------------------
export const telegramChats = pgTable(
  "telegram_chats",
  {
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
    /**
     * A crew's own group (the owner's decision of 9 October 2026, DECIDING rule 31): since when the bot
     * reads the plain messages here for "in", "out" and "who's in …?". Set only where a group admin
     * opted in from the crew page and the bot is an admin: claimed the moment before the notice is
     * pinned, and cleared again if the pin fails. Null everywhere else, and again after /quiet, a lost
     * admin right or the bot's removal. No message text is kept anywhere.
     */
    listeningSince: timestamp("listening_since", { withTimezone: true }),
    /** The version of the notice the group opted in under (`CREW_NOTICE_VERSION`); null where it never did, or after it opted out. */
    noticeVersion: integer("notice_version"),
    /** The pinned notice, so /quiet unpins that message and nothing somebody else pinned, and a promotion after a demotion pins it again instead of posting another. */
    noticeMessageId: bigint("notice_message_id", { mode: "number" }),
    /** The invite link the bot made for the crew's members, shown on the crew page while the bot is in the group (after /quiet too: the group is still the crew's). A door into the group, so the reader role never sees it. */
    inviteLink: text("invite_link"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("telegram_chats_group_idx").on(t.groupId)],
);

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
    /** card = the live match card; result = the result picture posted once; feed = the organizer's running message in their private chat; nudge = a player's "how did it go?", which becomes the result card. */
    kind: text("kind").notNull().default("card"),
    /** card/result: hash of the last rendered text, to skip no-op edits; feed: the JSON array of lines the running message shows; nudge: the version of the card picture it shows, null for a text nudge. */
    rendered: text("rendered"),
    /** The "line-up complete" note has been posted for this card. */
    completeNotedAt: timestamp("complete_noted_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // A reply to a card finds it by chat and message; a crew's own chat lists its open cards by chat.
  (t) => [uniqueIndex("telegram_cards_event_chat_kind_idx").on(t.eventId, t.chatId, t.kind), index("telegram_cards_event_idx").on(t.eventId), index("telegram_cards_chat_message_idx").on(t.chatId, t.messageId)],
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

// ---------------------------------------------------------------------------
// line_rooms / line_cards — the same quiet bot for LINE, with one difference
// that shapes everything: LINE cannot edit a message once it is sent.
//
// So `rendered` here holds `materialKey(detail)` rather than a render hash. A
// fresh card goes out only when something a player cares about changed — the
// time, the venue, a seat taken, the result — never for a cosmetic re-render
// or a language switch, because on this channel every "edit" is a new message
// in everyone's chat and a push against a metered monthly budget.
//
// A source id is a string and says which of the three kinds of place it is:
// a group (C…), a multi-person room (R…) or one person (U…).
// ---------------------------------------------------------------------------
export const lineRooms = pgTable("line_rooms", {
  /** LINE source id: C… a group, R… a room, U… one person. */
  roomId: text("room_id").primaryKey(),
  /** "group", "room" or "user" — the three shapes a LINE source comes in. */
  type: text("type").notNull(),
  /** Locale the bot speaks here. */
  locale: text("locale").notNull().default("en"),
  tz: text("tz"),
  venueName: text("venue_name"),
  /** The group behind this room, learned from the first group match carded here. */
  groupId: uuid("group_id").references(() => groups.id, { onDelete: "set null" }),
  /** Bot removed, or the room left: keep the row, stop pushing. */
  leftAt: timestamp("left_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const lineCards = pgTable(
  "line_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    roomId: text("room_id")
      .notNull()
      .references(() => lineRooms.roomId, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    /** card = the live match card; result = the result posted once. */
    kind: text("kind").notNull().default("card"),
    /** The material key of the last card sent here, not a render hash: see the note above. */
    rendered: text("rendered"),
    completeNotedAt: timestamp("complete_noted_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("line_cards_event_room_kind_idx").on(t.eventId, t.roomId, t.kind), index("line_cards_event_idx").on(t.eventId)],
);

export type LineRoom = typeof lineRooms.$inferSelect;

export type LineCard = typeof lineCards.$inferSelect;
