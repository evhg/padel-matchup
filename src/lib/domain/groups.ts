import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { timePatternOf } from "@/lib/dates";
import { events, groupMembers, groupRequests, groups, players, slots, telegramChats, type Event, type Group, type GroupMember, type GroupRequest, type Player } from "@/db/schema";
import { newInviteCode } from "@/lib/codes";
import { isValidTimeZone, nextOccurrence, zonedTimeToUtc } from "@/lib/dates";
import { createEvent, fieldInFours, resolveCapacity } from "./events";
import { DomainError } from "./errors";
import { cleanAskNote, joinDoor, nextAsk, type JoinVia } from "./groupAccess";
import { normalizeRange } from "./levels";
import { joinEvent } from "./slots";

const DAY_MS = 24 * 3600 * 1000;

export type GroupMemberWithPlayer = GroupMember & { player: Player };
export type GroupDetail = { group: Group; members: GroupMemberWithPlayer[]; upcoming: Event[]; past: Event[] };

const cleanName = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim().slice(0, 60);

export type CreateGroupInput = {
  name: string;
  creatorPlayerId: string;
  tz: string;
  venueName?: string | null;
  venueMapUrl?: string | null;
  court?: string | null;
  type?: "match" | "tournament";
  capacity?: number;
  whenFull?: "waitlist" | "closed";
  levelMin?: number | null;
  levelMax?: number | null;
  memberIds?: string[];
};

export async function createGroup(db: Db, input: CreateGroupInput): Promise<Group> {
  const name = cleanName(input.name);
  if (!name) throw new DomainError("invalid", "name");
  if (!isValidTimeZone(input.tz)) throw new DomainError("invalid", "tz");
  const type = input.type ?? "match";
  const range = normalizeRange(input.levelMin, input.levelMax);
  return db.transaction(async (tx) => {
    let group: Group | undefined;
    for (let attempt = 0; attempt < 6 && !group; attempt++) {
      const code = newInviteCode();
      const [existing] = await tx.select({ id: groups.id }).from(groups).where(eq(groups.code, code)).limit(1);
      if (existing) continue;
      [group] = await tx
        .insert(groups)
        .values({
          code,
          name,
          creatorPlayerId: input.creatorPlayerId,
          tz: input.tz,
          venueName: input.venueName?.trim() || null,
          venueMapUrl: input.venueMapUrl?.trim() || null,
          court: input.court?.trim() || null,
          type,
          capacity: resolveCapacity(type, input.capacity),
          whenFull: input.whenFull === "closed" ? "closed" : "waitlist",
          levelMin: range.min,
          levelMax: range.max,
        })
        .returning();
    }
    if (!group) throw new Error("Could not allocate a group code");
    const ids = new Set<string>([input.creatorPlayerId, ...(input.memberIds ?? [])]);
    await tx.insert(groupMembers).values([...ids].map((playerId) => ({ groupId: group!.id, playerId, role: playerId === input.creatorPlayerId ? ("admin" as const) : ("member" as const) })));
    return group;
  });
}

/** "Turn this crew into a group": the match's settings become the defaults, its players the members. */
export async function createGroupFromEvent(db: Db, input: { eventId: string; actorPlayerId: string; name?: string | null; fallbackName: string }): Promise<Group> {
  const [ev] = await db.select().from(events).where(eq(events.id, input.eventId));
  if (!ev) throw new DomainError("not_found");
  if (ev.groupId) {
    const [g] = await db.select().from(groups).where(eq(groups.id, ev.groupId));
    if (g) return g;
  }
  const roster = await db
    .select({ playerId: slots.playerId })
    .from(slots)
    .where(and(eq(slots.eventId, ev.id), sql`${slots.position} <= ${ev.capacity}`, inArray(slots.status, ["joined", "confirmed"]), isNotNull(slots.playerId)));
  const memberIds = roster.map((r) => r.playerId!).filter(Boolean);
  if (!memberIds.includes(input.actorPlayerId) && ev.creatorPlayerId !== input.actorPlayerId) throw new DomainError("forbidden");
  const group = await createGroup(db, {
    // The place stays on the match; a group is called by its rhythm ("Thursday 19:00 crew") unless the match had a real title.
    name: cleanName(input.name) || (ev.title?.trim() && ev.title.trim().toLowerCase() !== (ev.venueName ?? "").trim().toLowerCase() ? ev.title.trim() : "") || input.fallbackName,
    creatorPlayerId: input.actorPlayerId,
    tz: ev.tz,
    venueName: ev.venueName,
    venueMapUrl: ev.venueMapUrl,
    court: ev.court,
    type: ev.type,
    capacity: ev.type === "tournament" ? fieldInFours(ev.capacity) : ev.capacity,
    whenFull: ev.whenFull,
    levelMin: ev.levelMin,
    levelMax: ev.levelMax,
    memberIds: [ev.creatorPlayerId, ...memberIds],
  });
  await db.update(events).set({ groupId: group.id }).where(eq(events.id, ev.id));
  return group;
}

