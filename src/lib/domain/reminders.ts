import { and, eq, gt, inArray, isNotNull, lte, or, sql, isNull, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, scores, slots, tournamentMatches, tournamentRounds, type Event, type Player, type Slot } from "@/db/schema";
import { INVITE_REMINDER_INTERVAL_MS, SECOND_SCORE_REMINDER_DELAY_MS } from "@/lib/config";
import { isOver, SHORTEST_LENGTH } from "./matchLength";

/**
 * "The event is over by `now`", as a query: its start plus its own length has come (`eventEnd` in
 * `./matchLength.ts`, the same rule in SQL). Two conditions: the start bound walks
 * `events_starts_at_idx` and holds for every length, because nothing ends sooner than the shortest;
 * the exact test reads the row's own `duration_minutes`. `now` goes in as text, never as a Date
 * (rule 1: postgres-js refuses a Date inside a raw template).
 */
export function endedBy(now: Date): SQL[] {
  return [lte(events.startsAt, new Date(now.getTime() - SHORTEST_LENGTH * 60_000)), sql`${events.startsAt} + make_interval(mins => ${events.durationMinutes}) <= ${now.toISOString()}::timestamptz`];
}

/**
 * Decision 12: unconfirmed invitees with an email are reminded every 24h,
 * stopping on response or event start.
 */
export function isInviteReminderDue(
  slot: Pick<Slot, "status" | "invitedEmail" | "invitedAt" | "lastRemindedAt">,
  event: Pick<Event, "status" | "startsAt">,
  now: Date,
): boolean {
  if (slot.status !== "invited") return false;
  if (!slot.invitedEmail) return false;
  if (event.status !== "open" && event.status !== "full") return false;
  if (event.startsAt.getTime() <= now.getTime()) return false;
  const anchor = slot.lastRemindedAt ?? slot.invitedAt;
  if (!anchor) return true;
  return anchor.getTime() + INVITE_REMINDER_INTERVAL_MS <= now.getTime();
}

export async function findInviteRemindersDue(db: Db, now = new Date()): Promise<{ slot: Slot; event: Event; creator: Player }[]> {
  const cutoff = new Date(now.getTime() - INVITE_REMINDER_INTERVAL_MS);
  const rows = await db
    .select({ slot: slots, event: events, creator: players })
    .from(slots)
    .innerJoin(events, eq(events.id, slots.eventId))
    .innerJoin(players, eq(players.id, events.creatorPlayerId))
    .where(
      and(
        eq(slots.status, "invited"),
        isNotNull(slots.invitedEmail),
        inArray(events.status, ["open", "full"]),
        gt(events.startsAt, now),
        or(
          and(sql`${slots.lastRemindedAt} is null`, or(sql`${slots.invitedAt} is null`, lte(slots.invitedAt, cutoff))),
          lte(slots.lastRemindedAt, cutoff),
        ),
      ),
    );
  return rows.filter((r) => isInviteReminderDue(r.slot, r.event, now));
}

export async function markInviteReminded(db: Db, slotId: string, now = new Date()) {
  await db.update(slots).set({ lastRemindedAt: now }).where(eq(slots.id, slotId));
}

/**
 * Decision 13 and rule 16: the first ask for the score goes once, when the match ends (its start plus
 * the length the organiser chose), only while no score has been entered. It read "two hours after the
 * start" while every match lasted two hours; for a 60-minute match that was an hour after everybody
 * had gone home.
 */
export function isScoreReminderDue(
  event: Pick<Event, "status" | "startsAt" | "durationMinutes" | "scoreReminderSent" | "standings" | "type">,
  hasScores: boolean,
  now: Date,
): boolean {
  if (event.scoreReminderSent) return false;
  if (event.status === "cancelled") return false;
  if (hasScores) return false;
  if (event.type === "tournament" && event.standings && event.standings.length > 0) return false;
  return isOver(event, now);
}

export async function findScoreRemindersDue(db: Db, now = new Date()): Promise<{ event: Event; creator: Player }[]> {
  const rows = await db
    .select({
      event: events,
      creator: players,
      scoreCount: sql<number>`(select count(*) from ${scores} sc where sc.event_id = ${events.id}) + (select count(*) from ${tournamentMatches} tm join ${tournamentRounds} tr on tr.id = tm.round_id where tr.event_id = ${events.id} and tm.side_a is not null)`,
    })
    .from(events)
    .innerJoin(players, eq(players.id, events.creatorPlayerId))
    .where(and(eq(events.scoreReminderSent, false), inArray(events.status, ["open", "full", "past"]), ...endedBy(now)));
  return rows.filter((r) => isScoreReminderDue(r.event, Number(r.scoreCount) > 0, now)).map(({ event, creator }) => ({ event, creator }));
}

/**
 * The second and last ask, the morning after.
 *
 * One nudge at two hours is a single roll of the dice: it lands while people are still at the club
 * or it does not land at all, and a match with no score moves nobody's level, enters no ranking and
 * records no podium. The level is the number the whole product is built on, so it is worth asking
 * twice and not worth asking a third time.
 */
export function isSecondScoreReminderDue(
  event: Pick<Event, "status" | "startsAt" | "scoreReminderSent" | "scoreReminder2At" | "standings" | "type">,
  hasScores: boolean,
  now: Date,
): boolean {
  if (!event.scoreReminderSent) return false;
  if (event.scoreReminder2At) return false;
  if (event.status === "cancelled") return false;
  if (hasScores) return false;
  if (event.type === "tournament" && event.standings && event.standings.length > 0) return false;
  return event.startsAt.getTime() + SECOND_SCORE_REMINDER_DELAY_MS <= now.getTime();
}

export async function findSecondScoreRemindersDue(db: Db, now = new Date()): Promise<{ event: Event; creator: Player }[]> {
  const cutoff = new Date(now.getTime() - SECOND_SCORE_REMINDER_DELAY_MS);
  const rows = await db
    .select({
      event: events,
      creator: players,
      scoreCount: sql<number>`(select count(*) from ${scores} sc where sc.event_id = ${events.id}) + (select count(*) from ${tournamentMatches} tm join ${tournamentRounds} tr on tr.id = tm.round_id where tr.event_id = ${events.id} and tm.side_a is not null)`,
    })
    .from(events)
    .innerJoin(players, eq(players.id, events.creatorPlayerId))
    .where(and(eq(events.scoreReminderSent, true), isNull(events.scoreReminder2At), inArray(events.status, ["open", "full", "past"]), lte(events.startsAt, cutoff)));
  return rows.filter((r) => isSecondScoreReminderDue(r.event, Number(r.scoreCount) > 0, now)).map(({ event, creator }) => ({ event, creator }));
}

export async function markSecondScoreReminderSent(db: Db, eventId: string, now = new Date()) {
  await db.update(events).set({ scoreReminder2At: now }).where(eq(events.id, eventId));
}

export async function markScoreReminderSent(db: Db, eventId: string) {
  await db.update(events).set({ scoreReminderSent: true }).where(eq(events.id, eventId));
}

/** open/full → past once the event has finished: its start plus its own length. */
export function shouldBePast(event: Pick<Event, "status" | "startsAt" | "durationMinutes">, now: Date): boolean {
  if (event.status !== "open" && event.status !== "full") return false;
  return isOver(event, now);
}

/** The hourly sweep: every open or full event whose own length has run out becomes past. */
export async function transitionPastEvents(db: Db, now = new Date()): Promise<number> {
  const updated = await db
    .update(events)
    .set({ status: "past" })
    .where(and(inArray(events.status, ["open", "full"]), ...endedBy(now)))
    .returning({ id: events.id });
  return updated.length;
}
