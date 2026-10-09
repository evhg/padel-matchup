// A crew that plays together, with a weekly slot of its own.
import { boolean, index, integer, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { eventTypeEnum, groupRoleEnum, joinRequestStatusEnum, whenFullEnum } from "./enums";
import { players } from "./players";

// ---------------------------------------------------------------------------
// groups — a crew that plays together. Any member creates the next match; an
// optional weekly slot creates it automatically a few days ahead.
// ---------------------------------------------------------------------------
export const groups = pgTable(
  "groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Public 6-char code: /g/{code}. Anyone with the link can join, or ask to when `askToJoin` is on. */
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
    /**
     * New people ask and an admin says yes (a ladies' crew, a level crew), instead of one tap in.
     * The owner's decision E, 9 October 2026. Off is the old door, for every caller.
     */
    askToJoin: boolean("ask_to_join").notNull().default(false),
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

/**
 * Asks to join a group that has `askToJoin` on; an admin approves or declines. The mirror of
 * `join_requests` for a match, with the same four statuses.
 *
 * One row per person and group, for ever: a second ask reopens the same row rather than adding one.
 * A withdrawn ask (or an approved one, when the member later left or was removed) reopens at once. A
 * declined ask reopens only once `ASK_AGAIN_DAYS` (seven) have passed since the decision, counted
 * from `decided_at`; before then the person sees the kind "not this time" and nothing reaches the
 * admins (`nextAsk` in `src/lib/domain/groupAccess.ts`). The note is the person's own words for
 * the admins, at most 200 characters, and never leaves the group page's admin view.
 */
export const groupRequests = pgTable(
  "group_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    note: text("note"),
    status: joinRequestStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByPlayerId: uuid("decided_by_player_id").references(() => players.id, { onDelete: "set null" }),
  },
  (t) => [uniqueIndex("group_requests_group_player_idx").on(t.groupId, t.playerId), index("group_requests_group_status_idx").on(t.groupId, t.status)],
);

export type Group = typeof groups.$inferSelect;

export type GroupRequest = typeof groupRequests.$inferSelect;

export type GroupMember = typeof groupMembers.$inferSelect;
