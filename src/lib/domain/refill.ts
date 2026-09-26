import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, max, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import { activity, events, groupMembers, players, pushSubscriptions, slots, type Event, type Player } from "@/db/schema";
import { EVENT_DURATION_MS, REFILL_EMAIL_MAX, REFILL_FANOUT_MAX, REFILL_MIN_NOTICE_MS, REFILL_WHATSAPP_MAX, REFILL_WINDOW_MS } from "@/lib/config";
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
 *   - only to people who already belong to the match's world — its crew, the club's regulars, or
 *     the people its players played with in the last sixty days — never to a list of everyone;
 *   - only to people the match's level range admits, and whom a channel reaches: the bot, their
 *     WhatsApp number, an address they did not mute, or a device with push on;
 *   - capped, hard (rule 12).
 *
 * A private match with no crew reaches its players' past partners and nobody else: they are the
 * people who would take the fourth spot (the owner, 25 September 2026). On 24 September ten of
 * thirteen past matches never got past one or two players, and every match that filled was scored:
 * a match is lost at filling. Strangers still never hear about a private match.
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

/**
 * A match reaches beyond its players' own partners when it has a crew, or when it is on a club's
 * board for all to see. Without either it is private: only the people its players played with hear.
 */
export function reachesBeyondPartners(ev: Pick<Event, "groupId" | "publicListing" | "venueSlug">): boolean {
  return Boolean(ev.groupId) || (ev.publicListing && Boolean(ev.venueSlug));
}

/** The channels this deployment has (rule 4). The caller says which, because the domain reads no environment. WhatsApp left out means off. */
export type RefillReach = { telegram: boolean; whatsapp?: boolean; email: boolean; push: boolean };

/** What the notice needs about a person: who, the level the range asks about, the language, the channels. */
export type RefillPerson = Pick<Player, "id" | "displayName" | "locale" | "level" | "telegramId" | "phone" | "email" | "emailNotifications">;

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
/** How far back "played with somebody in this match" reaches. Only finished matches count: a partner is somebody you played with. */
export const PARTNER_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
/** How many past partners one match reads, the freshest first. Four players' sixty days is rarely more than a few dozen people. */
const PARTNER_MAX = 100;
const SEATED = ["joined", "confirmed"] as const;

/**
 * The people the players now seated in this match played with: a finished, not cancelled match in the
 * last sixty days, both in its line-up. The freshest partner first. One query, and every step of it
 * walks an index: this match's seats, each of its players' seats (`slots_player_idx`), that match by
 * its key, that match's seats. Only a match makes partners, and only a match looks for them: thirty
 * people in one americano are not thirty partners.
 */
export async function pastPartners(db: Db, ev: Pick<Event, "id" | "type" | "capacity">, now: Date): Promise<string[]> {
  if (ev.type !== "match") return [];
  const here = alias(slots, "here");
  const mine = alias(slots, "mine");
  const theirs = alias(slots, "theirs");
  const since = new Date(now.getTime() - PARTNER_WINDOW_MS);
  const finished = new Date(now.getTime() - EVENT_DURATION_MS);
  const rows = await db
    .select({ playerId: theirs.playerId })
    .from(here)
    .innerJoin(mine, and(eq(mine.playerId, here.playerId), ne(mine.eventId, here.eventId), inArray(mine.status, [...SEATED])))
    .innerJoin(events, and(eq(events.id, mine.eventId), eq(events.type, "match"), ne(events.status, "cancelled"), gte(events.startsAt, since), lte(events.startsAt, finished), lte(mine.position, events.capacity)))
    .innerJoin(theirs, and(eq(theirs.eventId, events.id), inArray(theirs.status, [...SEATED]), lte(theirs.position, events.capacity), isNotNull(theirs.playerId), ne(theirs.playerId, mine.playerId)))
    .where(and(eq(here.eventId, ev.id), inArray(here.status, [...SEATED]), lte(here.position, ev.capacity), isNotNull(here.playerId)))
    .groupBy(theirs.playerId)
    .orderBy(desc(max(events.startsAt)))
    .limit(PARTNER_MAX);
  return rows.map((r) => r.playerId).filter((id): id is string => Boolean(id));
}

/**
 * Whether a channel reaches this person on this deployment, in the order `channelFor` in
 * `src/lib/coach/notify.ts` tries them: the bot, then the WhatsApp number that wrote to us, then an
 * address they did not mute, then a device. The two must agree, or the cap is spent on somebody the
 * sender then cannot reach.
 */
function channelOf(p: Pick<Player, "id" | "telegramId" | "phone" | "email" | "emailNotifications">, reach: RefillReach, devices: Set<string>): "telegram" | "whatsapp" | "email" | "push" | null {
  if (reach.telegram && p.telegramId) return "telegram";
  if (reach.whatsapp && p.phone) return "whatsapp";
  if (reach.email && p.email && p.emailNotifications) return "email";
  return reach.push && devices.has(p.id) ? "push" : null;
}

