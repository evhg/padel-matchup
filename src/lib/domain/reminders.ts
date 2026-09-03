import { and, eq, gt, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, scores, slots, type Event, type Player, type Slot } from "@/db/schema";
import { EVENT_DURATION_MS, INVITE_REMINDER_INTERVAL_MS, SCORE_REMINDER_DELAY_MS } from "@/lib/config";

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
 * Decision 13: the creator gets exactly ONE score reminder, 2h after start,
 * only if no score has been entered yet.
 */
export function isScoreReminderDue(
  event: Pick<Event, "status" | "startsAt" | "scoreReminderSent" | "standings" | "type">,
  hasScores: boolean,
  now: Date,
): boolean {
  if (event.scoreReminderSent) return false;
  if (event.status === "cancelled") return false;
  if (hasScores) return false;
  if (event.type === "tournament" && event.standings && event.standings.length > 0) return false;
  return event.startsAt.getTime() + SCORE_REMINDER_DELAY_MS <= now.getTime();
}

export async function findScoreRemindersDue(db: Db, now = new Date()): Promise<{ event: Event; creator: Player }[]> {
  const cutoff = new Date(now.getTime() - SCORE_REMINDER_DELAY_MS);
  const rows = await db
    .select({ event: events, creator: players, scoreCount: sql<number>`(select count(*) from ${scores} sc where sc.event_id = ${events.id})` })
    .from(events)
    .innerJoin(players, eq(players.id, events.creatorPlayerId))
    .where(and(eq(events.scoreReminderSent, false), inArray(events.status, ["open", "full", "past"]), lte(events.startsAt, cutoff)));
  return rows.filter((r) => isScoreReminderDue(r.event, Number(r.scoreCount) > 0, now)).map(({ event, creator }) => ({ event, creator }));
}

export async function markScoreReminderSent(db: Db, eventId: string) {
  await db.update(events).set({ scoreReminderSent: true }).where(eq(events.id, eventId));
}

/** open/full → past once the event has finished (start + duration). */
export function shouldBePast(event: Pick<Event, "status" | "startsAt">, now: Date): boolean {
  if (event.status !== "open" && event.status !== "full") return false;
  return event.startsAt.getTime() + EVENT_DURATION_MS <= now.getTime();
}

export async function transitionPastEvents(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EVENT_DURATION_MS);
  const updated = await db
    .update(events)
    .set({ status: "past" })
    .where(and(inArray(events.status, ["open", "full"]), lte(events.startsAt, cutoff)))
    .returning({ id: events.id });
  return updated.length;
}
