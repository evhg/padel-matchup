// Running the thing: the fact log every view queries, the daily counts, the listening desk, the answers, the errors, the outreach, the feedback, the research cache.
import { bigint, date, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { players } from "./players";

/** Self-measured usage counters and daily snapshots for the read-only /admin dashboard. */
export const metricsDaily = pgTable("metrics_daily", {
  day: date("day").notNull(),
  key: text("key").notNull(),
  value: bigint("value", { mode: "number" }).notNull().default(0),
}, (t) => [primaryKey({ columns: [t.day, t.key] })]);

export type MetricRow = typeof metricsDaily.$inferSelect;

// ---------------------------------------------------------------------------
// listen_items — public posts where people ask about organising padel, the
// reply we drafted, and what the owner decided. Nothing is posted without a
// human tap. Bodies are public text already; we keep no more than needed.
// ---------------------------------------------------------------------------
export const listenItems = pgTable(
  "listen_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    author: text("author"),
    /** Thing id or comment id the posting API needs (Reddit t3_/t1_, HN item id). */
    threadId: text("thread_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    /** new → drafted → approved → posted; or skipped / irrelevant / expired / failed. */
    status: text("status").notNull().default("new"),
    kind: text("kind"),
    language: text("language"),
    draft: text("draft"),
    draftReason: text("draft_reason"),
    draftModel: text("draft_model"),
    draftedAt: timestamp("drafted_at", { withTimezone: true }),
    /** The owner was asked on Telegram; message id of that DM. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notifyMessageId: bigint("notify_message_id", { mode: "number" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    postedReplyAt: timestamp("posted_reply_at", { withTimezone: true }),
    replyUrl: text("reply_url"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("listen_items_source_external_idx").on(t.source, t.externalId), index("listen_items_status_idx").on(t.status, t.postedAt)],
);

export type ListenItem = typeof listenItems.$inferSelect;

// ---------------------------------------------------------------------------
// answers — evergreen Q&A pages grown from replies the owner approved. Public,
// no personal data (the model rewrites the question generically), one-tap
// unpublish from the weekly digest or the desk.
// ---------------------------------------------------------------------------
export const answers = pgTable(
  "answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    language: text("language").notNull().default("en"),
    title: text("title").notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    sourceItemId: uuid("source_item_id").references(() => listenItems.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    unpublishedAt: timestamp("unpublished_at", { withTimezone: true }),
    /** The weekly digest mentioned this page (so it is offered for unpublish once). */
    digestedAt: timestamp("digested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("answers_slug_idx").on(t.slug), index("answers_published_idx").on(t.publishedAt)],
);

export type Answer = typeof answers.$inferSelect;

/**
 * Production exceptions, one row per fingerprint: what broke, where, how often.
 * The daily fixer reads them at /api/admin/errors and marks what it shipped.
 */
export const errorEvents = pgTable(
  "error_events",
  {
    fingerprint: text("fingerprint").primaryKey(),
    /** server | client | cron */
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    stack: text("stack"),
    path: text("path"),
    count: integer("count").notNull().default(1),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when a fix shipped; a later lastAt means it came back. */
    fixedAt: timestamp("fixed_at", { withTimezone: true }),
    fixNote: text("fix_note"),
  },
  (t) => [index("error_events_last_idx").on(t.lastAt)],
);

export type ErrorEvent = typeof errorEvents.$inferSelect;

/**
 * The press desk: emails we propose to send from claude@<apex> (pitches and
 * replies), each waiting for the owner's tap, and the mail that comes back.
 */
export const outreach = pgTable(
  "outreach",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** pitch | reply | inbound */
    kind: text("kind").notNull(),
    /** press | clubs | builders | hn | other: which launch moment it belongs to */
    moment: text("moment"),
    /** The counterpart's address, lowercased: one thread per person. */
    threadKey: text("thread_key").notNull(),
    counterpartEmail: text("counterpart_email").notNull(),
    counterpartName: text("counterpart_name"),
    org: text("org"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    /** outbound: draft → approved → sent | skipped | failed; inbound: received */
    status: text("status").notNull().default("draft"),
    /** The owner is not asked before this moment (the launch calendar). */
    notBefore: timestamp("not_before", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notifyMessageId: bigint("notify_message_id", { mode: "number" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Resend's id for the sent or received email. */
    resendId: text("resend_id"),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("outreach_status_idx").on(t.status, t.createdAt), index("outreach_thread_idx").on(t.threadKey, t.createdAt), uniqueIndex("outreach_resend_idx").on(t.resendId)],
);

export type Outreach = typeof outreach.$inferSelect;

/**
 * What players tell us, where they told us, and what we did about it. The
 * owner gets a proposal (the verdict against docs/DECIDING.md, the change, a size and a
 * timeline estimate) the moment it is acknowledged, and decides what gets built.
 */
export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** telegram | discord | web | email */
    source: text("source").notNull(),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "set null" }),
    locale: text("locale").notNull().default("en"),
    name: text("name"),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }),
    telegramThreadId: integer("telegram_thread_id"),
    telegramMessageId: integer("telegram_message_id"),
    discordChannelId: text("discord_channel_id"),
    discordUserId: text("discord_user_id"),
    discordGuildId: text("discord_guild_id"),
    email: text("email"),
    emailMessageId: text("email_message_id"),
    text: text("text").notNull(),
    /** Page, match code or chat title, when known. */
    context: text("context"),
    /** new → acknowledged → asked | planned | shipped | declined */
    status: text("status").notNull().default("new"),
    /** adopt | decline | later | ask, set by the session the owner decides in */
    verdict: text("verdict"),
    /** Internal reasoning against the criteria; never shown to the person. */
    assessment: text("assessment"),
    replyText: text("reply_text"),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    prUrl: text("pr_url"),
    messagesSent: integer("messages_sent").notNull().default(0),
    /** "coach" when the author runs a lessons book; a coach's note is read first. */
    role: text("role"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("feedback_status_idx").on(t.status, t.createdAt), index("feedback_tg_user_idx").on(t.telegramUserId, t.createdAt)],
);

export type Feedback = typeof feedback.$inferSelect;

// ---------------------------------------------------------------------------
// Coaching: a coach's book. Lessons, students, packages with expiry, blocks,
// waitlists and managers. Round nine. No money moves here: the coach's own
// PromptPay QR or payment link is shown, and "paid" is a note the coach makes.
// ---------------------------------------------------------------------------

/** One row per query in `src/lib/research/queries.ts`: when it last ran and what it yielded. */
export const researchRuns = pgTable("research_runs", {
  key: text("key").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  runs: integer("runs").notNull().default(0),
  credits: integer("credits").notNull().default(0),
  results: integer("results").notNull().default(0),
  newItems: integer("new_items").notNull().default(0),
  /** Consecutive runs that found nothing new; stretches the query's interval. */
  emptyStreak: integer("empty_streak").notNull().default(0),
  lastError: text("last_error"),
});

export type ResearchRun = typeof researchRuns.$inferSelect;

/** A place the desk found on the web: a club, a coach, a tournament, a community. Contacts are public ones from the page itself. */
export const researchFinds = pgTable(
  "research_finds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** club | coach | tournament | community | other */
    kind: text("kind").notNull(),
    city: text("city"),
    url: text("url").notNull(),
    domain: text("domain").notNull(),
    title: text("title").notNull(),
    snippet: text("snippet").notNull().default(""),
    queryKey: text("query_key").notNull(),
    score: real("score"),
    emails: jsonb("emails").$type<string[]>().notNull().default([]),
    instagram: text("instagram"),
    phone: text("phone"),
    extractedAt: timestamp("extracted_at", { withTimezone: true }),
    seen: integer("seen").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** new | used | dismissed */
    status: text("status").notNull().default("new"),
    note: text("note"),
  },
  (t) => [uniqueIndex("research_finds_url_idx").on(t.url), index("research_finds_kind_city_idx").on(t.kind, t.city)],
);

