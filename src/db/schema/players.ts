// A person: identity without an account, the ways to reach them, the level someone confirmed, the moments they earned.
import { relations, sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { type LevelLogEntry } from "./enums";
import { events, slots } from "./events";
import { clubs } from "./clubs";
import { coaches } from "./coaching";

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
// Relations (for db.query.*)
// ---------------------------------------------------------------------------
export const playersRelations = relations(players, ({ many }) => ({
  slots: many(slots),
  events: many(events),
}));

/** Addresses that asked never to be emailed by organizers again (invites, reminders). */
export const emailOptOuts = pgTable("email_opt_outs", {
  email: text("email").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Player = typeof players.$inferSelect;

export type EmailCode = typeof emailCodes.$inferSelect;

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
  (t) => [
    index("level_checks_player_idx").on(t.playerId),
    index("level_checks_coach_idx").on(t.coachId),
    index("level_checks_club_idx").on(t.clubSlug),
    // One open ask per player and verifier, even when two taps land at once.
    uniqueIndex("level_checks_pending_coach_uq").on(t.playerId, t.coachId).where(sql`${t.status} = 'pending'`),
    uniqueIndex("level_checks_pending_club_uq").on(t.playerId, t.clubSlug).where(sql`${t.status} = 'pending'`),
  ],
);

export type LevelCheck = typeof levelChecks.$inferSelect;
