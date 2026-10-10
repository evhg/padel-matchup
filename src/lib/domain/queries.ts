import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, events, players, scores, slots, venues, type Activity, type Event, type Player, type Score, type Slot } from "@/db/schema";
import { timePatternOf } from "@/lib/dates";
import { placeOf } from "./fixedPairs";
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
  /**
   * Set by the card sync alone (`src/lib/channels/cards.ts`): the late pull-out the crew's card calls
   * out (`src/lib/domain/banter.ts`). Never read from here by a page, the API or anything public.
   */
  lateExit?: { name: string; count: number } | null;
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

/** One entry of the /me list: a match or a lesson, with the moment it starts. */
export type TimelineEntry<M, L> = { kind: "match"; at: number; match: M } | { kind: "lesson"; at: number; lesson: L };

/** Matches and lessons on one timeline, soonest first: a lesson takes its place among the matches by time, not a section of its own. */
export function mergeTimeline<M extends { event: { startsAt: Date } }, L extends { startsAt: Date }>(matches: readonly M[], lessons: readonly L[]): TimelineEntry<M, L>[] {
  const entries: TimelineEntry<M, L>[] = [...matches.map((match) => ({ kind: "match" as const, at: match.event.startsAt.getTime(), match })), ...lessons.map((lesson) => ({ kind: "lesson" as const, at: lesson.startsAt.getTime(), lesson }))];
  return entries.sort((a, b) => a.at - b.at);
}

/**
 * Whether this player has any match at all, by the same rule `getPlayerEvents` uses below: they
 * created it, or they sit in one of its seats. Bounded at one row and asking for nothing else, so a
 * screen that only needs the yes-or-no does not pay for the list.
 *
 * It lives against `getPlayerEvents` on purpose: the two answer the same question and must not drift.
 */
export async function playerHasEvents(db: Db, playerId: string): Promise<boolean> {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .leftJoin(slots, and(eq(slots.eventId, events.id), eq(slots.playerId, playerId)))
    .where(or(eq(events.creatorPlayerId, playerId), eq(slots.playerId, playerId)))
    .limit(1);
  return rows.length > 0;
}

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
    // A fixed-pairs night's snapshot holds partners side by side: both are first (`placeOf`).
    const placement = r.event.type === "tournament" ? placeOf(r.event, playerId) : null;
    list.push({
      event: r.event,
      slot,
      scores: evScores,
      outcome: outcomeForTeam(evScores, r.slot?.team ?? null),
      placement,
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
      // Only a number the organiser typed themselves. `players.phone` is the WhatsApp number a player
      // linked, and no phone number is shown to anybody else (rule 7).
      phone: slots.invitedPhone,
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
  return timePatternsOf(await getPlayerHistory(db, playerId), limit);
}

const historyColumns = { id: events.id, startsAt: events.startsAt, tz: events.tz, venueSlug: events.venueSlug, durationMinutes: events.durationMinutes };

/**
 * The two reads of a player's history, each started from an index on the player: the matches they
 * made (`events_creator_idx`) and the seats they held (`slots_player_idx`). One read with an OR across
 * an outer join cannot use either, and walks the whole `events` table by date for a player with few
 * matches (the review of 10 October 2026: 3,003 rows read for 3). Exported for the test that reads
 * their plans.
 */
export function playerHistoryReads(db: Db, playerId: string, limit: number) {
  return [
    db.select(historyColumns).from(events).where(and(eq(events.creatorPlayerId, playerId), ne(events.status, "cancelled"))).orderBy(desc(events.startsAt)).limit(limit),
    db
      .select(historyColumns)
      .from(slots)
      .innerJoin(events, eq(events.id, slots.eventId))
      .where(and(eq(slots.playerId, playerId), inArray(slots.status, ["joined", "confirmed"]), ne(events.status, "cancelled")))
      .orderBy(desc(events.startsAt))
      .limit(limit),
  ] as const;
}

/**
 * The matches a player made or played (not cancelled), newest first: when, in which zone, where and for
 * how long. Two bounded reads, one after the other (`playerHistoryReads`), merged; a match they made
 * and also sat in counts once. The usual times (`timePatternsOf`) and the usual clubs (the best times,
 * `src/lib/domain/freeCourts.ts`) are both read off it.
 */
export async function getPlayerHistory(db: Db, playerId: string, limit = 200): Promise<{ startsAt: Date; tz: string; venueSlug: string | null; durationMinutes: number }[]> {
  const [madeRead, playedRead] = playerHistoryReads(db, playerId, limit);
  const made = await madeRead;
  const played = await playedRead;
  const byId = new Map([...made, ...played].map((r) => [r.id, r]));
  return [...byId.values()]
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
    .slice(0, limit)
    .map(({ id: _id, ...r }) => r);
}

/** The weekday + time slots in a list of matches, most frequent first, then most recent. Pure. */
export function timePatternsOf(rows: readonly { startsAt: Date | string; tz: string }[], limit = 4): TimePattern[] {
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
