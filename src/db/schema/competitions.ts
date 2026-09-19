import { boolean, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
/** Groups then a knockout among the top of each group (the Thai series), or a straight knockout (FIP main draws). */
export type CategoryFormat = "groups_knockout" | "knockout";
export type DrawStatus = "none" | "drawn" | "published" | "done";
export type MatchPhase = "qualifying" | "group" | "main" | "consolation";
export type MatchStatus = "pending" | "scheduled" | "live" | "done" | "walkover";

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
    /** The courts the schedule uses, by name. */
    courtNames: jsonb("court_names").$type<string[]>(),
    /** The day's window for play, "HH:MM" local. */
    dayStart: text("day_start"),
    dayEnd: text("day_end"),
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
    format: text("format").$type<CategoryFormat>().notNull().default("groups_knockout"),
    /** Groups of four or five; the top N of each go through, the rest to the consolation draw. */
    groupSize: integer("group_size").notNull().default(4),
    groupsThrough: integer("groups_through").notNull().default(2),
    consolation: boolean("consolation").notNull().default(true),
    /** Main-draw spots decided by a qualifying knockout among the pairs past the direct entries; 0 for none. */
    qualifyingSpots: integer("qualifying_spots").notNull().default(0),
    /** Scoring per phase (see `SCORING` in domain/draw.ts): the groups, the rounds before the final, the final. */
    scoringGroup: text("scoring_group").notNull().default("set6tb"),
    scoringKnockout: text("scoring_knockout").notNull().default("set9"),
    scoringFinal: text("scoring_final").notNull().default("sets2stb"),
    goldenPoint: boolean("golden_point").notNull().default(true),
    drawStatus: text("draw_status").$type<DrawStatus>().notNull().default("none"),
    drawnAt: timestamp("drawn_at", { withTimezone: true }),
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
    /** The desk's mark on the day; a pair not checked in by its first match is the organiser's call. */
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
  },
  (t) => [
    index("competition_pairs_category_idx").on(t.categoryId, t.status, t.position),
    index("competition_pairs_p1_idx").on(t.competitionId, t.p1PlayerId),
    index("competition_pairs_p2_idx").on(t.competitionId, t.p2PlayerId),
    uniqueIndex("competition_pairs_claim_idx").on(t.claimToken),
  ],
);

/**
 * One match of a category's draw. The draw is generated whole: the qualifying, the groups, the
 * knockout skeleton and the consolation skeleton, with `source_a`/`source_b` naming where a side
 * comes from ("Q:1", "G:A:2", "W:main:1:3", "L:main:1:3") until a result fills the pair in.
 * The court, the time and the stream link are the next steps' columns, here so the table is
 * made once.
 */
export const competitionMatches = pgTable(
  "competition_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => competitionCategories.id, { onDelete: "cascade" }),
    competitionId: uuid("competition_id")
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    phase: text("phase").$type<MatchPhase>().notNull(),
    groupLabel: text("group_label"),
    /** 1 is the first round of the phase; the last round of a knockout is its final. */
    round: integer("round").notNull(),
    position: integer("position").notNull(),
    pairAId: uuid("pair_a_id").references(() => competitionPairs.id, { onDelete: "set null" }),
    pairBId: uuid("pair_b_id").references(() => competitionPairs.id, { onDelete: "set null" }),
    sourceA: text("source_a"),
    sourceB: text("source_b"),
    /** A slot nobody fills: the other side goes through without playing. */
    bye: boolean("bye").notNull().default(false),
    /** Games per set, side A and side B: [6, 4] and [3, 6] is one set each. */
    scoreA: jsonb("score_a").$type<number[]>(),
    scoreB: jsonb("score_b").$type<number[]>(),
    winner: text("winner").$type<"A" | "B">(),
    status: text("status").$type<MatchStatus>().notNull().default("pending"),
    courtName: text("court_name"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    /** The fifteen-minute notice went, once. */
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    streamUrl: text("stream_url"),
    enteredByPlayerId: uuid("entered_by_player_id").references(() => players.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("competition_matches_category_idx").on(t.categoryId, t.phase, t.round, t.position),
    index("competition_matches_schedule_idx").on(t.competitionId, t.scheduledAt),
    index("competition_matches_pair_a_idx").on(t.pairAId),
    index("competition_matches_pair_b_idx").on(t.pairBId),
  ],
);

export type Competition = typeof competitions.$inferSelect;
export type CompetitionMatch = typeof competitionMatches.$inferSelect;
export type CompetitionCategory = typeof competitionCategories.$inferSelect;
export type CompetitionPair = typeof competitionPairs.$inferSelect;
