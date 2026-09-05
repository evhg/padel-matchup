import { and, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, pushSubscriptions, slots, type Event } from "@/db/schema";
import { cancelEvent } from "./events";
import { leaveEvent, type Promotion } from "./slots";

/**
 * Deleting an account = removing the person, keeping the padel. The row stays
 * (scores and standings reference it) but carries no personal data anymore.
 */
export async function anonymizePlayer(db: Db, playerId: string, now = new Date()): Promise<{ cancelledEvents: Event[]; leftEvents: { event: Event; promotion: Promotion | null }[] }> {
  const upcomingOwn = await db
    .select()
    .from(events)
    .where(and(eq(events.creatorPlayerId, playerId), gt(events.startsAt, now), inArray(events.status, ["open", "full"])));
  const cancelledEvents: Event[] = [];
  for (const ev of upcomingOwn) cancelledEvents.push(await cancelEvent(db, ev.id, playerId));

  const mySlots = await db
    .select({ eventId: slots.eventId })
    .from(slots)
    .innerJoin(events, eq(events.id, slots.eventId))
    .where(and(eq(slots.playerId, playerId), gt(events.startsAt, now), inArray(events.status, ["open", "full"]), inArray(slots.status, ["joined", "confirmed"])));
  const leftEvents: { event: Event; promotion: Promotion | null }[] = [];
  for (const s of mySlots) {
    try {
      const r = await leaveEvent(db, { eventId: s.eventId, playerId, now });
      leftEvents.push({ event: r.event, promotion: r.promotion });
    } catch {
      /* already gone */
    }
  }

  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.playerId, playerId));
  await db
    .update(players)
    .set({ displayName: "Deleted player", email: null, recoveryEmail: null, phone: null, personalToken: null, previousToken: null, emailVerifiedAt: null, emailNotifications: false, homescreenAt: null })
    .where(eq(players.id, playerId));
  return { cancelledEvents, leftEvents };
}
