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
    /** Who confirmed: organizer (played with them), coach or club (a level check). */
    levelVerifiedSource: text("level_verified_source"),
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
    /** Verified levels only: a self-declared level inside the range still asks to join; a confirmed one walks in. */
    levelVerifiedOnly: boolean("level_verified_only").notNull().default(false),
    /** Result-based level adjustment ran for this event (once, on the organizer's finalize/confirm). */
    levelsAppliedAt: timestamp("levels_applied_at", { withTimezone: true }),
    /** The group this match belongs to (created from a group, or the group was formed from it). */
    groupId: uuid("group_id").references((): AnyPgColumn => groups.id, { onDelete: "set null" }),
    /** The club programme slot this match was created from (the club's weekly template), if any. */
    clubSlotId: uuid("club_slot_id").references((): AnyPgColumn => clubSlots.id, { onDelete: "set null" }),
    /** The series (an Open that repeats) this tournament is an edition of, if any. */
    seriesId: uuid("series_id").references((): AnyPgColumn => series.id, { onDelete: "set null" }),
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
    index("events_series_idx").on(t.seriesId, t.startsAt),
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
    /** The last month ("2026-09") whose wrap went to the claimant, so the 1st sends it once. */
    wrapSentFor: text("wrap_sent_for"),
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


/**
 * Production exceptions, one row per fingerprint: what broke, where, how often.
 * The daily fixer reads them at /api/admin/errors and marks what it shipped.
 */
export const errorEvents = pgTable(
  "error_events",
  {
    fingerprint: text("fingerprint").primaryKey(),
    /** server | client | cron */
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    stack: text("stack"),
    path: text("path"),
    count: integer("count").notNull().default(1),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when a fix shipped; a later lastAt means it came back. */
    fixedAt: timestamp("fixed_at", { withTimezone: true }),
    fixNote: text("fix_note"),
  },
  (t) => [index("error_events_last_idx").on(t.lastAt)],
);
export type ErrorEvent = typeof errorEvents.$inferSelect;

/**
 * The press desk: emails we propose to send from claude@<apex> (pitches and
 * replies), each waiting for the owner's tap, and the mail that comes back.
 */
export const outreach = pgTable(
  "outreach",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** pitch | reply | inbound */
    kind: text("kind").notNull(),
    /** press | clubs | builders | hn | other: which launch moment it belongs to */
    moment: text("moment"),
    /** The counterpart's address, lowercased: one thread per person. */
    threadKey: text("thread_key").notNull(),
    counterpartEmail: text("counterpart_email").notNull(),
    counterpartName: text("counterpart_name"),
    org: text("org"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    /** outbound: draft → approved → sent | skipped | failed; inbound: received */
    status: text("status").notNull().default("draft"),
    /** The owner is not asked before this moment (the launch calendar). */
    notBefore: timestamp("not_before", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notifyMessageId: bigint("notify_message_id", { mode: "number" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Resend's id for the sent or received email. */
    resendId: text("resend_id"),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("outreach_status_idx").on(t.status, t.createdAt), index("outreach_thread_idx").on(t.threadKey, t.createdAt), uniqueIndex("outreach_resend_idx").on(t.resendId)],
);
export type Outreach = typeof outreach.$inferSelect;

/**
 * What players tell us, where they told us, and what we did about it. The
 * daily session reads it, decides against docs/DECIDING.md, ships, and thanks
 * the person on the same channel. The owner is not in this loop.
 */
export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** telegram | discord | web | email */
    source: text("source").notNull(),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "set null" }),
    locale: text("locale").notNull().default("en"),
    name: text("name"),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }),
    telegramThreadId: integer("telegram_thread_id"),
    telegramMessageId: integer("telegram_message_id"),
    discordChannelId: text("discord_channel_id"),
    discordUserId: text("discord_user_id"),
    discordGuildId: text("discord_guild_id"),
    email: text("email"),
    emailMessageId: text("email_message_id"),
    text: text("text").notNull(),
    /** Page, match code or chat title, when known. */
    context: text("context"),
    /** new → acknowledged → asked | planned | shipped | declined */
    status: text("status").notNull().default("new"),
    /** adopt | decline | later | ask, set by the daily session */
    verdict: text("verdict"),
    /** Internal reasoning against the criteria; never shown to the person. */
    assessment: text("assessment"),
    replyText: text("reply_text"),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    prUrl: text("pr_url"),
    messagesSent: integer("messages_sent").notNull().default(0),
    /** "coach" when the author runs a lessons book; the daily session ranks those notes first. */
    role: text("role"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("feedback_status_idx").on(t.status, t.createdAt), index("feedback_tg_user_idx").on(t.telegramUserId, t.createdAt)],
);
export type Feedback = typeof feedback.$inferSelect;