/**
 * "Same time next week?": the match's crew becomes a group with a weekly slot at the match's
 * own day and time, so the next card posts itself. An existing group keeps its settings.
 */
export async function weeklyGroupFromEvent(db: Db, input: { eventId: string; actorPlayerId: string; fallbackName: string }): Promise<{ group: Group; created: boolean }> {
  const [ev] = await db.select().from(events).where(eq(events.id, input.eventId));
  if (!ev) throw new DomainError("not_found");
  const existed = Boolean(ev.groupId);
  const group = await createGroupFromEvent(db, { eventId: ev.id, actorPlayerId: input.actorPlayerId, fallbackName: input.fallbackName });
  if (existed || group.recurDow !== null) return { group, created: false };
  const { dow, time } = timePatternOf(ev.startsAt, ev.tz);
  const [updated] = await db.update(groups).set({ recurDow: dow, recurTime: time, recurLastCreatedFor: null }).where(eq(groups.id, group.id)).returning();
  return { group: updated ?? group, created: true };
}

export async function getGroupByCode(db: Db, code: string): Promise<Group | null> {
  const [g] = await db.select().from(groups).where(eq(groups.code, code)).limit(1);
  return g ?? null;
}

export async function getGroupDetail(db: Db, group: Group, now = new Date()): Promise<GroupDetail> {
  const members = await db
    .select({ member: groupMembers, player: players })
    .from(groupMembers)
    .innerJoin(players, eq(players.id, groupMembers.playerId))
    .where(eq(groupMembers.groupId, group.id))
    .orderBy(asc(groupMembers.joinedAt));
  const evs = await db.select().from(events).where(eq(events.groupId, group.id)).orderBy(desc(events.startsAt)).limit(60);
  const sorted = members.map((m) => ({ ...m.member, player: m.player })).sort((a, b) => (a.role === b.role ? 0 : a.role === "admin" ? -1 : 1));
  return {
    group,
    members: sorted,
    upcoming: evs.filter((e) => e.startsAt.getTime() > now.getTime() && e.status !== "cancelled").reverse(),
    past: evs.filter((e) => e.startsAt.getTime() <= now.getTime() || e.status === "cancelled").slice(0, 12),
  };
}

export async function getGroupMember(db: Db, groupId: string, playerId: string): Promise<GroupMember | null> {
  const [m] = await db.select().from(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.playerId, playerId))).limit(1);
  return m ?? null;
}

/**
 * What a join did.
 *   - `joined`: a member now. `already`: was one.
 *   - `requested`: a new ask, or one reopened; the admins hear about it when `notify` is set.
 *   - `pending`: an ask was already waiting, so nothing changed and nobody hears twice.
 *   - `declined`: declined less than seven days ago; nothing changed until `askAgainFrom`.
 *   - `skipped`: a match seat in a group that asks to join; nobody was added and nothing was asked.
 */
export type GroupJoinResult =
  | { outcome: "joined" | "already" | "pending" | "skipped" }
  | { outcome: "requested"; request: GroupRequest; notify: boolean }
  | { outcome: "declined"; askAgainFrom: Date };

/**
 * The one way into a group, for every caller, which says who is acting (`via`, see `joinDoor`).
 * With "Ask to join" off every caller adds, as before decision E. With it on only an admin adds,
 * the person's own tap asks, and a match seat adds nobody: the seat follows the match's rules and
 * the crew stays the crew's to choose. One read of the group by its key, then one write at most,
 * and a second only when a member row was really added.
 *
 * That second write closes the person's waiting ask in this group, if there is one, as approved:
 * they got in another way (the door was opened, a match seat in an open group), so the question is
 * answered. Left pending, the ask hid behind the admins' list's member check only while they stayed;
 * once they left, the old question came back to the admins as if new. `decideGroupRequest` writes
 * its own decision over this one straight after, inside the same transaction.
 */
