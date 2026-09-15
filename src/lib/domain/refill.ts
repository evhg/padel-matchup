import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, events, groupMembers, players, pushSubscriptions, slots, type Event, type Player } from "@/db/schema";
import { REFILL_FANOUT_MAX, REFILL_MIN_NOTICE_MS, REFILL_WINDOW_MS } from "@/lib/config";
import { markWantsNotified, matchingWants } from "./demand";

/**
 * A spot that opens, and the people who would take it.
 *
 * Somebody drops out the evening before. The waitlist is empty, so the slot just sits there: three
 * players turn up, or nobody does. Meanwhile the same crew's other members and the regulars at that
 * club are free that night and never hear about it. Every ingredient for the match to happen exists;
 * nothing joins them.
 *
 * This joins them, and the shape is deliberately narrow, because the failure mode of "tell people
 * about spots" is a mailing list nobody reads:
 *
 *   - one notice per match, ever, claimed in the database before anything goes out;
 *   - only inside a window: far enough out that somebody can get there, close enough that the crew
 *     was not going to fill it themselves;
 *   - only to people who already belong to the match's world — its crew, or the club's regulars —
 *     never to a list of everyone;
 *   - only to people the match's level range admits, and who turned push on;
 *   - capped, hard (rule 12).
 *
 * A private match with no crew reaches nobody by design: there is no audience, so no notice is sent
 * and none is spent.
 */

/** What the decision needs, so the rule can be read and tested without a database. */
export type RefillJudgement = Pick<Event, "status" | "startsAt" | "refillNoticeAt">;

export function isRefillDue(ev: RefillJudgement, openSpots: number, now: Date): boolean {
  if (ev.status !== "open") return false;
  if (ev.refillNoticeAt) return false;
  if (openSpots <= 0) return false;
  const until = ev.startsAt.getTime() - now.getTime();
  return until >= REFILL_MIN_NOTICE_MS && until <= REFILL_WINDOW_MS;
}

/** A match reaches somebody when it has a crew, or when it is on a club's board for all to see. */
export function hasRefillAudience(ev: Pick<Event, "groupId" | "publicListing" | "venueSlug">): boolean {
  return Boolean(ev.groupId) || (ev.publicListing && Boolean(ev.venueSlug));
}

/** Roster seats nobody holds: empty, or a reserved invitation that was declined. */
export async function openRosterSpots(db: Db, ev: Pick<Event, "id" | "capacity">): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(slots)
    .where(and(eq(slots.eventId, ev.id), lte(slots.position, ev.capacity), inArray(slots.status, ["empty", "declined"])));
  return row?.n ?? 0;
}

/**
 * Takes the one notice this match will ever send. Two callers can reach this at once — a player
 * tapping "leave" and the hourly sweep — and exactly one of them walks away with it.
 */
export async function claimRefillNotice(db: Db, eventId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(events)
    .set({ refillNoticeAt: now })
    .where(and(eq(events.id, eventId), isNull(events.refillNoticeAt)))
    .returning({ id: events.id });
  return rows.length === 1;
}

/** The match admits this player: no range means everyone, a range means an unrated player is not chased. */
function admits(ev: Pick<Event, "levelMin" | "levelMax">, p: Pick<Player, "level">): boolean {
  if (ev.levelMin === null && ev.levelMax === null) return true;
  if (p.level === null) return false;
  if (ev.levelMin !== null && p.level < ev.levelMin) return false;
  if (ev.levelMax !== null && p.level > ev.levelMax) return false;
  return true;
}

/** How many candidates are looked at before the level filter, so one freed spot reads a bounded number of rows. */
const CANDIDATE_MAX = 200;
/** How far back "plays at that club" reaches. Matches still to come count too: they are the same people. */
const REGULAR_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Who to tell, in the order they are told: the crew first, because a spot in their own match is
 * theirs before it is anyone's, then the club's regulars. Out: everybody already in the match, however
 * they got there — joined, waiting, invited, or declined, because a declined invitation is an answer;
 * the organiser, who is told about every departure by name; and whoever just left or was taken out,
 * because the seat on offer is the one they gave up.
 *
 * Queries run one after another on purpose: the pooler stalls on pipelined bursts (rule 8).
 */
