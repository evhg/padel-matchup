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

/**
 * What a match's detail reads beside the match, through the relations `src/db/schema/events.ts`
 * declares: the organiser, every place with its player in position order, the sets in order, and the
 * last 50 lines of activity with their actors. `db.query` sends it as one statement, with a lateral
 * subquery for each, each down its own index (`slots_event_position_idx`, `scores_event_set_idx`,
 * `activity_event_idx`). Until 16 October 2026 the detail was the match, then four reads at once: five
 * statements on every page view, card sync and notice. Rule 8 says the pooler stalls on such a burst,
 * and rule 12 counts each one. `tests/event-detail.test.ts` holds the answer to the old reads.
 */
const DETAIL_WITH = {
  creator: true as const,
  slots: { with: { player: true as const }, orderBy: [asc(slots.position)] },
  scores: { orderBy: [asc(scores.setNumber)] },
  activity: { with: { actor: true as const }, orderBy: [desc(activity.createdAt)], limit: 50 },
};

type DetailRows = { creator: Player; slots: SlotWithPlayer[]; scores: Score[]; activity: ActivityWithActor[] };

/** The places inside the capacity are the line-up, and the rest are the waiting list. */
function detailOf(ev: Event, rows: DetailRows): EventDetail {
  return {
    event: ev,
    creator: rows.creator,
    roster: rows.slots.filter((s) => s.position <= ev.capacity),
    waitlist: rows.slots.filter((s) => s.position > ev.capacity),
    scores: rows.scores,
    activity: rows.activity,
  };
}

/** The match with this code and everything its page shows, in one statement; null for no such match. */
export async function getEventByCode(db: Db, code: string): Promise<EventDetail | null> {
  const row = await db.query.events.findFirst({ where: eq(events.code, code), with: DETAIL_WITH });
  if (!row) return null;
  const { creator, slots: places, scores: sets, activity: lines, ...ev } = row;
  return detailOf(ev, { creator, slots: places, scores: sets, activity: lines });
}

/** The detail of a match the caller already holds, in one statement; `ev` stays as the caller passed it. */
export async function getEventDetail(db: Db, ev: Event): Promise<EventDetail> {
  const row = await db.query.events.findFirst({ where: eq(events.id, ev.id), columns: { id: true }, with: DETAIL_WITH });
  if (row) return detailOf(ev, row);
  // The match went after the caller read it: its places, sets and activity went with it (on delete
  // cascade), and the organiser is still there. The five reads gave the same answer.
  const [creator] = await db.select().from(players).where(eq(players.id, ev.creatorPlayerId));
  return detailOf(ev, { creator, slots: [], scores: [], activity: [] });
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

/**
 * Does this record hold a seat or a waiting place in the match with this code? For a personal link
 * whose place was released or taken while its person was in by another door: the page says "You're
 * already in this match" rather than "no longer valid". One read down the code's index and
 * `slots_event_player_idx`.
 */
export async function holdsPlaceIn(db: Db, code: string, playerId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: slots.id })
    .from(slots)
    .innerJoin(events, eq(events.id, slots.eventId))
    .where(and(eq(events.code, code), eq(slots.playerId, playerId), inArray(slots.status, ["joined", "confirmed"])))
    .limit(1);
  return Boolean(row);
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

/**
 * Did the player play this match? A place on the line-up, of a match not called off, that they took
 * (joined or confirmed). A tournament's held name played round 1 as a placeholder record, so a held
 * place counts there; a match's held place that nobody took was never played. Pure.
 */
export function playedIn(m: Pick<MyEvent, "event" | "slot">): boolean {
  if (m.event.status === "cancelled" || m.slot.position <= 0 || m.slot.position > m.event.capacity) return false;
  return m.slot.status === "joined" || m.slot.status === "confirmed" || (m.event.type === "tournament" && m.slot.status === "invited");
}

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

/**
 * The organiser's suggestions as the browser gets them. A session by name that proved nothing gets the
 * names alone (`namesAlone`): since the owner's decision of 11 October 2026, "That's me" may sign in a
 * record that organised past matches, and the emails and phones on its list are other people's. Pure.
 */
export function rolodexForBrowser(entries: readonly Pick<RolodexEntry, "name" | "email" | "phone">[], o: { namesAlone: boolean }): { name: string; email: string | null; phone: string | null }[] {
  return entries.map((r) => ({ name: r.name, email: o.namesAlone ? null : r.email, phone: o.namesAlone ? null : r.phone }));
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
 * The weekday + time slots this player actually plays, most frequent first, then most recent. Feeds the
 * quick picks on the create form and its default time: never guessed, always from history. "Plays"
 * means a match of their history (made or joined, not cancelled) with two or more taken seats: Erik's
 * form opened on Fri 18:00 from three Friday matches that nobody joined, while he played at 09:30 to
 * 11:30 (15 October 2026). A player with no such match yet (a new organiser) keeps the chips of their
 * whole history.
 */
export async function getPlayerTimePatterns(db: Db, playerId: string, limit = 4): Promise<TimePattern[]> {
  const history = await getPlayerHistory(db, playerId);
  const played = await playedMatchIds(db, history.map((h) => h.id));
  const kept = history.filter((h) => played.has(h.id));
  return timePatternsOf(kept.length > 0 ? kept : history, limit);
}

/**
 * Which of these matches have two or more taken seats (joined or confirmed). One read after the history,
 * bounded by its 200 ids and started from `slots_event_position_idx` (the event's own seats), so its
 * cost is the player's own matches, never the table. Exported for the test that reads its plan.
 */
export function playedMatchRead(db: Db, eventIds: readonly string[]) {
  return db
    .select({ id: slots.eventId })
    .from(slots)
    .where(and(inArray(slots.eventId, [...eventIds]), inArray(slots.status, ["joined", "confirmed"])))
    .groupBy(slots.eventId)
    .having(sql`count(*) >= 2`);
}

async function playedMatchIds(db: Db, eventIds: readonly string[]): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  return new Set((await playedMatchRead(db, eventIds)).map((r) => r.id));
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
 * and also sat in counts once. The usual times (`timePatternsOf`, after `getPlayerTimePatterns` keeps
 * the matches people played, by `id`) and the usual clubs (the best times,
 * `src/lib/domain/freeCourts.ts`) are both read off it.
 */
export async function getPlayerHistory(db: Db, playerId: string, limit = 200): Promise<{ id: string; startsAt: Date; tz: string; venueSlug: string | null; durationMinutes: number }[]> {
  const [madeRead, playedRead] = playerHistoryReads(db, playerId, limit);
  const made = await madeRead;
  const played = await playedRead;
  const byId = new Map([...made, ...played].map((r) => [r.id, r]));
  return [...byId.values()].sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime()).slice(0, limit);
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
