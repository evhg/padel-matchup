import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, events, players, scores, slots, venues, type Activity, type Event, type Player, type Score, type Slot } from "@/db/schema";
import { timePatternOf } from "@/lib/dates";
import { outcomeForTeam, type Outcome } from "./scores";

export type SlotWithPlayer = Slot & { player: Player | null };
export type ActivityWithActor = Activity & { actor: Player | null };

export type EventDetail = {
  event: Event;
  creator: Player;
  roster: SlotWithPlayer[];
  waitlist: SlotWithPlayer[];
  scores: Score[];
  activity: ActivityWithActor[];
};

export async function getEventByCode(db: Db, code: string): Promise<EventDetail | null> {
  const [ev] = await db.select().from(events).where(eq(events.code, code)).limit(1);
  if (!ev) return null;
  return getEventDetail(db, ev);
}

export async function getEventDetail(db: Db, ev: Event): Promise<EventDetail> {
  const [[creator], slotRows, scoreRows, actRows] = await Promise.all([
    db.select().from(players).where(eq(players.id, ev.creatorPlayerId)),
    db
      .select({ slot: slots, player: players })
      .from(slots)
      .leftJoin(players, eq(players.id, slots.playerId))
      .where(eq(slots.eventId, ev.id))
      .orderBy(asc(slots.position)),
    db.select().from(scores).where(eq(scores.eventId, ev.id)).orderBy(asc(scores.setNumber)),
    db
      .select({ activity, actor: players })
      .from(activity)
      .leftJoin(players, eq(players.id, activity.actorPlayerId))
      .where(eq(activity.eventId, ev.id))
      .orderBy(desc(activity.createdAt))
      .limit(50),
  ]);
  const all: SlotWithPlayer[] = slotRows.map((r) => ({ ...r.slot, player: r.player }));
  return {
    event: ev,
    creator,
    roster: all.filter((s) => s.position <= ev.capacity),
    waitlist: all.filter((s) => s.position > ev.capacity),
    scores: scoreRows,
    activity: actRows.map((r) => ({ ...r.activity, actor: r.actor })),
  };
}

export async function getSlotByInviteCode(db: Db, inviteCode: string): Promise<{ slot: SlotWithPlayer; event: Event; creator: Player } | null> {
  const [row] = await db
    .select({ slot: slots, event: events, player: players })
    .from(slots)
    .innerJoin(events, eq(events.id, slots.eventId))
    .leftJoin(players, eq(players.id, slots.playerId))
    .where(eq(slots.inviteCode, inviteCode))
    .limit(1);
  if (!row) return null;
  const [creator] = await db.select().from(players).where(eq(players.id, row.event.creatorPlayerId));
  return { slot: { ...row.slot, player: row.player }, event: row.event, creator };
}

export type MyEvent = {
  event: Event;
  slot: Slot;
  scores: Score[];
  outcome: Outcome | null;
  /** Tournament: 1-based finishing position once finalized. */
  placement: number | null;
  playerCount: number;
  isCreator: boolean;
};

export async function getPlayerEvents(db: Db, playerId: string, now = new Date()): Promise<{ upcoming: MyEvent[]; past: MyEvent[] }> {
  const rows = await db
    .select({ event: events, slot: slots })
    .from(events)
    .leftJoin(slots, and(eq(slots.eventId, events.id), eq(slots.playerId, playerId)))
    .where(or(eq(events.creatorPlayerId, playerId), eq(slots.playerId, playerId)))
    .orderBy(desc(events.startsAt))
    .limit(200);
  if (rows.length === 0) return { upcoming: [], past: [] };
  const ids = rows.map((r) => r.event.id);
  const scoreRows = await db.select().from(scores).where(inArray(scores.eventId, ids)).orderBy(asc(scores.setNumber));
  const counts = await db
    .select({ eventId: slots.eventId, n: sql<number>`count(*)` })
    .from(slots)
    .where(and(inArray(slots.eventId, ids), inArray(slots.status, ["joined", "confirmed"]), sql`${slots.position} <= (select capacity from ${events} e where e.id = ${slots.eventId})`))
    .groupBy(slots.eventId);
  const countMap = new Map(counts.map((c) => [c.eventId, Number(c.n)]));
  const seen = new Set<string>();
  const list: MyEvent[] = [];
  for (const r of rows) {
    if (seen.has(r.event.id)) continue;
    seen.add(r.event.id);
    const evScores = scoreRows.filter((s) => s.eventId === r.event.id);
    const slot = r.slot ?? ({ team: null, status: "empty", position: 0 } as unknown as Slot);
    const placementIdx = r.event.type === "tournament" && r.event.standings ? r.event.standings.indexOf(playerId) : -1;
    list.push({
      event: r.event,
      slot,
      scores: evScores,
      outcome: outcomeForTeam(evScores, r.slot?.team ?? null),
      placement: placementIdx >= 0 ? placementIdx + 1 : null,
      playerCount: countMap.get(r.event.id) ?? 0,
      isCreator: r.event.creatorPlayerId === playerId,
    });
  }
  const upcoming = list.filter((m) => m.event.startsAt.getTime() > now.getTime() && m.event.status !== "cancelled").reverse();
  const past = list.filter((m) => m.event.startsAt.getTime() <= now.getTime() || m.event.status === "cancelled");
  return { upcoming, past };
}

