import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  findInviteRemindersDue,
  findScoreRemindersDue,
  markInviteReminded,
  markScoreReminderSent,
  transitionPastEvents,
} from "@/lib/domain/reminders";
import { promoteWaitlists } from "@/lib/domain/slots";
import { getEventDetail } from "@/lib/domain/queries";
import { notifyPromotion, sendInviteReminder, sendScoreReminder } from "@/lib/notify";
import { eq } from "drizzle-orm";
import { events } from "@/db/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel Cron (schedule in vercel.json: daily on Hobby, hourly on Pro). Guarded by CRON_SECRET when set.
 *  1. open/full → past transitions
 *  2. waitlist hygiene (fill any empty roster slot from the waitlist)
 *  3. 24h reminders to unconfirmed invitees with an email
 *  4. the single post-match score reminder to organizers
 */
export async function GET(req: Request) {
  // Vercel sends "Authorization: Bearer $CRON_SECRET" when the variable is set.
  // Without it the job still runs; every step is idempotent and rate-limited by DB state.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (secret && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = await getDb();
  const now = new Date();
  const summary = { transitionedToPast: 0, promotions: 0, inviteReminders: 0, scoreReminders: 0, errors: [] as string[] };

  try {
    summary.transitionedToPast = await transitionPastEvents(db, now);
  } catch (e) {
    summary.errors.push(`past: ${String(e)}`);
  }

  try {
    const promotions = await promoteWaitlists(db, now);
    summary.promotions = promotions.length;
    for (const p of promotions) {
      const [ev] = await db.select().from(events).where(eq(events.id, p.slot.eventId));
      if (ev) await notifyPromotion(db, ev, p);
    }
  } catch (e) {
    summary.errors.push(`waitlist: ${String(e)}`);
  }

  try {
    const due = await findInviteRemindersDue(db, now);
    for (const { slot, event, creator } of due) {
      const sent = await sendInviteReminder(event, slot, creator);
      if (sent) {
        await markInviteReminded(db, slot.id, now);
        summary.inviteReminders++;
      }
    }
  } catch (e) {
    summary.errors.push(`invites: ${String(e)}`);
  }

  try {
    const due = await findScoreRemindersDue(db, now);
    for (const { event, creator } of due) {
      // Exactly one reminder per event, whether or not an email could go out
      // (the in-app banner covers organizers without an email).
      await sendScoreReminder(event, creator);
      await markScoreReminderSent(db, event.id);
      summary.scoreReminders++;
      void getEventDetail;
    }
  } catch (e) {
    summary.errors.push(`scores: ${String(e)}`);
  }

  return NextResponse.json({ ok: summary.errors.length === 0, at: now.toISOString(), ...summary });
}