// ---------------------------------------------------------------------------
// Coaching: a coach's book. Lessons, students, packages with expiry, blocks,
// waitlists and managers. Round nine. No money moves here: the coach's own
// PromptPay QR or payment link is shown, and "paid" is a note the coach makes.
// ---------------------------------------------------------------------------

export const coaches = pgTable(
  "coaches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    /** Public handle: /c/{handle}. Lowercase letters, digits and dashes. */
    handle: varchar("handle", { length: 32 }).notNull(),
    displayName: text("display_name").notNull(),
    bio: text("bio"),
    /** Club names, free text; an exclusive coach lists one. */
    clubNames: jsonb("club_names").$type<string[]>().notNull().default([]),
    languages: jsonb("languages").$type<string[]>().notNull().default(["en"]),
    lessonMinutes: integer("lesson_minutes").notNull().default(60),
    /** Weekly template in the coach's zone: { "1": [["07:00","12:00"],["15:00","20:00"]], … } (0 = Sunday). */
    hours: jsonb("hours").$type<Record<string, [string, string][]>>().notNull().default({}),
    tz: text("tz").notNull(),
    /** Hours before a lesson until which a student may cancel freely. */
    cutoffHours: integer("cutoff_hours").notNull().default(12),
    /** Free late cancellations per package before a late one counts. */
    latePasses: integer("late_passes").notNull().default(1),
    /** Shortest notice for a self-booked lesson, in hours. */
    minNoticeHours: integer("min_notice_hours").notNull().default(2),
    /** PromptPay phone or national id; a QR with the amount is rendered from it. */
    promptpayId: text("promptpay_id"),
    /** A payment link for coaches outside Thailand (Swish, Revolut, …). */
    payLink: text("pay_link"),
    /** An uploaded QR picture, when the coach prefers their bank's own. */
    qrAssetId: uuid("qr_asset_id"),
    /** Digits only, for wa.me links; never shown as a number. */
    whatsapp: text("whatsapp"),
    /** Listed on the public page, city list and sitemap. */
    isPublic: boolean("is_public").notNull().default(true),
    /** The coach's Google Calendar, shared with our service account: read for busy time, written with lessons. */
    gcalId: text("gcal_id"),
    /** linked | no_access | error, after the last check. */
    gcalStatus: text("gcal_status"),
    gcalCheckedAt: timestamp("gcal_checked_at", { withTimezone: true }),
    /** A secret iCal address (Apple, Outlook, Google without sharing): read-only busy time. */
    icalUrl: text("ical_url"),
    calendarSyncedAt: timestamp("calendar_synced_at", { withTimezone: true }),
    calendarError: text("calendar_error"),
    /** Short code in the link a coach hands the person who runs their bookings. */
    managerCode: text("manager_code"),
    /** Code in the link a coach sends their students: opening it puts the student on the list, no asking. */
    inviteCode: text("invite_code"),
    /** The last month ("2026-09") whose wrap went out, so the 1st sends it once. */
    wrapSentFor: text("wrap_sent_for"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("coaches_handle_idx").on(t.handle), uniqueIndex("coaches_player_idx").on(t.playerId), uniqueIndex("coaches_invite_code_idx").on(t.inviteCode)],
);
export type Coach = typeof coaches.$inferSelect;

/** Small pictures a coach uploads (their bank's QR). One row per picture, base64, capped in code. */
export const coachAssets = pgTable(
  "coach_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id")
      .notNull()
      .references(() => coaches.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("qr"),
    mime: text("mime").notNull(),
    dataBase64: text("data_base64").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("coach_assets_coach_idx").on(t.coachId)],
);

export const coachStudents = pgTable(
  "coach_students",
  {
    coachId: uuid("coach_id")
      .notNull()
      .references(() => coaches.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    /** requested → accepted; paused keeps the history but stops self-booking. */
    status: text("status").notNull().default("requested"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.coachId, t.playerId] }), index("coach_students_player_idx").on(t.playerId)],
);
export type CoachStudent = typeof coachStudents.$inferSelect;

