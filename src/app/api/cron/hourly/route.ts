import { NextResponse } from "next/server";
import { reportError } from "@/lib/alerts";
import { getDb } from "@/db";
import {
  findInviteRemindersDue,
  findScoreRemindersDue,
  markInviteReminded,
  markScoreReminderSent,
  transitionPastEvents,
} from "@/lib/domain/reminders";
import { emitMatchEvent, processWebhookRetries } from "@/lib/api/webhooks";
import { autoCreateGroupMatches } from "@/lib/domain/groups";
import { setMetric, snapshotMetrics } from "@/lib/domain/metrics";
import { promoteWaitlists } from "@/lib/domain/slots";
import { getEventDetail } from "@/lib/domain/queries";
import { notifyGroupMatch, notifyLineupChange, notifyPromotion, sendInviteReminder, sendScoreReminder } from "@/lib/notify";
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
 *  5. automatic group matches (weekly slots) + member notifications
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
  const summary = { transitionedToPast: 0, promotions: 0, inviteReminders: 0, scoreReminders: 0, groupMatches: 0, webhookRetries: 0, errors: [] as string[] };

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
      if (!ev) continue;
      // A hygiene promotion fills a hole, so the line-up was not complete before it.
      const fresh = await notifyLineupChange(db, ev, false, p.playerId);
      await notifyPromotion(db, fresh ?? ev, p);
    }
  } catch (e) {
    summary.errors.push(`waitlist: ${String(e)}`);
  }

  try {
    const due = await findInviteRemindersDue(db, now);
    for (const { slot, event, creator } of due) {
      const sent = await sendInviteReminder(db, event, slot, creator);
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
      await sendScoreReminder(db, event, creator);
      await markScoreReminderSent(db, event.id);
      summary.scoreReminders++;
      void getEventDetail;
    }
  } catch (e) {
    summary.errors.push(`scores: ${String(e)}`);
  }

  try {
    // Weekly group slots: create the next match a few days ahead and ping the members.
    const created = await autoCreateGroupMatches(db, now);
    summary.groupMatches = created.length;
    for (const c of created) {
      await notifyGroupMatch(db, c.group, c.event, null);
      await emitMatchEvent(db, "match.created", c.event.code, { automatic: true });
    }
  } catch (e) {
    summary.errors.push(`groups: ${String(e)}`);
  }

  try {
    summary.webhookRetries = (await processWebhookRetries(db, now)).attempted;
  } catch (e) {
    summary.errors.push(`webhooks: ${String(e)}`);
  }

  try {
    await snapshotMetrics(db);
    await setMetric(db, "cron_hourly_at", Math.floor(now.getTime() / 1000));
  } catch (e) {
    summary.errors.push(`metrics: ${String(e)}`);
  }

  if (summary.errors.length) await reportError("cron", summary.errors.join(" | "));
  return NextResponse.json({ ok: summary.errors.length === 0, at: now.toISOString(), ...summary });
}