export async function joinGroup(db: Db, groupId: string, playerId: string, via: JoinVia, o: { note?: string | null; now?: Date } = {}): Promise<GroupJoinResult> {
  const [g] = await db.select({ askToJoin: groups.askToJoin }).from(groups).where(eq(groups.id, groupId)).limit(1);
  if (!g) throw new DomainError("not_found");
  const door = joinDoor(g, via);
  if (door === "add") {
    const added = await db.insert(groupMembers).values({ groupId, playerId, role: "member" }).onConflictDoNothing().returning({ playerId: groupMembers.playerId });
    if (added.length === 0) return { outcome: "already" };
    await db
      .update(groupRequests)
      .set({ status: "approved", decidedAt: o.now ?? new Date() })
      .where(and(eq(groupRequests.groupId, groupId), eq(groupRequests.playerId, playerId), eq(groupRequests.status, "pending")));
    return { outcome: "joined" };
  }
  if (await getGroupMember(db, groupId, playerId)) return { outcome: "already" };
  if (door === "none") return { outcome: "skipped" };
  return askToJoinGroup(db, groupId, playerId, o.note ?? null, o.now ?? new Date());
}

/**
 * A person asks to join (`nextAsk` decides what that does to their row). One row per person and
 * group: a reopened ask is the same row back at pending, with the new note and a new `created_at`.
 * Each write is conditional on the status it read, so a double tap cannot open two asks or reopen a
 * row an admin decided a moment ago.
 */
async function askToJoinGroup(db: Db, groupId: string, playerId: string, rawNote: string | null, now: Date): Promise<GroupJoinResult> {
  const note = cleanAskNote(rawNote);
  const [existing] = await db.select().from(groupRequests).where(and(eq(groupRequests.groupId, groupId), eq(groupRequests.playerId, playerId))).limit(1);
  const step = nextAsk(existing, now);
  if (step.kind === "keep") return { outcome: "pending" };
  if (step.kind === "wait") return { outcome: "declined", askAgainFrom: step.from };
  if (step.kind === "insert") {
    const [row] = await db.insert(groupRequests).values({ groupId, playerId, note, status: "pending", createdAt: now }).onConflictDoNothing().returning();
    // Somebody else's insert won the race (a second tab): theirs is the ask, already told.
    return row ? { outcome: "requested", request: row, notify: true } : { outcome: "pending" };
  }
  const [row] = await db
    .update(groupRequests)
    .set({ status: "pending", note, createdAt: now, decidedAt: null, decidedByPlayerId: null })
    .where(and(eq(groupRequests.id, existing!.id), eq(groupRequests.status, existing!.status)))
    .returning();
  return row ? { outcome: "requested", request: row, notify: step.notify } : { outcome: "pending" };
}

/**
 * Account deletion (`anonymizePlayer`): every ask the person made, in every group, goes. An ask is a
 * request to be let in, and its note is the person's own words; neither may stay on an admin's list
 * beside "Deleted player". Down `group_requests_player_idx`. Returns how many went.
 */
export async function dropGroupRequestsFor(db: Db, playerId: string): Promise<number> {
  const rows = await db.delete(groupRequests).where(eq(groupRequests.playerId, playerId)).returning({ id: groupRequests.id });
  return rows.length;
}

/** The asker takes it back. Only a pending ask; true when one was withdrawn. */
export async function withdrawGroupRequest(db: Db, groupId: string, playerId: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(groupRequests)
    .set({ status: "withdrawn", decidedAt: now })
    .where(and(eq(groupRequests.groupId, groupId), eq(groupRequests.playerId, playerId), eq(groupRequests.status, "pending")))
    .returning({ id: groupRequests.id });
  return rows.length > 0;
}

/**
 * An admin says yes (the person becomes a member through `joinGroup` with `via: "admin"`) or no.
 * Only a pending ask can be decided, and only by an admin of that group; the row is locked so two
 * admins tapping at once decide it once.
 */
