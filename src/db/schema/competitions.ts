import { boolean, index, integer, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { players } from "./players";

// ---------------------------------------------------------------------------
// The serious tournament — the second engine, beside the rotation engine.
//
// A competition is a weekend (or a day) with categories; pairs enter a category,
// and a player enters at most two categories in the same competition. The rotation
// engine splits partners every round and keys on `events`; here a pair is the unit
// that plays, so it has its own row, and the draw (step 2) will hang off the pair.
// ---------------------------------------------------------------------------

export type CompetitionStatus = "open" | "closed";
export type PairStatus = "entered" | "waiting" | "withdrawn";

export const competitions = pgTable(
  "competitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Public page: /t/{slug}. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    organizerPlayerId: uuid("organizer_player_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    tz: text("tz").notNull(),
    venueName: text("venue_name"),
    venueSlug: text("venue_slug"),
    city: text("city"),
    /** Local dates, "YYYY-MM-DD" in tz: the first and the last day of play. */
    startsOn: text("starts_on").notNull(),
    endsOn: text("ends_on").notNull(),
    /** The fee and the ways to pay, as text: money never moves through Kicksmash (rule 22). */
    entryNote: text("entry_note"),
    status: text("status").$type<CompetitionStatus>().notNull().default("open"),
    /** How many categories one player may enter; FIP and the Thai series say two. */
    maxCategoriesPerPlayer: integer("max_categories_per_player").notNull().default(2),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("competitions_slug_idx").on(t.slug), index("competitions_organizer_idx").on(t.organizerPlayerId), index("competitions_dates_idx").on(t.status, t.endsOn)],
);

export const competitionCategories = pgTable(
  "competition_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    competitionId: uuid("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    /** "Pro", "Amateur", "Mixed", "Senior", "Gold 4.0+": whatever the organiser calls it. */
    name: text("name").notNull(),
    /** A level band, when the category is one. */
    levelMin: real("level_min"),
    levelMax: real("level_max"),
    /** The field: 8, 16 or 32 pairs in a main draw; more go on the waiting list. */
    maxPairs: integer("max_pairs").notNull().default(16),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("competition_categories_comp_idx").on(t.competitionId, t.position)],
);

export const competitionPairs = pgTable(
  "competition_pairs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => competitionCategories.id, { onDelete: "cascade" }),
    /** The category's competition, repeated so "two categories per player" is one indexed read. */
    competitionId: uuid("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    p1PlayerId: uuid("p1_player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    p2PlayerId: uuid("p2_player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    /** Set while the partner was entered by name: the link that lets them claim the spot. Null once claimed. */
    claimToken: text("claim_token"),
    status: text("status").$type<PairStatus>().notNull().default("entered"),
    /** Order of entry within the category; the waiting list moves up by it. */
    position: integer("position").notNull(),
    seed: integer("seed"),
    wildcard: boolean("wildcard").notNull().default(false),
    /** The organiser's mark; the fee itself is text on the competition. */
    paid: boolean("paid").notNull().default(false),
    enteredByPlayerId: uuid("entered_by_player_id").references(() => players.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (t) => [
    index("competition_pairs_category_idx").on(t.categoryId, t.status, t.position),
    index("competition_pairs_p1_idx").on(t.competitionId, t.p1PlayerId),
    index("competition_pairs_p2_idx").on(t.competitionId, t.p2PlayerId),
    uniqueIndex("competition_pairs_claim_idx").on(t.claimToken),
  ],
);

export type Competition = typeof competitions.$inferSelect;
export type CompetitionCategory = typeof competitionCategories.$inferSelect;
export type CompetitionPair = typeof competitionPairs.$inferSelect;
