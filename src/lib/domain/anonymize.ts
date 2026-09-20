import { and, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { coachManagers, coaches, events, lessons, players, pushSubscriptions, slots, type Coach, type Event, type Lesson, type Player } from "@/db/schema";
import { dropCoachWantsFor } from "./coachWants";
import { dropWantsFor } from "./demand";
import { cancelLesson, getCoachByPlayerId, type CancelOutcome } from "./coaching";
import { withdrawEntriesOf } from "./competitions";
import { getPlayer } from "./players";
import { cancelEvent } from "./events";
import { leaveEvent, type Promotion } from "./slots";

/** A coach's page closed by the account going: the page as it was, and the lessons it had to cancel. */
export type CoachClosure = { coach: Coach; cancelled: { lesson: Lesson; student: Player | null; outcome: CancelOutcome }[] };

/**
 * Deleting an account = removing the person, keeping the padel. The row stays
 * (scores and standings reference it) but carries no personal data anymore.
 */
export async function anonymizePlayer(
  db: Db,
  playerId: string,
  now = new Date(),
): Promise<{ cancelledEvents: Event[]; leftEvents: { event: Event; promotion: Promotion | null }[]; coachClosure: CoachClosure | null }> {
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

  // A coach's page carries their name, the clubs they teach at, a WhatsApp number and a PromptPay id,
  // and none of it was touched here: the page stayed up, public, under the same name, on a "deleted"
  // account. It goes, and the students expecting an hour are told before it does.
  const coach = await getCoachByPlayerId(db, playerId);
  let coachClosure: CoachClosure | null = null;
  if (coach) {
    const upcoming = await db
      .select()
      .from(lessons)
      .where(and(eq(lessons.coachId, coach.id), eq(lessons.status, "booked"), gt(lessons.startsAt, now)));
    const cancelled: CoachClosure["cancelled"] = [];
    for (const l of upcoming) {
      try {
        const { lesson, outcome } = await cancelLesson(db, { lessonId: l.id, by: "coach", coach }, now);
        cancelled.push({ lesson, student: lesson.studentPlayerId ? await getPlayer(db, lesson.studentPlayerId) : null, outcome });
      } catch {
        /* already cancelled or moved */
      }
    }
    // The freed hours are offered to nobody, unlike an ordinary cancellation: there will be no coach
    // to teach them. Then the row, and nine cascades take students, packages, blocks and the rest.
    await db.delete(coaches).where(eq(coaches.id, coach.id));
    coachClosure = { coach, cancelled };
  }
  // Running someone else's lessons is an access grant, not history: it ends with the account.
  await db.delete(coachManagers).where(eq(coachManagers.playerId, playerId));

  // A pair they were half of leaves the draw; the spot goes to the first pair waiting, if any.
  await withdrawEntriesOf(db, playerId, now);
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.playerId, playerId));
  // What they said they wanted goes with them. It is a standing instruction to contact them, and the
  // one thing an account deletion must not leave behind is a reason to send somebody a message.
  await dropWantsFor(db, playerId);
  await dropCoachWantsFor(db, playerId);
  await db
    .update(players)
    .set({ displayName: "Deleted player", email: null, recoveryEmail: null, phone: null, personalToken: null, previousToken: null, emailVerifiedAt: null, emailNotifications: false, homescreenAt: null })
    .where(eq(players.id, playerId));
  return { cancelledEvents, leftEvents, coachClosure };
}