/**
 * Who to tell, in the order they are told: whoever asked for this hour, the crew, because a spot in
 * their own match is theirs before it is anyone's, the players' past partners, then the club's
 * regulars. A private match skips the first and the last, who are strangers to it. Out: everybody already in the match, however
 * they got there — joined, waiting, invited, or declined, because a declined invitation is an answer;
 * the organiser, who is told about every departure by name; and whoever just left or was taken out,
 * because the seat on offer is the one they gave up.
 *
 * Queries run one after another on purpose: the pooler stalls on pipelined bursts (rule 8).
 */
export async function refillAudience(db: Db, ev: Event, now: Date, reach: RefillReach): Promise<RefillPerson[]> {
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
  // who actually hears. A private match tells nobody who asked: they are strangers to it.
  if (reachesBeyondPartners(ev)) for (const w of await matchingWants(db, ev, now)) add(w.playerId);
  if (ev.groupId) {
    const crew = await db.select({ playerId: groupMembers.playerId }).from(groupMembers).where(eq(groupMembers.groupId, ev.groupId));
    for (const m of crew) add(m.playerId);
  }
  // The people its players played with lately. For a private match they are the whole audience.
  for (const id of await pastPartners(db, ev, now)) add(id);
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

  // A notice with no channel is not a notice: only people a channel reaches are candidates, so the
  // cap below is spent on people who will actually see it. Up to two hundred candidates are read, so
  // only the columns the decision and the notice need, never the whole row.
  const rows = await db
    .select({ id: players.id, displayName: players.displayName, locale: players.locale, level: players.level, telegramId: players.telegramId, phone: players.phone, email: players.email, emailNotifications: players.emailNotifications })
    .from(players)
    .where(inArray(players.id, ordered));
  const devices = new Set<string>();
  if (reach.push) {
    const subscribed = await db.selectDistinct({ playerId: pushSubscriptions.playerId }).from(pushSubscriptions).where(inArray(pushSubscriptions.playerId, ordered));
    for (const r of subscribed) devices.add(r.playerId);
  }
  const byId = new Map(rows.map((p) => [p.id, p]));
  const out: RefillPerson[] = [];
  let emails = 0;
  let whatsapps = 0;
  for (const id of ordered) {
    const p = byId.get(id);
    const via = p && admits(ev, p) ? channelOf(p, reach, devices) : null;
    if (!p || !via) continue;
    // Email is the channel here a free tier counts (REFILL_EMAIL_MAX), and WhatsApp the one Meta bills (REFILL_WHATSAPP_MAX).
    if (via === "email" && emails++ >= REFILL_EMAIL_MAX) continue;
    if (via === "whatsapp" && whatsapps++ >= REFILL_WHATSAPP_MAX) continue;
    out.push(p);
    if (out.length === REFILL_FANOUT_MAX) break;
  }
  return out;
}

/**
 * The whole decision in one call: is this spot worth telling anyone about, who, and is this notice
 * ours to send. Returns null when the answer is no, so the sender has nothing to decide.
 */
export async function refillRecipients(db: Db, eventId: string, now: Date, reach: RefillReach): Promise<{ event: Event; players: RefillPerson[] } | null> {
  const [ev] = await db.select().from(events).where(eq(events.id, eventId));
  if (!ev) return null;
  if (!isRefillDue(ev, await openRosterSpots(db, ev), now)) return null;
  const people = await refillAudience(db, ev, now, reach);
  if (people.length === 0) return null;
  // Claimed last: a match nobody can be told about keeps its notice for a tick when somebody can be.
  if (!(await claimRefillNotice(db, ev.id, now))) return null;
  // A want answered by this push has had its answer. Without this the hourly sweep would find the
  // same people again and tell them about the same match a second time.
  const told = new Set(people.map((p) => p.id));
  if (reachesBeyondPartners(ev)) await markWantsNotified(db, (await matchingWants(db, ev, now)).filter((w) => told.has(w.playerId)).map((w) => w.id), now);
  return { event: ev, players: people };
}

/**
 * The hourly sweep. A spot opens by more paths than a person tapping "leave" — an organiser removes
 * somebody, an invitation is declined, a tournament shrinks — and this catches every one of them. It
 * also catches the commonest open spot of all: the one nobody ever took, in a match that enters the
 * window with one or two players in it.
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
        or(
          isNotNull(events.groupId),
          and(eq(events.publicListing, true), isNotNull(events.venueSlug)),
          // A private match reaches its players' past partners, so it has an audience only once somebody sits in it.
          and(eq(events.type, "match"), sql`exists (select 1 from ${slots} p where p.event_id = ${events.id} and p.player_id is not null and p.status in ('joined', 'confirmed'))`),
        ),
      ),
    )
    .groupBy(events.id)
    // Soonest first: if a tick ever hits the cap, the matches closest to starting are the ones that
    // cannot wait an hour for the next one.
    .orderBy(asc(events.startsAt))
    .limit(50);
  return rows.map((r) => r.event);
}