export type ResearchFind = typeof researchFinds.$inferSelect;

/** Hand searches (answer grounding) are remembered for a week so the same question never costs twice. */
export const researchCache = pgTable("research_cache", {
  hash: text("hash").primaryKey(),
  query: text("query").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  credits: integer("credits").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ResearchCacheRow = typeof researchCache.$inferSelect;

// ---------------------------------------------------------------------------
// Club programme: the week a club fills once; every slot becomes a public match players run themselves
// ---------------------------------------------------------------------------

/**
 * The fact log: one append-only row per thing that happened, whoever did it and through whichever channel.
 * Every view of the data (the padel graph, demand by hour, coach retention, the funnel) is a query over it.
 * Subjects by id and code, actors by player id, the rest numbers and outcomes: never a name, an email or a token.
 */
export const facts = pgTable(
  "facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** Dotted, subject first: match.joined, lesson.cancelled. */
    kind: text("kind").notNull(),
    /** web, telegram, discord, line, api, mcp, cron, email, calendar. */
    channel: text("channel").notNull().default("web"),
    actorPlayerId: uuid("actor_player_id"),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** The subject's public handle: a match code, a coach handle, a club or series slug. */
    code: text("code"),
    city: text("city"),
    venueSlug: text("venue_slug"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index("facts_at_idx").on(t.at), index("facts_kind_at_idx").on(t.kind, t.at), index("facts_subject_idx").on(t.subjectType, t.subjectId), index("facts_actor_idx").on(t.actorPlayerId, t.at)],
);

export type Fact = typeof facts.$inferSelect;

// ---------------------------------------------------------------------------
// Level checks: a player asks a coach or a club to confirm their level; one tap confirms it
// ---------------------------------------------------------------------------