export async function decideGroupRequest(
  db: Db,
  input: { groupId: string; requestId: string; approve: boolean; actorPlayerId: string; now?: Date },
): Promise<{ request: GroupRequest; player: Player | null }> {
  const now = input.now ?? new Date();
  const actor = await getGroupMember(db, input.groupId, input.actorPlayerId);
  if (!actor || actor.role !== "admin") throw new DomainError("forbidden");
  return db.transaction(async (tx) => {
    const [req] = await tx.select().from(groupRequests).where(and(eq(groupRequests.id, input.requestId), eq(groupRequests.groupId, input.groupId))).for("update");
    if (!req) throw new DomainError("not_found");
    if (req.status !== "pending") throw new DomainError("invalid", "not_pending");
    if (input.approve) await joinGroup(tx, input.groupId, req.playerId, "admin", { now });
    const [request] = await tx
      .update(groupRequests)
      .set({ status: input.approve ? "approved" : "declined", decidedAt: now, decidedByPlayerId: input.actorPlayerId })
      .where(eq(groupRequests.id, req.id))
      .returning();
    const [player] = await tx.select().from(players).where(eq(players.id, req.playerId)).limit(1);
    return { request, player: player ?? null };
  });
}

export type PendingGroupRequest = { id: string; note: string | null; createdAt: Date; player: Pick<Player, "id" | "displayName" | "level"> };

/**
 * The admins' list: pending asks, oldest first, down `group_requests_group_status_idx`, capped. A
 * person who became a member some other way meanwhile is left out rather than shown as a question
 * nobody needs to answer. `joinGroup` already closes such an ask as approved; the member check here
 * is the second guard, for a row written before it did.
 */
export async function pendingGroupRequests(db: Db, groupId: string, limit = 50): Promise<PendingGroupRequest[]> {
  const rows = await db
    .select({ id: groupRequests.id, note: groupRequests.note, createdAt: groupRequests.createdAt, player: { id: players.id, displayName: players.displayName, level: players.level } })
    .from(groupRequests)
    .innerJoin(players, eq(players.id, groupRequests.playerId))
    .where(
      and(
        eq(groupRequests.groupId, groupId),
        eq(groupRequests.status, "pending"),
        sql`not exists (select 1 from ${groupMembers} m where m.group_id = ${groupRequests.groupId} and m.player_id = ${groupRequests.playerId})`,
      ),
    )
    .orderBy(asc(groupRequests.createdAt))
    .limit(limit);
  return rows;
}

/** The viewer's own ask in this group, if any (one read down the unique index). */
export async function getGroupRequest(db: Db, groupId: string, playerId: string): Promise<GroupRequest | null> {
  const [r] = await db.select().from(groupRequests).where(and(eq(groupRequests.groupId, groupId), eq(groupRequests.playerId, playerId))).limit(1);
  return r ?? null;
}

/** The admins who hear about a new ask: every admin of the group, bounded (a group has one today). */
export async function groupAdmins(db: Db, groupId: string): Promise<Player[]> {
  const rows = await db
    .select({ player: players })
    .from(groupMembers)
    .innerJoin(players, eq(players.id, groupMembers.playerId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.role, "admin")))
    .limit(5);
  return rows.map((r) => r.player);
}

export async function leaveGroup(db: Db, groupId: string, playerId: string): Promise<void> {
  const [g] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!g) throw new DomainError("not_found");
  if (g.creatorPlayerId === playerId) throw new DomainError("forbidden", "creator_cannot_leave");
  await db.delete(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.playerId, playerId)));
}

export async function removeGroupMember(db: Db, groupId: string, actorPlayerId: string, playerId: string): Promise<void> {
  const actor = await getGroupMember(db, groupId, actorPlayerId);
  if (!actor || actor.role !== "admin") throw new DomainError("forbidden");
  const [g] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!g || g.creatorPlayerId === playerId) throw new DomainError("forbidden");
  await db.delete(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.playerId, playerId)));
}

/**
 * The admin hands the group to another current member. Two things make a group's admin, and both
 * move together in one transaction: the `admin` role on the member row, which opens the settings, and
 * `groups.creator_player_id`, which keeps that person from leaving or being removed and is who the
 * weekly match is created for. The old admin stays on as a plain member and may now leave. Only the
 * admin can do it, and only to somebody in the group now: a player who left, or never joined, is
 * `not_member`.
 */