export const lessonPackages = pgTable(
  "lesson_packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id")
      .notNull()
      .references(() => coaches.id, { onDelete: "cascade" }),
    studentPlayerId: uuid("student_player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    size: integer("size").notNull(),
    used: integer("used").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Whole currency units (THB has no minor unit in practice). */
    amount: integer("amount"),
    currency: text("currency").notNull().default("THB"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    latePassesUsed: integer("late_passes_used").notNull().default(0),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** The one "two lessons left / expires in a week" note, once sent. */
    lowRemindedAt: timestamp("low_reminded_at", { withTimezone: true }),
  },
  (t) => [index("lesson_packages_student_idx").on(t.coachId, t.studentPlayerId, t.createdAt)],
);
export type LessonPackage = typeof lessonPackages.$inferSelect;

export const lessons = pgTable(
  "lessons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id")
      .notNull()
      .references(() => coaches.id, { onDelete: "cascade" }),
    studentPlayerId: uuid("student_player_id").references(() => players.id, { onDelete: "set null" }),
    packageId: uuid("package_id").references(() => lessonPackages.id, { onDelete: "set null" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    minutes: integer("minutes").notNull(),
    /** booked → done | cancelled (by the coach) | cancelled_by_student | late_cancelled | no_show */
    status: text("status").notNull().default("booked"),
    kind: text("kind").notNull().default("private"),
    /** web | telegram | calendar | import | api */
    source: text("source").notNull().default("web"),
    /** Whether the booking consumed a package lesson (refunded on a timely cancellation). */
    consumed: boolean("consumed").notNull().default(false),
    /** A late cancellation forgiven by a free pass. */
    freePass: boolean("free_pass").notNull().default(false),
    note: text("note"),
    /** Event id in the coach's calendar, once attached. */
    externalId: text("external_id"),
    createdByPlayerId: uuid("created_by_player_id").references(() => players.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /** The one "tomorrow at 15:00" reminder, once sent. */
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
  },
  (t) => [index("lessons_coach_time_idx").on(t.coachId, t.startsAt), index("lessons_student_idx").on(t.studentPlayerId, t.startsAt), index("lessons_external_idx").on(t.coachId, t.externalId)],
);
export type Lesson = typeof lessons.$inferSelect;

export const coachBlocks = pgTable(
  "coach_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id")
      .notNull()
      .references(() => coaches.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    /** web | telegram | gcal | ical: blocks from a calendar are replaced on every sync. */
    source: text("source").notNull().default("web"),
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("coach_blocks_coach_time_idx").on(t.coachId, t.startsAt), index("coach_blocks_external_idx").on(t.coachId, t.externalId)],
);
export type CoachBlock = typeof coachBlocks.$inferSelect;

export const lessonWaitlist = pgTable(
  "lesson_waitlist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id")
      .notNull()
      .references(() => coaches.id, { onDelete: "cascade" }),
    studentPlayerId: uuid("student_player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    /** A specific slot, or null for "any slot in the week starting weekStart". */
    slotStartsAt: timestamp("slot_starts_at", { withTimezone: true }),
    weekStart: date("week_start"),
    /** waiting → offered → booked | expired | withdrawn */
    status: text("status").notNull().default("waiting"),
    offeredAt: timestamp("offered_at", { withTimezone: true }),
    offerExpiresAt: timestamp("offer_expires_at", { withTimezone: true }),
    offeredLessonId: uuid("offered_lesson_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("lesson_waitlist_coach_idx").on(t.coachId, t.status, t.createdAt)],
);
export type LessonWaitlistEntry = typeof lessonWaitlist.$inferSelect;

export const coachManagers = pgTable(
  "coach_managers",
  {
    coachId: uuid("coach_id")
      .notNull()
      .references(() => coaches.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.coachId, t.playerId] })],
);

