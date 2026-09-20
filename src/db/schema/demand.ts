import { date, index, pgTable, real, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { players } from "./players";

/**
 * What a player wants, so the app stops waiting for somebody else to post it.
 *
 * Everything else here records supply: a match exists, and people join it. The thing a player cannot
 * do today is the thing they actually do — say "I want to play Tuesday at two near Rawai" and be told
 * when it happens. One row is one standing want, and it is deliberately vague: a weekday or a single
 * date, a window or any hour, a venue or a whole city. Vague is the point, because a want that has to
 * be exact is a booking, and bookings already work.
 *
 * It expires on purpose. A want nobody matched in a month is not a want any more, and an unbounded
 * table of stale ones would make every match creation slower for nothing (rule 12).
 */
export const demandSignals = pgTable(
  "demand_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id").notNull(),
    /** 0 = Sunday, matching the coach's weekly template. Null means any day. */
    weekday: smallint("weekday"),
    /** Set when the want is for one date only; then `weekday` is null, and the row dies with the day. */
    onDate: date("on_date"),
    /** "14:00". Both null means any hour that day; one null is open at that end. */
    fromTime: text("from_time"),
    toTime: text("to_time"),
    /** Where. A court, a city, or both — a want with neither could match a match on another continent. */
    venueSlug: text("venue_slug"),
    citySlug: text("city_slug"),
    /** The last time a match was put in front of this want. One want must not buzz every hour. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The two shapes the matcher asks for, both narrowed by the expiry so dead rows are never scanned.
    index("demand_venue_idx").on(t.venueSlug, t.expiresAt),
    index("demand_city_idx").on(t.citySlug, t.expiresAt),
    // One player's own list, and the cap that stops anyone collecting hundreds.
    index("demand_player_idx").on(t.playerId, t.expiresAt),
  ],
);

/** A want as the app reads it back. */
export type DemandSignal = typeof demandSignals.$inferSelect;

// ---------------------------------------------------------------------------
// coach_wants — "I want a coach in this city". One row per person per city: the level and a few
// words on when. It counts on the coaches' door, hears the first coach who lists there, and dies
// after three months. The other half of the coaches' directory: demand, where the list is supply.
// ---------------------------------------------------------------------------
export const coachWants = pgTable(
  "coach_wants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    /** A city with a page (phuket, singapore): the coaches' list it belongs under. */
    citySlug: text("city_slug").notNull(),
    /** 0 to 7 in halves, or null when they did not say. */
    level: real("level"),
    /** "evenings, weekends": free words, at most eighty characters. */
    whenNote: text("when_note"),
    /** The last time a listing was put in front of this want: one want does not hear every coach every day. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("coach_wants_player_city_idx").on(t.playerId, t.citySlug), index("coach_wants_city_idx").on(t.citySlug, t.expiresAt)],
);

export type CoachWant = typeof coachWants.$inferSelect;