export async function handOverGroup(db: Db, groupId: string, actorPlayerId: string, toPlayerId: string): Promise<Group> {
  const actor = await getGroupMember(db, groupId, actorPlayerId);
  if (!actor || actor.role !== "admin") throw new DomainError("forbidden");
  if (toPlayerId === actorPlayerId) throw new DomainError("invalid", "self");
  const to = await getGroupMember(db, groupId, toPlayerId);
  if (!to) throw new DomainError("not_member");
  return db.transaction(async (tx) => {
    // The step down is conditional on still being the admin, so two hand-overs from two tabs cannot
    // both land and leave the group with two admins: the second finds no admin row and stops.
    const stepped = await tx
      .update(groupMembers)
      .set({ role: "member" })
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.playerId, actorPlayerId), eq(groupMembers.role, "admin")))
      .returning({ playerId: groupMembers.playerId });
    if (stepped.length === 0) throw new DomainError("forbidden");
    const promoted = await tx
      .update(groupMembers)
      .set({ role: "admin" })
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.playerId, toPlayerId)))
      .returning({ playerId: groupMembers.playerId });
    if (promoted.length === 0) throw new DomainError("not_member");
    const [g] = await tx.update(groups).set({ creatorPlayerId: toPlayerId }).where(eq(groups.id, groupId)).returning();
    if (!g) throw new DomainError("not_found");
    return g;
  });
}

export type UpdateGroupInput = {
  name?: string;
  venueName?: string | null;
  venueMapUrl?: string | null;
  court?: string | null;
  type?: "match" | "tournament";
  capacity?: number;
  whenFull?: "waitlist" | "closed";
  levelMin?: number | null;
  levelMax?: number | null;
  recurDow?: number | null;
  recurTime?: string | null;
  recurLeadDays?: number;
  tz?: string;
  /** New people ask and an admin approves (decision E). */
  askToJoin?: boolean;
};

/** An admin disbands the group: members and the weekly slot go; matches stay, unlinked; chats keep their cards. */
export async function deleteGroup(db: Db, groupId: string, actorPlayerId: string): Promise<void> {
  const [member] = await db.select().from(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.playerId, actorPlayerId))).limit(1);
  if (!member || member.role !== "admin") throw new DomainError("forbidden");
  await db.update(events).set({ groupId: null }).where(eq(events.groupId, groupId));
  await db.delete(groups).where(eq(groups.id, groupId));
}

export async function updateGroup(db: Db, groupId: string, actorPlayerId: string, patch: UpdateGroupInput): Promise<Group> {
  const actor = await getGroupMember(db, groupId, actorPlayerId);
  if (!actor || actor.role !== "admin") throw new DomainError("forbidden");
  const [g] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!g) throw new DomainError("not_found");
  const set: Partial<typeof groups.$inferInsert> = {};
  if (patch.name !== undefined) {
    const n = cleanName(patch.name);
    if (!n) throw new DomainError("invalid", "name");
    set.name = n;
  }
  if (patch.venueName !== undefined) set.venueName = patch.venueName?.trim() || null;
  if (patch.venueMapUrl !== undefined) set.venueMapUrl = patch.venueMapUrl?.trim() || null;
  if (patch.court !== undefined) set.court = patch.court?.trim() || null;
  const type = patch.type ?? g.type;
  if (patch.type !== undefined) set.type = type;
  if (patch.capacity !== undefined || patch.type !== undefined) set.capacity = resolveCapacity(type, patch.capacity ?? (type === "tournament" ? Math.max(8, g.capacity) : undefined));
  if (patch.whenFull !== undefined) set.whenFull = patch.whenFull === "closed" ? "closed" : "waitlist";
  if (patch.levelMin !== undefined || patch.levelMax !== undefined) {
    const r = normalizeRange(patch.levelMin !== undefined ? patch.levelMin : g.levelMin, patch.levelMax !== undefined ? patch.levelMax : g.levelMax);
    set.levelMin = r.min;
    set.levelMax = r.max;
  }
  if (patch.tz !== undefined) {
    if (!isValidTimeZone(patch.tz)) throw new DomainError("invalid", "tz");
    set.tz = patch.tz;
  }
  if (patch.recurDow !== undefined || patch.recurTime !== undefined) {
    const dow = patch.recurDow !== undefined ? patch.recurDow : g.recurDow;
    const time = patch.recurTime !== undefined ? patch.recurTime : g.recurTime;
    if (dow == null || !time) {
      set.recurDow = null;
      set.recurTime = null;
    } else {
      if (!Number.isInteger(dow) || dow < 0 || dow > 6) throw new DomainError("invalid", "dow");
      if (!/^\d{2}:\d{2}$/.test(time)) throw new DomainError("invalid", "time");
      set.recurDow = dow;
      set.recurTime = time;
      // A new slot starts fresh: the guard only remembers matches created for the old slot.
      if (dow !== g.recurDow || time !== g.recurTime) set.recurLastCreatedFor = null;
    }
  }
  if (patch.recurLeadDays !== undefined) set.recurLeadDays = Math.min(14, Math.max(1, Math.round(patch.recurLeadDays)));
  if (patch.askToJoin !== undefined) set.askToJoin = patch.askToJoin;
  if (Object.keys(set).length === 0) return g;
  const [updated] = await db.update(groups).set(set).where(eq(groups.id, groupId)).returning();
  return updated;
}

