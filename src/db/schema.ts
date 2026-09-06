import { relations, sql } from "drizzle-orm";
import { bigint, boolean, date, index, integer, jsonb, pgEnum, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const eventTypeEnum = pgEnum("event_type", ["match", "tournament"]);
export const whenFullEnum = pgEnum("when_full", ["waitlist", "closed"]);
export const eventStatusEnum = pgEnum("event_status", ["open", "full", "cancelled", "past"]);
export const slotKindEnum = pgEnum("slot_kind", ["open", "reserved"]);
export const slotStatusEnum = pgEnum("slot_status", ["empty", "invited", "confirmed", "declined", "joined"]);
export const teamEnum = pgEnum("team", ["a", "b"]);
export const activityVerbEnum = pgEnum("activity_verb", [
  "created",
  "joined",
  "left",
  "confirmed",
  "declined",
  "promoted",
  "removed",
  "score_entered",
  "cancelled",
  "updated",
  "invited",
  "requested",
  "approved",
  "rejected",
]);
export const joinRequestStatusEnum = pgEnum("join_request_status", ["pending", "approved", "declined", "withdrawn"]);
export const groupRoleEnum = pgEnum("group_role", ["admin", "member"]);

/** One line per result-based level change, newest last (capped in code). */
export type LevelLogEntry = { at: string; from: number; to: number; code: string; type: "match" | "tournament" };
export type TournamentFormat = "americano" | "mexicano" | "king";

// ---------------------------------------------------------------------------
// players — identity is a UUID in a signed cookie; no auth, no passwords.
// ---------------------------------------------------------------------------
export const players = pgTable(
  "players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name").notNull(),
    phone: text("phone"),
    email: text("email"),
    /** Set once the player proved ownership of `email` with a one-time code. */
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    /** The address before the last change: a restore code sent there still gets the player back in. */
    recoveryEmail: text("recovery_email"),
    /** Random token behind the personal link /p/{token}; signs in on any device. */
    personalToken: text("personal_token"),
    /** The token before the last lazy shortening; still accepted so old calendar entries and shortcuts keep working. */
    previousToken: text("previous_token"),
    /** First visit from a home-screen shortcut: the prompt is no longer needed. */
    homescreenAt: timestamp("homescreen_at", { withTimezone: true }),
    /** Activity emails (players join/leave/respond, line-up changes, score reminder). Calendar/cancellation emails always go out. */
    emailNotifications: boolean("email_notifications").notNull().default(true),
    /** Padel level 0–7 (quarter steps when self-declared, two decimals once results nudge it). Null = not set. */
    level: real("level"),
    /** "self" (declared by the player) or "adjusted" (results moved it). */
    levelSource: text("level_source"),
    levelUpdatedAt: timestamp("level_updated_at", { withTimezone: true }),
    levelLog: jsonb("level_log").$type<LevelLogEntry[]>(),
    /** An organizer who played with them confirmed the level; valid while `level` stays within half a step of `level_verified_level`. */
    levelVerifiedAt: timestamp("level_verified_at", { withTimezone: true }),
    levelVerifiedBy: uuid("level_verified_by"),
    levelVerifiedLevel: real("level_verified_level"),
    /** Opted in to the public club and city rankings. Off by default. */
    rankingOptIn: boolean("ranking_opt_in").notNull().default(false),
    /** Telegram account linked by the bot or the login widget. */
    telegramId: bigint("telegram_id", { mode: "number" }),
    telegramUsername: text("telegram_username"),
    /** Discord account linked by the bot (snowflakes as text: they exceed 2^53). */
    discordId: text("discord_id"),
    discordUsername: text("discord_username"),
    /** Opt-in public profile at /u/{public_slug}. Off by default; the slug is minted on the first opt-in and kept. */
    publicProfile: boolean("public_profile").notNull().default(false),
    publicSlug: text("public_slug"),
    publicSince: timestamp("public_since", { withTimezone: true }),
    locale: text("locale").notNull().default("en"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("players_personal_token_idx")
      .on(t.personalToken)
      .where(sql`${t.personalToken} is not null`),
    index("players_email_idx").on(t.email),
    index("players_recovery_email_idx").on(t.recoveryEmail),
    uniqueIndex("players_telegram_id_idx")
      .on(t.telegramId)
      .where(sql`${t.telegramId} is not null`),
    uniqueIndex("players_discord_id_idx")
      .on(t.discordId)
      .where(sql`${t.discordId} is not null`),
    uniqueIndex("players_public_slug_idx")
      .on(t.publicSlug)
      .where(sql`${t.publicSlug} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// email_codes — one-time codes proving ownership of an email (restore/merge).
// ---------------------------------------------------------------------------
export const emailCodes = pgTable(
  "email_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("email_codes_email_idx").on(t.email, t.createdAt)],
);

// ---------------------------------------------------------------------------
// events — a match (exactly 4) or a tournament (creator-set capacity).
// ---------------------------------------------------------------------------
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Public 4-char share code: /{code} */
    code: varchar("code", { length: 4 }).notNull(),
    type: eventTypeEnum("type").notNull().default("match"),
    title: text("title"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    /** IANA timezone the event was created in (display only; starts_at is UTC). */
    tz: text("tz").notNull(),
    /** Optional: null means "court TBD". */
    venueName: text("venue_name"),
    venueMapUrl: text("venue_map_url"),
    /** Optional court within the venue ("3", "Centre court"). */
    court: text("court"),
    capacity: integer("capacity").notNull(),
    whenFull: whenFullEnum("when_full").notNull().default("waitlist"),
    note: text("note"),
    creatorPlayerId: uuid("creator_player_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    /** Secret 10-char organizer code: /{code}/manage/{manage_code}. Never shorten. */
    manageCode: varchar("manage_code", { length: 10 }).notNull(),
    status: eventStatusEnum("status").notNull().default("open"),
    scoreLockedByCreator: boolean("score_locked_by_creator").notNull().default(false),
    scoreReminderSent: boolean("score_reminder_sent").notNull().default(false),
    /** iCalendar SEQUENCE — bumped on every time/venue change or cancellation. */
    icsSequence: integer("ics_sequence").notNull().default(0),
    /** Web-push "one hour before" reminder went out (once per event). */
    pushReminderSentAt: timestamp("push_reminder_sent_at", { withTimezone: true }),
    /** Tournament format: americano (rotating partners), mexicano (courts by standings) or king (winners move up). Null = americano. */
    format: text("format").$type<TournamentFormat>(),
    /** Americano: number of courts in play (null → floor(players / 4)). */
    courts: integer("courts"),
    /** Americano: points per match (e.g. 16, 21, 24, 32); null → free scoring. */
    pointsPerMatch: integer("points_per_match"),
    /** Tournament: final standings snapshot (ordered player ids) written on finalize. */
    standings: jsonb("standings").$type<string[]>(),
    /** Tournament: organizer-given court names by index (court 1 = [0]); null/empty entry = "Court n". */
    courtNames: jsonb("court_names").$type<string[]>(),
    /** Level range (0–7). Both null = open to everyone; outside the range players ask to join. */
    levelMin: real("level_min"),
    levelMax: real("level_max"),
    /** Result-based level adjustment ran for this event (once, on the organizer's finalize/confirm). */
    levelsAppliedAt: timestamp("levels_applied_at", { withTimezone: true }),
    /** The group this match belongs to (created from a group, or the group was formed from it). */
    groupId: uuid("group_id").references((): AnyPgColumn => groups.id, { onDelete: "set null" }),
    /** Organizer opted in to the public venue board (/v/{venue_slug}). Off by default. */
    publicListing: boolean("public_listing").notNull().default(false),
    /** URL-safe key of venue_name, kept in sync on create/update. */
    venueSlug: text("venue_slug"),
    /** Optional link to the club's booking page or confirmation. */
    bookingUrl: text("booking_url"),
    /** What each player pays, as the organizer wrote it ("400 ฿", "€8"). */
    cost: text("cost"),
    /** How to pay the organizer (PromptPay number, Revolut tag…). For the players: on the page and the cards, never in the public API. */
    payNote: text("pay_note"),
    /** Telegram "one hour before" reminder went out to the chats that carry this match (once per event). */
    telegramReminderSentAt: timestamp("telegram_reminder_sent_at", { withTimezone: true }),
    /** Same for the Discord channels that carry this match. */
    discordReminderSentAt: timestamp("discord_reminder_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("events_code_idx").on(t.code),
    index("events_creator_idx").on(t.creatorPlayerId),
    index("events_starts_at_idx").on(t.startsAt),
    index("events_group_idx").on(t.groupId),
    index("events_venue_slug_idx").on(t.venueSlug, t.startsAt),
  ],
);

// ---------------------------------------------------------------------------
// groups — a crew that plays together. Any member creates the next match; an
// optional weekly slot creates it automatically a few days ahead.
// ---------------------------------------------------------------------------
export const groups = pgTable(
  "groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Public 6-char code: /g/{code}. Anyone with the link can join. */
    code: varchar("code", { length: 6 }).notNull(),
    name: text("name").notNull(),
    creatorPlayerId: uuid("creator_player_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    /** Defaults for the next match. */
    venueName: text("venue_name"),
    venueMapUrl: text("venue_map_url"),
    court: text("court"),
    tz: text("tz").notNull(),
    type: eventTypeEnum("type").notNull().default("match"),
    capacity: integer("capacity").notNull().default(4),
    whenFull: whenFullEnum("when_full").notNull().default("waitlist"),
    levelMin: real("level_min"),
    levelMax: real("level_max"),
    /** Weekly slot (0 = Sunday … 6 = Saturday, "HH:MM" in tz); null = no automatic matches. */
    recurDow: integer("recur_dow"),
    recurTime: text("recur_time"),
    /** How many days ahead the automatic match is created. */
    recurLeadDays: integer("recur_lead_days").notNull().default(5),
    /** startsAt of the last automatically created match (guards against duplicates). */
    recurLastCreatedFor: timestamp("recur_last_created_for", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("groups_code_idx").on(t.code), index("groups_creator_idx").on(t.creatorPlayerId)],
);

export const groupMembers = pgTable(
  "group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    role: groupRoleEnum("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.playerId] }), index("group_members_player_idx").on(t.playerId)],
);
export type Group = typeof groups.$inferSelect;
export type GroupMember = typeof groupMembers.$inferSelect;

// ---------------------------------------------------------------------------
// Public API: keys are optional (reads are open, writes are rate-limited per IP
// without one); a key raises limits and unlocks webhooks. Keys are stored hashed.
// ---------------------------------------------------------------------------
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyHash: text("key_hash").notNull(),
    /** First characters of the key, for display ("ks_live_ab12…"). */
    prefix: text("prefix").notNull(),
    name: text("name").notNull(),
    email: text("email"),
    /** Free-form: which assistant or product uses the key ("claude", "chatgpt", "my-club-bot"). */
    agent: text("agent"),
    calls: bigint("calls", { mode: "number" }).notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("api_keys_hash_idx").on(t.keyHash)],
);
export type ApiKey = typeof apiKeys.$inferSelect;

export type WebhookFilter = { venueSlug?: string | null; groupCode?: string | null; codes?: string[] | null };

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyId: uuid("key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** Subscribed event names ("match.created", …). */
    events: jsonb("events").$type<string[]>().notNull(),
    filter: jsonb("filter").$type<WebhookFilter>(),
    /** Shared secret for the HMAC signature header. */
    secret: text("secret").notNull(),
    failures: integer("failures").notNull().default(0),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhooks_key_idx").on(t.keyId)],
);
export type Webhook = typeof webhooks.$inferSelect;

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_deliveries_due_idx").on(t.nextAttemptAt), index("webhook_deliveries_webhook_idx").on(t.webhookId)],
);
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

// ---------------------------------------------------------------------------
// slots — positions 1..capacity are the roster; positions > capacity are the
// waitlist (ordered by position). Reserved slots carry a personal invite code.
// ---------------------------------------------------------------------------
export const slots = pgTable(
  "slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "set null" }),
    kind: slotKindEnum("kind").notNull().default("open"),
    /** 6-char personal invite code: /{code}/i/{invite_code} */
    inviteCode: varchar("invite_code", { length: 6 }),
    status: slotStatusEnum("status").notNull().default("empty"),
    invitedName: text("invited_name"),
    invitedEmail: text("invited_email"),
    invitedPhone: text("invited_phone"),
    position: integer("position").notNull(),
    /** Team assignment chosen at score entry (optional). */
    team: teamEnum("team"),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("slots_event_position_idx").on(t.eventId, t.position),
    uniqueIndex("slots_event_player_idx")
      .on(t.eventId, t.playerId)
      .where(sql`${t.playerId} is not null`),
    uniqueIndex("slots_invite_code_idx")
      .on(t.inviteCode)
      .where(sql`${t.inviteCode} is not null`),
    index("slots_player_idx").on(t.playerId),
  ],
);

// ---------------------------------------------------------------------------
// scores — one shared scoreboard per match, per-set (1..3 sets).
// ---------------------------------------------------------------------------
export const scores = pgTable(
  "scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    setNumber: integer("set_number").notNull(),
    sideA: integer("side_a").notNull(),
    sideB: integer("side_b").notNull(),
    enteredByPlayerId: uuid("entered_by_player_id").references(() => players.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("scores_event_set_idx").on(t.eventId, t.setNumber)],
);

// ---------------------------------------------------------------------------
// venues — per-creator memory powering the venue combobox.
// ---------------------------------------------------------------------------
export const venues = pgTable(
  "venues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    creatorPlayerId: uuid("creator_player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mapUrl: text("map_url"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("venues_creator_name_idx").on(t.creatorPlayerId, t.name)],
);

// ---------------------------------------------------------------------------
// activity — in-app feed shown on every event page.
// ---------------------------------------------------------------------------
export const activity = pgTable(
  "activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    actorPlayerId: uuid("actor_player_id").references(() => players.id, { onDelete: "set null" }),
    verb: activityVerbEnum("verb").notNull(),
    /** Free-form context: { name } for actors without a player row, etc. */
    meta: jsonb("meta").$type<Record<string, string | number | null>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("activity_event_idx").on(t.eventId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Americano engine — rounds of rotating-partner doubles, per-match points.
// ---------------------------------------------------------------------------
export const tournamentRounds = pgTable(
  "tournament_rounds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    roundNumber: integer("round_number").notNull(),
    /** Players sitting this round out (ordered player ids). */
    resting: jsonb("resting").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tournament_rounds_event_round_idx").on(t.eventId, t.roundNumber)],
);

export const tournamentMatches = pgTable(
  "tournament_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roundId: uuid("round_id")
      .notNull()
      .references(() => tournamentRounds.id, { onDelete: "cascade" }),
    court: integer("court").notNull(),
    a1: uuid("a1")
      .notNull()
      .references(() => players.id),
    a2: uuid("a2")
      .notNull()
      .references(() => players.id),
    b1: uuid("b1")
      .notNull()
      .references(() => players.id),
    b2: uuid("b2")
      .notNull()
      .references(() => players.id),
    sideA: integer("side_a"),
    sideB: integer("side_b"),
    enteredByPlayerId: uuid("entered_by_player_id").references(() => players.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tournament_matches_round_court_idx").on(t.roundId, t.court), index("tournament_matches_round_idx").on(t.roundId)],
);

// ---------------------------------------------------------------------------
// Relations (for db.query.*)
// ---------------------------------------------------------------------------
export const playersRelations = relations(players, ({ many }) => ({
  slots: many(slots),
  events: many(events),
}));

/** Self-measured usage counters and daily snapshots for the read-only /admin dashboard. */
export const metricsDaily = pgTable("metrics_daily", {
  day: date("day").notNull(),
  key: text("key").notNull(),
  value: bigint("value", { mode: "number" }).notNull().default(0),
}, (t) => [primaryKey({ columns: [t.day, t.key] })]);
export type MetricRow = typeof metricsDaily.$inferSelect;

/** Addresses that asked never to be emailed by organizers again (invites, reminders). */
export const emailOptOuts = pgTable("email_opt_outs", {
  email: text("email").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Players outside an event's level range ask to join; the organizer decides. */
export const joinRequests = pgTable(
  "join_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    /** The player's level when they asked. */
    level: real("level"),
    status: joinRequestStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByPlayerId: uuid("decided_by_player_id").references(() => players.id, { onDelete: "set null" }),
  },
  (t) => [uniqueIndex("join_requests_event_player_idx").on(t.eventId, t.playerId), index("join_requests_event_idx").on(t.eventId)],
);
export type JoinRequest = typeof joinRequests.$inferSelect;

/** Web Push subscriptions (one per browser/home-screen app, many per player). */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_idx").on(t.endpoint), index("push_subscriptions_player_idx").on(t.playerId)],
);
export type PushSubscription = typeof pushSubscriptions.$inferSelect;

export const eventsRelations = relations(events, ({ one, many }) => ({
  creator: one(players, { fields: [events.creatorPlayerId], references: [players.id] }),
  slots: many(slots),
  scores: many(scores),
  activity: many(activity),
}));

export const slotsRelations = relations(slots, ({ one }) => ({
  event: one(events, { fields: [slots.eventId], references: [events.id] }),
  player: one(players, { fields: [slots.playerId], references: [players.id] }),
}));

export const scoresRelations = relations(scores, ({ one }) => ({
  event: one(events, { fields: [scores.eventId], references: [events.id] }),
  enteredBy: one(players, { fields: [scores.enteredByPlayerId], references: [players.id] }),
}));

export const activityRelations = relations(activity, ({ one }) => ({
  event: one(events, { fields: [activity.eventId], references: [events.id] }),
  actor: one(players, { fields: [activity.actorPlayerId], references: [players.id] }),
}));

export const venuesRelations = relations(venues, ({ one }) => ({
  creator: one(players, { fields: [venues.creatorPlayerId], references: [players.id] }),
}));

export const tournamentRoundsRelations = relations(tournamentRounds, ({ one, many }) => ({
  event: one(events, { fields: [tournamentRounds.eventId], references: [events.id] }),
  matches: many(tournamentMatches),
}));

export const tournamentMatchesRelations = relations(tournamentMatches, ({ one }) => ({
  round: one(tournamentRounds, { fields: [tournamentMatches.roundId], references: [tournamentRounds.id] }),
}));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Player = typeof players.$inferSelect;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type Slot = typeof slots.$inferSelect;
export type Score = typeof scores.$inferSelect;
export type Venue = typeof venues.$inferSelect;
export type Activity = typeof activity.$inferSelect;
export type TournamentRound = typeof tournamentRounds.$inferSelect;
export type TournamentMatch = typeof tournamentMatches.$inferSelect;
export type EmailCode = typeof emailCodes.$inferSelect;
export type EventType = Event["type"];
export type EventStatus = Event["status"];
export type SlotStatus = Slot["status"];
export type WhenFull = Event["whenFull"];
export type ActivityVerb = Activity["verb"];

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
    /** card = the live match card; result = the result picture posted once. */
    kind: text("kind").notNull().default("card"),
    /** Hash of the last rendered text, to skip no-op edits. */
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

// ---------------------------------------------------------------------------
// clubs — a venue page a club has claimed. Rows exist only for claimed clubs;
// unclaimed venues still render from their matches. The owner approves each
// claim once (one tap); until then the club's details stay private.
// ---------------------------------------------------------------------------
export type ClubFreeSlot = { start: string; end: string; free: number };
export type ClubAvailability = { fetchedAt: string; day: string; tz: string; slots: ClubFreeSlot[]; error: string | null; source: string };

export const clubs = pgTable(
  "clubs",
  {
    /** Same as the venue slug of the club's matches. */
    slug: text("slug").primaryKey(),
    name: text("name").notNull(),
    /** City slug (phuket, singapore) or null. */
    city: text("city"),
    tz: text("tz"),
    mapUrl: text("map_url"),
    website: text("website"),
    bookingUrl: text("booking_url"),
    /** Detected from booking_url: playtomic, matchi, playbypoint, … */
    bookingPlatform: text("booking_platform"),
    courts: integer("courts"),
    about: text("about"),
    opensAt: text("opens_at"),
    closesAt: text("closes_at"),
    /** Club opt-in: a calendar feed of bookings (.ics) or a JSON feed of free slots. */
    availabilityUrl: text("availability_url"),
    availabilityKind: text("availability_kind"),
    availability: jsonb("availability").$type<ClubAvailability>(),
    availabilityAt: timestamp("availability_at", { withTimezone: true }),
    /** The club's private manage link. */
    manageToken: text("manage_token").notNull(),
    claimedBy: uuid("claimed_by").references(() => players.id, { onDelete: "set null" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    /** One of the first clubs in its city: everything stays free for good. */
    founding: boolean("founding").notNull().default(false),
    /** The owner's Telegram message asking for approval. */
    notifyMessageId: bigint("notify_message_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("clubs_manage_token_idx").on(t.manageToken), index("clubs_city_idx").on(t.city), index("clubs_claimed_by_idx").on(t.claimedBy)],
);
export type Club = typeof clubs.$inferSelect;

// ---------------------------------------------------------------------------
// listen_items — public posts where people ask about organising padel, the
// reply we drafted, and what the owner decided. Nothing is posted without a
// human tap. Bodies are public text already; we keep no more than needed.
// ---------------------------------------------------------------------------
export const listenItems = pgTable(
  "listen_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    author: text("author"),
    /** Thing id or comment id the posting API needs (Reddit t3_/t1_, HN item id). */
    threadId: text("thread_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    /** new → drafted → approved → posted; or skipped / irrelevant / expired / failed. */
    status: text("status").notNull().default("new"),
    kind: text("kind"),
    language: text("language"),
    draft: text("draft"),
    draftReason: text("draft_reason"),
    draftModel: text("draft_model"),
    draftedAt: timestamp("drafted_at", { withTimezone: true }),
    /** The owner was asked on Telegram; message id of that DM. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notifyMessageId: bigint("notify_message_id", { mode: "number" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    postedReplyAt: timestamp("posted_reply_at", { withTimezone: true }),
    replyUrl: text("reply_url"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("listen_items_source_external_idx").on(t.source, t.externalId), index("listen_items_status_idx").on(t.status, t.postedAt)],
);
export type ListenItem = typeof listenItems.$inferSelect;

// ---------------------------------------------------------------------------
// answers — evergreen Q&A pages grown from replies the owner approved. Public,
// no personal data (the model rewrites the question generically), one-tap
// unpublish from the weekly digest or the desk.
// ---------------------------------------------------------------------------
export const answers = pgTable(
  "answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    language: text("language").notNull().default("en"),
    title: text("title").notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    sourceItemId: uuid("source_item_id").references(() => listenItems.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    unpublishedAt: timestamp("unpublished_at", { withTimezone: true }),
    /** The weekly digest mentioned this page (so it is offered for unpublish once). */
    digestedAt: timestamp("digested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("answers_slug_idx").on(t.slug), index("answers_published_idx").on(t.publishedAt)],
);
export type Answer = typeof answers.$inferSelect;

