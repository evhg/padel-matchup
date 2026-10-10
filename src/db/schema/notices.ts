// The inbox: every notice the app sent a player, or held for them, kept for ninety days.
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { NoticeKind, NoticeParams } from "@/lib/domain/noticeKinds";
import { events } from "./events";
import { players } from "./players";

// ---------------------------------------------------------------------------
// notices — one row per notice to one player (the owner's decision D, 9 October 2026).
//
// Written before the notice is delivered, one batched insert for a fan-out, so nothing the app
// said is lost: a kind the player switched off is kept here and never sent, a notice inside their
// quiet hours waits here (`due_at`) for the hourly job's one short summary. The row holds a message
// key and its params, never words in one language, so My matches renders it in the reader's own;
// and never a link, because a personal link signs its reader in (`cleanParams`).
// ---------------------------------------------------------------------------
export const notices = pgTable(
  "notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    kind: text("kind").$type<NoticeKind>().notNull(),
    /** The match it is about, when it is about one; a match deleted later leaves the notice. */
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    /** `noticeItem.<sender>` in messages/*.json. */
    key: text("key").notNull(),
    params: jsonb("params").$type<NoticeParams>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When it left on the player's channels. Null: held by quiet hours (see `due_at`), or a kind switched off. */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** A held notice: the end of the player's quiet hours, when the summary goes. Null for everything else. */
    dueAt: timestamp("due_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    // The inbox: one player's latest, newest first, and the unread count beside My matches.
    index("notices_player_created_idx").on(t.playerId, t.createdAt.desc()),
    // The queue: what quiet hours hold, read by the hourly job once their end has passed.
    index("notices_due_idx")
      .on(t.dueAt)
      .where(sql`${t.deliveredAt} is null and ${t.dueAt} is not null`),
    // The prune: rows older than ninety days, a bounded batch an hour.
    index("notices_created_idx").on(t.createdAt),
  ],
);

export type Notice = typeof notices.$inferSelect;