export async function refillAudience(db: Db, ev: Event, now: Date): Promise<Player[]> {
  const taken = await db
    .select({ playerId: slots.playerId })
    .from(slots)
    .where(and(eq(slots.eventId, ev.id), isNotNull(slots.playerId)));
  const excluded = new Set(taken.map((r) => r.playerId).filter((id): id is string => Boolean(id)));
  // The organiser hears about every departure by name already; a second buzz adds nothing.
  excluded.add(ev.creatorPlayerId);
  // And whoever left or was taken out: the seat on offer is the one they just gave up. Their slot was
  // emptied, so nothing else remembers them — only the log does.
  const gone = await db
    .select({ actorPlayerId: activity.actorPlayerId, verb: activity.verb, meta: activity.meta })
    .from(activity)
    .where(and(eq(activity.eventId, ev.id), inArray(activity.verb, ["left", "removed"])))
    .limit(200);
  for (const row of gone) {
    if (row.verb === "left" && row.actorPlayerId) excluded.add(row.actorPlayerId);
    const target = row.meta?.targetPlayerId;
    if (row.verb === "removed" && typeof target === "string") excluded.add(target);
  }

  const ordered: string[] = [];
  const add = (id: string | null) => {
    if (id && !excluded.has(id) && !ordered.includes(id) && ordered.length < CANDIDATE_MAX) ordered.push(id);
  };

  // Whoever asked for this hour at this place comes first. A standing want is the strongest signal
  // there is that somebody will take the seat — stronger than belonging to the crew, and far stronger
  // than having played at the club once in three months — and the fan-out is capped, so order decides
  // who actually hears.
  const wanted = await matchingWants(db, ev, now);
  for (const w of wanted) add(w.playerId);
  if (ev.groupId) {
    const crew = await db.select({ playerId: groupMembers.playerId }).from(groupMembers).where(eq(groupMembers.groupId, ev.groupId));
    for (const m of crew) add(m.playerId);
  }
  if (ev.publicListing && ev.venueSlug) {
    const since = new Date(now.getTime() - REGULAR_WINDOW_MS);
    const regulars = await db
      .select({ playerId: slots.playerId })
      .from(slots)
      .innerJoin(events, eq(events.id, slots.eventId))
      .where(and(eq(events.venueSlug, ev.venueSlug), gte(events.startsAt, since), isNotNull(slots.playerId)))
      .limit(400);
    for (const r of regulars) add(r.playerId);
  }
  if (ordered.length === 0) return [];

  // A notice with no channel is not a notice: only people who turned push on are candidates, so the
  // cap below is spent on people who will actually see it.
  const subscribed = await db.selectDistinct({ playerId: pushSubscriptions.playerId }).from(pushSubscriptions).where(inArray(pushSubscriptions.playerId, ordered));
  const reachable = new Set(subscribed.map((r) => r.playerId));
  const ids = ordered.filter((id) => reachable.has(id));
  if (ids.length === 0) return [];

  const rows = await db.select().from(players).where(inArray(players.id, ids));
  const byId = new Map(rows.map((p) => [p.id, p]));
  const out: Player[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (p && admits(ev, p)) out.push(p);
    if (out.length === REFILL_FANOUT_MAX) break;
  }
  return out;
}

/**
 * The whole decision in one call: is this spot worth telling anyone about, who, and is this notice
 * ours to send. Returns null when the answer is no, so the sender has nothing to decide.
 */
export async function refillRecipients(db: Db, eventId: string, now: Date): Promise<{ event: Event; players: Player[] } | null> {
  const [ev] = await db.select().from(events).where(eq(events.id, eventId));
  if (!ev || !hasRefillAudience(ev)) return null;
  if (!isRefillDue(ev, await openRosterSpots(db, ev), now)) return null;
  const people = await refillAudience(db, ev, now);
  if (people.length === 0) return null;
  // Claimed last: a match nobody can be told about keeps its notice for a tick when somebody can be.
  if (!(await claimRefillNotice(db, ev.id, now))) return null;
  // A want answered by this push has had its answer. Without this the hourly sweep would find the
  // same people again and tell them about the same match a second time.
  const told = new Set(people.map((p) => p.id));
  await markWantsNotified(db, (await matchingWants(db, ev, now)).filter((w) => told.has(w.playerId)).map((w) => w.id), now);
  return { event: ev, players: people };
}

/**
 * The hourly sweep. A spot opens by more paths than a person tapping "leave" — an organiser removes
 * somebody, an invitation is declined, a tournament shrinks — and this catches every one of them.
 */
export async function findRefillsDue(db: Db, now: Date): Promise<Event[]> {
  const from = new Date(now.getTime() + REFILL_MIN_NOTICE_MS);
  const to = new Date(now.getTime() + REFILL_WINDOW_MS);
  const rows = await db
    .select({ event: events })
    .from(events)
    .innerJoin(slots, and(eq(slots.eventId, events.id), lte(slots.position, events.capacity), inArray(slots.status, ["empty", "declined"])))
    .where(
      and(
        eq(events.status, "open"),
        isNull(events.refillNoticeAt),
        gte(events.startsAt, from),
        lte(events.startsAt, to),
        or(isNotNull(events.groupId), and(eq(events.publicListing, true), isNotNull(events.venueSlug))),
      ),
    )
    .groupBy(events.id)
    // Soonest first: if a tick ever hits the cap, the matches closest to starting are the ones that
    // cannot wait an hour for the next one.
    .orderBy(asc(events.startsAt))
    .limit(50);
  return rows.map((r) => r.event);
}