/** The next weekly slot as an instant, or null when the group has no recurrence. */
export function nextGroupSlot(group: Pick<Group, "recurDow" | "recurTime" | "tz">, now = new Date()): { startsAt: Date; date: string; time: string } | null {
  if (group.recurDow == null || !group.recurTime) return null;
  const next = nextOccurrence(group.recurDow, group.recurTime, group.tz, now);
  return { startsAt: zonedTimeToUtc(next.date, next.time, group.tz), ...next };
}

/**
 * The one due rule for a weekly slot (groups and club programmes share it):
 * the next occurrence, once it is within the lead time, unless it was already
 * created. Pure.
 */
export function weeklyDue(s: { dow: number; time: string; tz: string; leadDays: number; lastCreatedFor: Date | null }, now = new Date()): Date | null {
  const slot = nextGroupSlot({ recurDow: s.dow, recurTime: s.time, tz: s.tz }, now);
  if (!slot) return null;
  if (slot.startsAt.getTime() - s.leadDays * DAY_MS > now.getTime()) return null;
  if (s.lastCreatedFor && s.lastCreatedFor.getTime() >= slot.startsAt.getTime()) return null;
  return slot.startsAt;
}

/** Would the cron create the next match now? Pure, for tests and the settings screen. */
export function recurrenceDue(group: Pick<Group, "recurDow" | "recurTime" | "tz" | "recurLeadDays" | "recurLastCreatedFor" | "archivedAt">, now = new Date()): Date | null {
  if (group.archivedAt || group.recurDow == null || !group.recurTime) return null;
  return weeklyDue({ dow: group.recurDow, time: group.recurTime, tz: group.tz, leadDays: group.recurLeadDays, lastCreatedFor: group.recurLastCreatedFor }, now);
}

/** Hourly: create the next match for every group whose weekly slot is within its lead time. */
/**
 * What a group's next match takes from the one before: the length, so a crew that books an hour keeps
 * booking an hour, and the tag (`eventTags.ts`), so a ladies' crew's next match is a ladies' match too.
 * A group has neither column of its own; the crew's own last choice is the habit.
 *
 * "The one before" is the last weekly match the slot made (`recurLastCreatedFor`) when it still
 * stands, else the latest match before the new one. Never a cancelled match, and never a match after
 * the one being made: a one-off "Mixed · 45+" on a Saturday, or a "Women" night that was called off,
 * once set the Thursday crew's tag. One read down `events_group_idx`; null when nothing qualifies,
 * which means the type's default and no tag.
 */
export async function latestGroupMatch(db: Db, group: Pick<Group, "id" | "recurLastCreatedFor">, before: Date): Promise<Pick<Event, "durationMinutes" | "category" | "ageMin"> | null> {
  const weekly = group.recurLastCreatedFor;
  const [row] = await db
    .select({ durationMinutes: events.durationMinutes, category: events.category, ageMin: events.ageMin })
    .from(events)
    .where(and(eq(events.groupId, group.id), ne(events.status, "cancelled"), lt(events.startsAt, before)))
    // The weekly match first when it is there (true sorts before false, descending), then the latest.
    .orderBy(...(weekly ? [desc(eq(events.startsAt, weekly))] : []), desc(events.startsAt))
    .limit(1);
  return row ?? null;
}

