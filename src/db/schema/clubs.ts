// A claimed club, and the weekly programme that fills its quiet hours.
import { bigint, boolean, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { players } from "./players";

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
    /** City slug (phuket, singapore) or null. Only cities with a page of their own; most clubs have none. */
    city: text("city"),
    /**
     * Where the club is, for a picker that has to work outside the two cities that have pages.
     * `country` is an ISO 3166-1 alpha-2 code ("TH", "SG"); `province` is what a person there would
     * call it ("Phuket", "Bangkok", "Chiang Mai", "Singapore"), not a code.
     */
    country: text("country"),
    province: text("province"),
    tz: text("tz"),
    mapUrl: text("map_url"),
    website: text("website"),
    bookingUrl: text("booking_url"),
    /** Detected from booking_url: playtomic, matchi, playbypoint, … */
    bookingPlatform: text("booking_platform"),
    courts: integer("courts"),
    /** The same total, split: an indoor court in Bangkok in April is a different thing from an outdoor one. Either may be null when no source said. */
    courtsIndoor: integer("courts_indoor"),
    courtsOutdoor: integer("courts_outdoor"),
    about: text("about"),
    opensAt: text("opens_at"),
    closesAt: text("closes_at"),
    /** Club opt-in: a calendar feed of bookings (.ics) or a JSON feed of free slots. */
    availabilityUrl: text("availability_url"),
    availabilityKind: text("availability_kind"),
    availability: jsonb("availability").$type<ClubAvailability>(),
    availabilityAt: timestamp("availability_at", { withTimezone: true }),
    /**
     * "claim" — somebody claimed this page and it is theirs to manage.
     * "directory" — Kicksmash listed the club from public sources so a player can pick it by name.
     *
     * A directory row is listed and never says it is managed by anybody: no `claimedBy`, no
     * `approvedAt`. When its real owner claims it, the row becomes theirs and this becomes "claim".
     */
    source: text("source").notNull().default("claim"),
    /** The club's private manage link. */
    manageToken: text("manage_token").notNull(),
    claimedBy: uuid("claimed_by").references(() => players.id, { onDelete: "set null" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * The claim's check. Who the claimant says they are at the club (owner, manager, staff, coach) and
     * how the club can confirm it: a work email or the club's phone. A work email at the club's own
     * domain is confirmed by a 6-digit code (`claim_verified_at`); anything else the owner checks by
     * hand before the tap that makes the page live. Nothing of a pending claim shows to anyone else.
     */
    claimRole: text("claim_role"),
    claimContact: text("claim_contact"),
    claimVerifiedAt: timestamp("claim_verified_at", { withTimezone: true }),
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
  (t) => [uniqueIndex("clubs_manage_token_idx").on(t.manageToken), index("clubs_city_idx").on(t.city), index("clubs_claimed_by_idx").on(t.claimedBy), index("clubs_place_idx").on(t.country, t.province, t.name)],
);

export type Club = typeof clubs.$inferSelect;

// ---------------------------------------------------------------------------
// club_courts — the club's courts one by one, as the club names them. A match names one of them in
// `events.court`; the three counts on `clubs` are kept in step from these rows, so every reader of
// the counts (the badge, the API, the picker) stays right without learning this table.
// ---------------------------------------------------------------------------
export const clubCourts = pgTable(
  "club_courts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubSlug: text("club_slug")
      .notNull()
      .references(() => clubs.slug, { onDelete: "cascade" }),
    /** "Court 1", "Centre", "Pista 3": what the club calls it, and what a match at the club names. */
    name: text("name").notNull(),
    /** Its number when the club numbers them ("Court 3" → 3); null for a court with only a name. */
    number: integer("number"),
    /** indoor | outdoor; null when the club has not said. */
    kind: text("kind"),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("club_courts_club_idx").on(t.clubSlug, t.position), uniqueIndex("club_courts_name_idx").on(t.clubSlug, t.name)],
);

export type ClubCourt = typeof clubCourts.$inferSelect;
export type CourtKind = "indoor" | "outdoor";

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
