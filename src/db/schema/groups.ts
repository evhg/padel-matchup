// A crew that plays together, with a weekly slot of its own.
import { index, integer, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { eventTypeEnum, groupRoleEnum, whenFullEnum } from "./enums";
import { players } from "./players";

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