export async function autoCreateGroupMatches(db: Db, now = new Date()): Promise<{ group: Group; event: Event }[]> {
  const candidates = await db.select().from(groups).where(and(isNotNull(groups.recurDow), isNotNull(groups.recurTime), isNull(groups.archivedAt)));
  const created: { group: Group; event: Event }[] = [];
  for (const g of candidates) {
    const startsAt = recurrenceDue(g, now);
    if (!startsAt) continue;
    const latest = await latestGroupMatch(db, g, startsAt);
    const event = await createEvent(db, {
      creatorPlayerId: g.creatorPlayerId,
      type: g.type,
      startsAt,
      durationMinutes: latest?.durationMinutes ?? null,
      category: latest?.category ?? null,
      ageMin: latest?.ageMin ?? null,
      tz: g.tz,
      venueName: g.venueName,
      venueMapUrl: g.venueMapUrl,
      court: g.court,
      capacity: g.capacity,
      whenFull: g.whenFull,
      levelMin: g.levelMin,
      levelMax: g.levelMax,
      groupId: g.id,
    });
    await joinEvent(db, { eventId: event.id, playerId: g.creatorPlayerId, now }).catch(() => undefined);
    await db.update(groups).set({ recurLastCreatedFor: startsAt }).where(eq(groups.id, g.id));
    created.push({ group: g, event });
  }
  return created;
}

export type PlayerGroup = { group: Group; role: GroupMember["role"]; memberCount: number; nextEvent: Event | null };

/** Groups a player belongs to, with the next upcoming match of each. */
export async function getPlayerGroups(db: Db, playerId: string, now = new Date()): Promise<PlayerGroup[]> {
  const rows = await db
    .select({ group: groups, role: groupMembers.role })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.playerId, playerId), isNull(groups.archivedAt)))
    .orderBy(desc(groups.createdAt))
    .limit(30);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.group.id);
  const counts = await db.select({ groupId: groupMembers.groupId, n: sql<number>`count(*)` }).from(groupMembers).where(inArray(groupMembers.groupId, ids)).groupBy(groupMembers.groupId);
  const upcoming = await db
    .select()
    .from(events)
    .where(and(inArray(events.groupId, ids), gt(events.startsAt, now), ne(events.status, "cancelled")))
    .orderBy(asc(events.startsAt));
  const countMap = new Map(counts.map((c) => [c.groupId, Number(c.n)]));
  return rows.map((r) => ({ group: r.group, role: r.role, memberCount: countMap.get(r.group.id) ?? 0, nextEvent: upcoming.find((e) => e.groupId === r.group.id) ?? null }));
}

export async function getGroupById(db: Db, id: string): Promise<Group | null> {
  const [g] = await db.select().from(groups).where(eq(groups.id, id)).limit(1);
  return g ?? null;
}

/**
 * The way into a crew's own Telegram group (DECIDING rule 30): the invite link the bot made there, for
 * the crew page to hand its members, while the bot is still in the group (after /quiet too: the group
 * is still the crew's), and whether the bot reads it now. One indexed read (`telegram_chats_group_idx`).
 * The first group the bot reads stays the crew's group: a group it reads comes first, then a group
 * with a link, then the older one, so a second group tied later never takes the first one's place.
 */
export async function crewTelegramInvite(db: Db, groupId: string): Promise<{ invite: string | null; listening: boolean }> {
  const [row] = await db
    .select({ link: telegramChats.inviteLink, listeningSince: telegramChats.listeningSince })
    .from(telegramChats)
    .where(and(eq(telegramChats.groupId, groupId), isNull(telegramChats.leftAt)))
    .orderBy(sql`${telegramChats.listeningSince} is null`, sql`${telegramChats.inviteLink} is null`, asc(telegramChats.createdAt))
    .limit(1);
  return { invite: row?.link ?? null, listening: Boolean(row?.listeningSince) };
}

/**
 * Which Telegram doors the crew page shows (DECIDING rule 30): the way into the crew's group to every
 * member, and the link that makes one to the crew's admins only, while the bot reads no group of the
 * crew's. A visitor sees neither.
 */
export function crewTelegramDoors(role: GroupMember["role"] | null, tg: { invite: string | null; listening: boolean } | null): { join: string | null; run: boolean } {
  if (!role || !tg) return { join: null, run: false };
  return { join: tg.invite, run: role === "admin" && !tg.listening };
}

/** The crew's admins: whoever may tie a Telegram group to it. One read on the members' primary key, a handful of rows. */
export async function crewAdminIds(db: Db, groupId: string): Promise<string[]> {
  const rows = await db
    .select({ playerId: groupMembers.playerId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.role, "admin")))
    .limit(20);
  return rows.map((r) => r.playerId);
}
