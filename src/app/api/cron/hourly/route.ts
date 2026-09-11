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
import { listenTick, type ListenSummary } from "@/lib/listen/tick";
import { sweepProposals } from "@/lib/feedback/propose";
import { researchTick, type ResearchSummary } from "@/lib/research/desk";
import { autoCreateClubEvents } from "@/lib/domain/clubWeek";
import { refreshAllAvailability } from "@/lib/booking/availability";
import { autoCreateGroupMatches } from "@/lib/domain/groups";
import { completePastLessons } from "@/lib/domain/coaching";
import { syncAllCoachCalendars } from "@/lib/coach/sync";
import { monthlyWraps } from "@/lib/coach/wrap";
import { autoCreateSeriesEditions } from "@/lib/domain/series";
import { pingIndexNow } from "@/lib/indexnow";
import { deliverWrap } from "@/lib/coach/wrapSend";
import { translatorFor } from "@/lib/email/templates";
import { APP_NAME, baseUrl } from "@/lib/config";
import { lowPackageNoticesDue } from "@/lib/coach/chains";
import { notifyLowPackage } from "@/lib/coach/notify";
import { runBackup, type BackupResult } from "@/lib/backup";
import { pruneErrors } from "@/lib/alerts";
import { submitIndexNowDaily, type IndexNowResult } from "@/lib/indexnow";
import { relayUptimeIssues } from "@/lib/uptime";
import { alertOnServices, refreshAnthropicCost } from "@/lib/ops/alerts";
import { askOwnerOutreach } from "@/lib/outreach/desk";
import { setMetric, snapshotMetrics } from "@/lib/domain/metrics";
import { promoteWaitlists } from "@/lib/domain/slots";
import { getPlayer } from "@/lib/domain/players";
import { notifyGroupMatch, notifyLineupChange, notifyPromotion, sendCalendarInvite, sendInviteReminder } from "@/lib/notify";
import { nudgeForScore } from "@/lib/afterMatch";
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
  const summary = { proposals: 0, transitionedToPast: 0, promotions: 0, inviteReminders: 0, scoreReminders: 0, groupMatches: 0, clubMatches: 0, webhookRetries: 0, listen: null as null | ListenSummary, research: null as null | ResearchSummary, clubs: null as null | { refreshed: number; errors: number }, backup: null as null | BackupResult, indexnow: null as null | IndexNowResult, uptimeRelayed: 0, outreachAsks: 0, errorsPruned: 0, lessonsDone: 0, calendars: 0, lowPackages: 0, wraps: 0, seriesEditions: 0, serviceAlerts: 0, errors: [] as string[] };

  try {
    summary.transitionedToPast = await transitionPastEvents(db, now);
  } catch (e) {
    summary.errors.push(`past: ${String(e)}`);
  }

  try {
    // Calendars normally run every ten minutes from pg_cron; this is the hourly safety net.
    summary.calendars = (await syncAllCoachCalendars(db, now)).length;
  } catch (e) {
    summary.errors.push(`calendars: ${String(e)}`);
  }

  try {
    summary.lessonsDone = await completePastLessons(db, now);
    for (const n of await lowPackageNoticesDue(db, now)) {
      await notifyLowPackage(n).catch(() => undefined);
      summary.lowPackages++;
    }
  } catch (e) {
    summary.errors.push(`lessons: ${String(e)}`);
  }

  try {
    // An Open that repeats: the next edition of every active series, a few days ahead, once; its page is re-pinged.
    const editions = await autoCreateSeriesEditions(db, now);
    summary.seriesEditions = editions.length;
    for (const e of editions) await emitMatchEvent(db, "match.created", e.event.code, { automatic: true, series: e.series.slug });
    if (editions.length) await pingIndexNow([...new Set(editions.map((e) => `${baseUrl()}/s/${e.series.slug}`))], { db }).catch(() => undefined);
  } catch (e) {
    summary.errors.push(`series: ${String(e)}`);
  }

  try {
    // The 1st of the month, in the morning where they are: one wrap per coach and per club, once.
    const wraps = await monthlyWraps(db, now, { deliver: deliverWrap, translate: translatorFor, baseUrl: baseUrl(), appName: APP_NAME });
    summary.wraps = wraps.coaches + wraps.clubs;
    for (const err of wraps.errors) summary.errors.push(`wrap: ${err}`);
  } catch (e) {
    summary.errors.push(`wraps: ${String(e)}`);
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
    for (const { event } of due) {
      // Exactly one nudge per event, to every player on the channel they have; the in-app banner covers the rest.
      await markScoreReminderSent(db, event.id);
      await nudgeForScore(db, event).catch((e) => summary.errors.push(`nudge ${event.code}: ${String(e)}`));
      summary.scoreReminders++;
    }
  } catch (e) {
    summary.errors.push(`scores: ${String(e)}`);
  }

  try {
    // Weekly group slots: create the next match a few days ahead and ping the members.
    const created = await autoCreateGroupMatches(db, now);
    summary.groupMatches = created.length;
    for (const c of created) {
      await notifyGroupMatch(db, c.group, c.event, c.group.creatorPlayerId);
      // The organizer is seated by the job, so their calendar gets the invitation the web form would have sent, and not the group note as well.
      const organizer = await getPlayer(db, c.group.creatorPlayerId);
      if (organizer) await sendCalendarInvite(db, c.event, organizer).catch(() => undefined);
      await emitMatchEvent(db, "match.created", c.event.code, { automatic: true });
    }
  } catch (e) {
    summary.errors.push(`groups: ${String(e)}`);
  }

  try {
    // The club programme: every live club's due slots become matches on its board; nobody types anything. One slot's trouble is one line here.
    const programme = await autoCreateClubEvents(db, now);
    summary.clubMatches = programme.created.length;
    for (const e of programme.errors) summary.errors.push(`programme: ${e}`);
    for (const c of programme.created) await emitMatchEvent(db, "match.created", c.event.code, { automatic: true, club: c.club.slug }).catch((e) => summary.errors.push(`programme webhook ${c.event.code}: ${String(e)}`));
  } catch (e) {
    summary.errors.push(`programme: ${String(e)}`);
  }

  try {
    summary.webhookRetries = (await processWebhookRetries(db, now)).attempted;
    summary.listen = await listenTick(db, now);
  } catch (e) {
    summary.errors.push(`webhooks: ${String(e)}`);
  }

  try {
    // The research desk: this hour's share of the month's search credits, on the most overdue queries.
    summary.research = await researchTick(db, now);
  } catch (e) {
    summary.errors.push(`research: ${String(e)}`);
  }

  try {
    // Clubs that share a bookings feed: today's free courts, refreshed once an hour.
    summary.clubs = await refreshAllAvailability(db, now);
  } catch (e) {
    summary.errors.push(`clubs: ${String(e)}`);
  }

  try {
    // Once a day: every table into the owner's private backup repository (when configured).
    summary.backup = await runBackup(db, now);
    if (summary.backup.status === "failed") summary.errors.push(`backup: ${summary.backup.error}`);
  } catch (e) {
    summary.errors.push(`backup: ${String(e)}`);
  }

  try {
    // Search engines hear about the pages that changed (IndexNow, once a day).
    summary.indexnow = await submitIndexNowDaily(db, now);
    if (summary.indexnow.status === "failed") summary.errors.push(`indexnow: ${summary.indexnow.httpStatus ?? summary.indexnow.error}`);
  } catch (e) {
    summary.errors.push(`indexnow: ${String(e)}`);
  }

  try {
    // Outages the outside probe recorded reach the owner even when the probe itself could not tell them.
    summary.uptimeRelayed = (await relayUptimeIssues(db, now)).relayed;
    summary.errorsPruned = await pruneErrors(db, now);
    // Press desk: drafts whose moment has come go to the owner, a few a day.
    summary.outreachAsks = await askOwnerOutreach(db, now);
  } catch (e) {
    summary.errors.push(`uptime: ${String(e)}`);
  }

  try {
    await refreshAnthropicCost(db, now);
    summary.serviceAlerts = await alertOnServices(db, now);
  } catch (e) {
    summary.errors.push(`services: ${String(e)}`);
  }

  try {
    await snapshotMetrics(db);
    await setMetric(db, "cron_hourly_at", Math.floor(now.getTime() / 1000));
  } catch (e) {
    summary.errors.push(`metrics: ${String(e)}`);
  }

  if (summary.errors.length) await reportError("cron", summary.errors.join(" | "));
  try {
    // The safety net for the proposals: a real note the owner never heard about (a failed send, a cut-off background task) goes out now.
    summary.proposals = await sweepProposals(db, now);
  } catch (e) {
    summary.errors.push(`proposals: ${String(e)}`);
  }

  return NextResponse.json({ ok: summary.errors.length === 0, at: now.toISOString(), ...summary });
}