export type RolodexEntry = { name: string; email: string | null; phone: string | null; playerId: string | null; lastSeen: Date };

/** Decision 6: everyone who has ever joined or been invited to the creator's events. */
export async function getRolodex(db: Db, creatorPlayerId: string): Promise<RolodexEntry[]> {
  const rows = await db
    .select({
      name: sql<string | null>`coalesce(${players.displayName}, ${slots.invitedName})`,
      email: sql<string | null>`coalesce(${slots.invitedEmail}, ${players.email})`,
      phone: sql<string | null>`coalesce(${slots.invitedPhone}, ${players.phone})`,
      playerId: slots.playerId,
      lastSeen: sql<Date>`coalesce(${slots.joinedAt}, ${slots.invitedAt}, ${events.createdAt})`,
    })
    .from(slots)
    .innerJoin(events, eq(events.id, slots.eventId))
    .leftJoin(players, eq(players.id, slots.playerId))
    .where(and(eq(events.creatorPlayerId, creatorPlayerId), or(sql`${slots.playerId} is not null`, sql`${slots.invitedName} is not null`)))
    .orderBy(desc(sql`coalesce(${slots.joinedAt}, ${slots.invitedAt}, ${events.createdAt})`))
    .limit(500);
  const byKey = new Map<string, RolodexEntry>();
  for (const r of rows) {
    if (!r.name) continue;
    if (r.playerId === creatorPlayerId) continue;
    const key = r.name.trim().toLowerCase();
    const existing = byKey.get(key);
    const lastSeen = r.lastSeen instanceof Date ? r.lastSeen : new Date(r.lastSeen);
    if (!existing) {
      byKey.set(key, { name: r.name.trim(), email: r.email, phone: r.phone, playerId: r.playerId, lastSeen });
    } else {
      existing.email ||= r.email;
      existing.phone ||= r.phone;
      existing.playerId ||= r.playerId;
    }
  }
  return [...byKey.values()];
}

export async function getVenues(db: Db, creatorPlayerId: string) {
  return db.select().from(venues).where(eq(venues.creatorPlayerId, creatorPlayerId)).orderBy(desc(venues.lastUsedAt)).limit(50);
}

/** Roster players with an email (for .ics updates/cancellations). */
export function participantsWithEmail(roster: SlotWithPlayer[]): { playerId: string | null; name: string; email: string; locale: string }[] {
  const out: { playerId: string | null; name: string; email: string; locale: string }[] = [];
  for (const s of roster) {
    if (s.status !== "joined" && s.status !== "confirmed") continue;
    const email = s.player?.email ?? s.invitedEmail;
    if (!email) continue;
    out.push({ playerId: s.playerId, name: s.player?.displayName ?? s.invitedName ?? "", email, locale: s.player?.locale ?? "en" });
  }
  return out;
}

export type TimePattern = { dow: number; time: string; count: number; last: Date };

/**
 * The weekday + time slots this player actually plays (created or joined,
 * not cancelled), most frequent first, then most recent. Feeds the quick
 * picks on the create form: never guessed, always from history.
 */
export async function getPlayerTimePatterns(db: Db, playerId: string, limit = 4): Promise<TimePattern[]> {
  const rows = await db
    .select({ startsAt: events.startsAt, tz: events.tz })
    .from(events)
    .leftJoin(slots, and(eq(slots.eventId, events.id), eq(slots.playerId, playerId), inArray(slots.status, ["joined", "confirmed"])))
    .where(and(ne(events.status, "cancelled"), or(eq(events.creatorPlayerId, playerId), sql`${slots.id} is not null`)))
    .orderBy(desc(events.startsAt))
    .limit(200);
  const buckets = new Map<string, TimePattern>();
  for (const r of rows) {
    const startsAt = r.startsAt instanceof Date ? r.startsAt : new Date(r.startsAt);
    const { dow, time } = timePatternOf(startsAt, r.tz);
    const key = `${dow}-${time}`;
    const b = buckets.get(key);
    if (b) {
      b.count++;
      if (startsAt > b.last) b.last = startsAt;
    } else buckets.set(key, { dow, time, count: 1, last: startsAt });
  }
  return [...buckets.values()].sort((a, b) => b.count - a.count || b.last.getTime() - a.last.getTime()).slice(0, limit);
}
