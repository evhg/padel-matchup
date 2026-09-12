// The enumerated types every other file draws on, and the two shared shapes.
import { pgEnum } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const eventTypeEnum = pgEnum("event_type", ["match", "tournament"]);

export const whenFullEnum = pgEnum("when_full", ["waitlist", "closed"]);

export const eventStatusEnum = pgEnum("event_status", ["open", "full", "cancelled", "past"]);

export const slotKindEnum = pgEnum("slot_kind", ["open", "reserved"]);

export const slotStatusEnum = pgEnum("slot_status", ["empty", "invited", "confirmed", "declined", "joined"]);

export const teamEnum = pgEnum("team", ["a", "b"]);

export const activityVerbEnum = pgEnum("activity_verb", [
  "created",
  "joined",
  "left",
  "confirmed",
  "declined",
  "promoted",
  "removed",
  "score_entered",
  "cancelled",
  "updated",
  "invited",
  "requested",
  "approved",
  "rejected",
]);

export const joinRequestStatusEnum = pgEnum("join_request_status", ["pending", "approved", "declined", "withdrawn"]);

export const groupRoleEnum = pgEnum("group_role", ["admin", "member"]);

/** One line per result-based level change, newest last (capped in code). */
export type LevelLogEntry = { at: string; from: number; to: number; code: string; type: "match" | "tournament" };

export type TournamentFormat = "americano" | "mexicano" | "king";
