// A match or a tournament, and everything that hangs off one: its seats, its score, its court, its log, its rounds, its photos, its series.
import { relations, sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";
import { type TournamentFormat, activityVerbEnum, eventStatusEnum, eventTypeEnum, joinRequestStatusEnum, slotKindEnum, slotStatusEnum, teamEnum, whenFullEnum } from "./enums";
import { players } from "./players";
import { groups } from "./groups";
import { clubSlots } from "./clubs";

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
    /** The second and last ask for a missing score, the morning after. One nudge is one roll of the dice. */
    scoreReminder2At: timestamp("score_reminder_2_at", { withTimezone: true }),
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
    index("events_club_slot_idx").on(t.clubSlotId),
    index("events_venue_slug_idx").on(t.venueSlug, t.startsAt),
    index("events_series_idx").on(t.seriesId, t.startsAt),
  ],
);

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

export type Event = typeof events.$inferSelect;

export type NewEvent = typeof events.$inferInsert;

export type Slot = typeof slots.$inferSelect;

export type Score = typeof scores.$inferSelect;

export type Venue = typeof venues.$inferSelect;

export type Activity = typeof activity.$inferSelect;

export type TournamentRound = typeof tournamentRounds.$inferSelect;

export type TournamentMatch = typeof tournamentMatches.$inferSelect;

export type EventType = Event["type"];

export type EventStatus = Event["status"];

export type SlotStatus = Slot["status"];

export type WhenFull = Event["whenFull"];

export type ActivityVerb = Activity["verb"];

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