/** A student asks for a time outside the coach's hours; the coach answers with one tap. */
export const lessonRequests = pgTable(
  "lesson_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    coachId: uuid("coach_id")
      .notNull()
      .references(() => coaches.id, { onDelete: "cascade" }),
    studentPlayerId: uuid("student_player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    minutes: integer("minutes").notNull(),
    note: text("note"),
    /** open → accepted | declined | expired */
    status: text("status").notNull().default("open"),
    lessonId: uuid("lesson_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("lesson_requests_coach_idx").on(t.coachId, t.status, t.startsAt)],
);
export type LessonRequest = typeof lessonRequests.$inferSelect;
export type LessonWaitlistRow = typeof lessonWaitlist.$inferSelect;

export const coachesRelations = relations(coaches, ({ one, many }) => ({
  player: one(players, { fields: [coaches.playerId], references: [players.id] }),
  students: many(coachStudents),
  lessons: many(lessons),
}));
export const coachStudentsRelations = relations(coachStudents, ({ one }) => ({
  coach: one(coaches, { fields: [coachStudents.coachId], references: [coaches.id] }),
  player: one(players, { fields: [coachStudents.playerId], references: [players.id] }),
}));
export const lessonsRelations = relations(lessons, ({ one }) => ({
  coach: one(coaches, { fields: [lessons.coachId], references: [coaches.id] }),
  student: one(players, { fields: [lessons.studentPlayerId], references: [players.id] }),
  package: one(lessonPackages, { fields: [lessons.packageId], references: [lessonPackages.id] }),
}));
export const lessonPackagesRelations = relations(lessonPackages, ({ one }) => ({
  coach: one(coaches, { fields: [lessonPackages.coachId], references: [coaches.id] }),
  student: one(players, { fields: [lessonPackages.studentPlayerId], references: [players.id] }),
}));

// ---------------------------------------------------------------------------
// After the match, worth sharing: the court photo behind the result, and earned moments.
// ---------------------------------------------------------------------------
/** One court photo per match, added by any participant; the result card becomes that photo with a quiet layer. */
export const eventPhotos = pgTable(
  "event_photos",
  {
    eventId: uuid("event_id")
      .primaryKey()
      .references(() => events.id, { onDelete: "cascade" }),
    uploadedByPlayerId: uuid("uploaded_by_player_id").references(() => players.id, { onDelete: "set null" }),
    mime: text("mime").notNull(),
    dataBase64: text("data_base64").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
export type EventPhoto = typeof eventPhotos.$inferSelect;

/** A moment a player earned: first win, tenth match, a streak, a podium, a level up. Rare on purpose, announced once. */
export const milestones = pgTable(
  "milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    /** first_win | matches_10 | matches_50 | streak_3 | partners_10 | level_up | podium */
    kind: text("kind").notNull(),
    /** What the kind counts: 10, 50, the new band, the placement. */
    value: text("value").notNull().default(""),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("milestones_once_idx").on(t.playerId, t.kind, t.value), index("milestones_player_idx").on(t.playerId, t.createdAt)],
);
export type Milestone = typeof milestones.$inferSelect;

// ---------------------------------------------------------------------------
// Research desk: paced web search (Tavily) for listening, discovery and grounding
// ---------------------------------------------------------------------------

/** One row per query in `src/lib/research/queries.ts`: when it last ran and what it yielded. */
export const researchRuns = pgTable("research_runs", {
  key: text("key").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  runs: integer("runs").notNull().default(0),
  credits: integer("credits").notNull().default(0),
  results: integer("results").notNull().default(0),
  newItems: integer("new_items").notNull().default(0),
  /** Consecutive runs that found nothing new; stretches the query's interval. */
  emptyStreak: integer("empty_streak").notNull().default(0),
  lastError: text("last_error"),
});
export type ResearchRun = typeof researchRuns.$inferSelect;

/** A place the desk found on the web: a club, a coach, a tournament, a community. Contacts are public ones from the page itself. */
export const researchFinds = pgTable(
  "research_finds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** club | coach | tournament | community | other */
    kind: text("kind").notNull(),
    city: text("city"),
    url: text("url").notNull(),
    domain: text("domain").notNull(),
    title: text("title").notNull(),
    snippet: text("snippet").notNull().default(""),
    queryKey: text("query_key").notNull(),
    score: real("score"),
    emails: jsonb("emails").$type<string[]>().notNull().default([]),
    instagram: text("instagram"),
    phone: text("phone"),
    extractedAt: timestamp("extracted_at", { withTimezone: true }),
    seen: integer("seen").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** new | used | dismissed */
    status: text("status").notNull().default("new"),
    note: text("note"),
  },
  (t) => [uniqueIndex("research_finds_url_idx").on(t.url), index("research_finds_kind_city_idx").on(t.kind, t.city)],
);
export type ResearchFind = typeof researchFinds.$inferSelect;

/** Hand searches (answer grounding) are remembered for a week so the same question never costs twice. */
export const researchCache = pgTable("research_cache", {
  hash: text("hash").primaryKey(),
  query: text("query").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  credits: integer("credits").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type ResearchCacheRow = typeof researchCache.$inferSelect;

// ---------------------------------------------------------------------------
// Club programme: the week a club fills once; every slot becomes a public match players run themselves
// ---------------------------------------------------------------------------

export const clubSlots = pgTable(
  "club_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubSlug: text("club_slug")
      .notNull()
      .references(() => clubs.slug, { onDelete: "cascade" }),
    /** 0 = Sunday … 6 = Saturday, "HH:MM" in the club's zone. */
    dow: integer("dow").notNull(),
    time: text("time").notNull(),
    /** match | tournament */
    type: text("type").notNull().default("match"),
    /** americano | mexicano | king; null for a match. */
    format: text("format"),
    capacity: integer("capacity").notNull().default(4),
    courts: integer("courts"),
    levelMin: real("level_min"),
    levelMax: real("level_max"),
    /** The matches made from this slot take confirmed levels only (see events.level_verified_only). */
    verifiedOnly: boolean("verified_only").notNull().default(false),
    /** "Ladies social", "Gold night"; shown as the match title. */
    title: text("title"),
    /** The match appears on the page this many days ahead. */
    leadDays: integer("lead_days").notNull().default(6),
    whenFull: text("when_full").notNull().default("waitlist"),
    cost: text("cost"),
    active: boolean("active").notNull().default(true),
    lastCreatedFor: timestamp("last_created_for", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("club_slots_club_idx").on(t.clubSlug)],
);
export type ClubSlot = typeof clubSlots.$inferSelect;

// ---------------------------------------------------------------------------
// Series: an Open that repeats. The organizer sets the rhythm once; every edition makes itself, lists itself and closes itself (rule 22)
// ---------------------------------------------------------------------------

export const seriesRhythms = ["week", "fortnight", "month"] as const;
export type SeriesRhythm = (typeof seriesRhythms)[number];

export const series = pgTable(
  "series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Public page: /s/{slug}. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    organizerPlayerId: uuid("organizer_player_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    tz: text("tz").notNull(),
    venueName: text("venue_name"),
    venueMapUrl: text("venue_map_url"),
    venueSlug: text("venue_slug"),
    /** The template every edition is made from: the tournament it started as. */
    format: text("format").$type<TournamentFormat>().notNull().default("americano"),
    capacity: integer("capacity").notNull(),
    courts: integer("courts"),
    pointsPerMatch: integer("points_per_match"),
    courtNames: jsonb("court_names").$type<string[]>(),
    levelMin: real("level_min"),
    levelMax: real("level_max"),
    levelVerifiedOnly: boolean("level_verified_only").notNull().default(false),
    whenFull: text("when_full").notNull().default("waitlist"),
    cost: text("cost"),
    bookingUrl: text("booking_url"),
    /** The rhythm: weekday (0 = Sunday) and "HH:MM" in tz; every week, fortnight or month. */
    dow: integer("dow").notNull(),
    time: text("time").notNull(),
    every: text("every").$type<SeriesRhythm>().notNull().default("week"),
    /** For a monthly series: which weekday of the month (1–4, 5 = the last). */
    nth: integer("nth"),
    /** The first edition: fixes a fortnight's parity. */
    anchorAt: timestamp("anchor_at", { withTimezone: true }).notNull(),
    /** The next edition appears this many days ahead. */
    leadDays: integer("lead_days").notNull().default(6),
    active: boolean("active").notNull().default(true),
    lastCreatedFor: timestamp("last_created_for", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("series_slug_idx").on(t.slug), index("series_organizer_idx").on(t.organizerPlayerId), index("series_venue_idx").on(t.venueSlug)],
);
export type Series = typeof series.$inferSelect;

// ---------------------------------------------------------------------------
// Level checks: a player asks a coach or a club to confirm their level; one tap confirms it
// ---------------------------------------------------------------------------

export const levelChecks = pgTable(
  "level_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    /** Exactly one of the two: the coach asked, or the club asked. */
    coachId: uuid("coach_id").references(() => coaches.id, { onDelete: "cascade" }),
    clubSlug: text("club_slug").references(() => clubs.slug, { onDelete: "cascade" }),
    /** The player's level when they asked. */
    level: real("level"),
    /** The match the player was trying to join, if any (so the answer can point back to it). */
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    /** pending | confirmed | declined | withdrawn */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByPlayerId: uuid("decided_by_player_id").references(() => players.id, { onDelete: "set null" }),
    /** The level the verifier confirmed (may differ from what the player declared). */
    decidedLevel: real("decided_level"),
  },
  (t) => [index("level_checks_player_idx").on(t.playerId), index("level_checks_coach_idx").on(t.coachId), index("level_checks_club_idx").on(t.clubSlug)],
);
export type LevelCheck = typeof levelChecks.$inferSelect;
