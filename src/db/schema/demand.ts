import { date, index, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
