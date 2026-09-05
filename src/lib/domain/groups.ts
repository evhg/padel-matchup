import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, groupMembers, groups, players, slots, type Event, type Group, type GroupMember, type Player } from "@/db/schema";
import { newInviteCode } from "@/lib/codes";
import { isValidTimeZone, nextOccurrence, zonedTimeToUtc } from "@/lib/dates";
import { createEvent, resolveCapacity } from "./events";
import { DomainError } from "./errors";
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
    name: cleanName(input.name) || ev.title?.trim() || input.fallbackName,
    creatorPlayerId: input.actorPlayerId,
    tz: ev.tz,
    venueName: ev.venueName,
    venueMapUrl: ev.venueMapUrl,
    court: ev.court,
    type: ev.type,
    capacity: ev.capacity,
    whenFull: ev.whenFull,
    levelMin: ev.levelMin,
    levelMax: ev.levelMax,
    memberIds: [ev.creatorPlayerId, ...memberIds],
  });
  await db.update(events).set({ groupId: group.id }).where(eq(events.id, ev.id));
  return group;
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

export async function joinGroup(db: Db, groupId: string, playerId: string): Promise<void> {
  await db.insert(groupMembers).values({ groupId, playerId, role: "member" }).onConflictDoNothing();
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
};

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

/** Would the cron create the next match now? Pure, for tests and the settings screen. */
export function recurrenceDue(group: Pick<Group, "recurDow" | "recurTime" | "tz" | "recurLeadDays" | "recurLastCreatedFor" | "archivedAt">, now = new Date()): Date | null {
  if (group.archivedAt) return null;
  const slot = nextGroupSlot(group, now);
  if (!slot) return null;
  if (slot.startsAt.getTime() - group.recurLeadDays * DAY_MS > now.getTime()) return null;
  if (group.recurLastCreatedFor && group.recurLastCreatedFor.getTime() >= slot.startsAt.getTime()) return null;
  return slot.startsAt;
}

/** Hourly: create the next match for every group whose weekly slot is within its lead time. */
export async function autoCreateGroupMatches(db: Db, now = new Date()): Promise<{ group: Group; event: Event }[]> {
  const candidates = await db.select().from(groups).where(and(isNotNull(groups.recurDow), isNotNull(groups.recurTime), isNull(groups.archivedAt)));
  const created: { group: Group; event: Event }[] = [];
  for (const g of candidates) {
    const startsAt = recurrenceDue(g, now);
    if (!startsAt) continue;
    const event = await createEvent(db, {
      creatorPlayerId: g.creatorPlayerId,
      type: g.type,
      startsAt,
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
    .where(and(inArray(events.groupId, ids), sql`${events.startsAt} > ${now}`, sql`${events.status} <> 'cancelled'`))
    .orderBy(asc(events.startsAt));
  const countMap = new Map(counts.map((c) => [c.groupId, Number(c.n)]));
  return rows.map((r) => ({ group: r.group, role: r.role, memberCount: countMap.get(r.group.id) ?? 0, nextEvent: upcoming.find((e) => e.groupId === r.group.id) ?? null }));
}

export async function getGroupById(db: Db, id: string): Promise<Group | null> {
  const [g] = await db.select().from(groups).where(eq(groups.id, id)).limit(1);
  return g ?? null;
}
