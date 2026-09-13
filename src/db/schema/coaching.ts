// A coach's book: their students, their packages, the lessons, the hours they block, the queue for a spot.
import { relations } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { players } from "./players";

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
    /** The same clubs as venue slugs, when the coach picked them from the list rather than typing. */
    clubSlugs: jsonb("club_slugs").$type<string[]>().notNull().default([]),
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
    /** What one lesson costs when it is not drawn from a package, in whole currency units. Null: this coach sells packages only. */
    priceSingle: integer("price_single"),
    /** The currency every price and package amount of this coach is in. */
    currency: text("currency").notNull().default("THB"),
    /** The coach takes cash or a card at the club: a payment method with nothing to show but a sentence. */
    payAtClub: boolean("pay_at_club").notNull().default(false),
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
    /** Among the first ten listed coaches of their city when they listed: earned once, never taken back. */
    foundingAt: timestamp("founding_at", { withTimezone: true }),
    /** The city (time zone) the place was earned in; a coach who moves city does not carry it. */
    foundingTz: text("founding_tz"),
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
    /** What this lesson costs, taken from the coach's price when it was booked so a later price change never rewrites it. Only for lessons no package paid for. */
    amount: integer("amount"),
    /** The student says they have paid. A claim, not a status: it asks the coach, it does not answer. */
    paidClaimedAt: timestamp("paid_claimed_at", { withTimezone: true }),
    /** The coach confirmed the money arrived. Nothing but a coach's tap sets this. */
    paidAt: timestamp("paid_at", { withTimezone: true }),
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
