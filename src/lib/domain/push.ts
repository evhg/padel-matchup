import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, pushSubscriptions, type Event, type PushSubscription } from "@/db/schema";

/** Reminder goes out once, inside the last hour before the start. */
export const PUSH_REMINDER_LEAD_MS = 60 * 60 * 1000;

export type SubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };

export async function savePushSubscription(db: Db, playerId: string, sub: SubscriptionInput, userAgent?: string | null, now = new Date()): Promise<void> {
  await db
    .insert(pushSubscriptions)
    .values({ playerId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent ?? null, lastSeenAt: now })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { playerId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent ?? null, lastSeenAt: now },
    });
}

export async function removePushSubscription(db: Db, endpoint: string): Promise<void> {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}

export async function playerHasPush(db: Db, playerId: string): Promise<boolean> {
  const [row] = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.playerId, playerId)).limit(1);
  return Boolean(row);
}

export async function subscriptionsFor(db: Db, playerIds: string[]): Promise<PushSubscription[]> {
  if (playerIds.length === 0) return [];
  return db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.playerId, playerIds));
}

export function isPushReminderDue(ev: Pick<Event, "status" | "startsAt" | "pushReminderSentAt">, now: Date): boolean {
  if (ev.pushReminderSentAt) return false;
  if (ev.status !== "open" && ev.status !== "full") return false;
  const delta = ev.startsAt.getTime() - now.getTime();
  return delta > 0 && delta <= PUSH_REMINDER_LEAD_MS;
}

export async function findPushRemindersDue(db: Db, now = new Date()): Promise<Event[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(isNull(events.pushReminderSentAt), inArray(events.status, ["open", "full"]), gt(events.startsAt, now), lte(events.startsAt, new Date(now.getTime() + PUSH_REMINDER_LEAD_MS))));
  return rows.filter((e) => isPushReminderDue(e, now));
}

/** Claims the reminder for this event; returns false when another run already did. */
export async function markPushReminded(db: Db, eventId: string, now = new Date()): Promise<boolean> {
  const rows = await db.update(events).set({ pushReminderSentAt: now }).where(and(eq(events.id, eventId), isNull(events.pushReminderSentAt))).returning({ id: events.id });
  return rows.length > 0;
}

/** First visit through a home-screen shortcut: remember it so the prompt stops. */
export async function markHomescreen(db: Db, playerId: string, now = new Date()): Promise<void> {
  await db.update(players).set({ homescreenAt: now }).where(and(eq(players.id, playerId), isNull(players.homescreenAt)));
}
