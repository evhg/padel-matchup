import { NextResponse } from "next/server";
import { reportError } from "@/lib/alerts";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { formatEventTime } from "@/lib/dates";
import { isOccupied } from "@/lib/domain/events";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { bumpMetric, setMetric } from "@/lib/domain/metrics";
import { findPushRemindersDue, markPushReminded, removePushSubscription, subscriptionsFor } from "@/lib/domain/push";
import { getEventDetail } from "@/lib/domain/queries";
import { translatorFor } from "@/lib/email/templates";
import { venueWithCourt } from "@/lib/labels";
import { personalEventUrl } from "@/lib/personal";
import { pushEnabled, sendPush } from "@/lib/push";
import { sendTelegramReminders } from "@/lib/telegram/bot";
import { sendDiscordReminders } from "@/lib/discord/bot";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Every 5 minutes (Supabase pg_cron → pg_net; Vercel Hobby cron is daily):
 * one push reminder per player inside the last hour before each match.
 * Guarded by CRON_SECRET when set. Idempotent: the event is claimed first.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (secret && auth !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const now = new Date();
  const db = await getDb();
  // Telegram "about an hour before" reminders share this 5-minute tick.
  const telegram = await sendTelegramReminders(db, now).catch((e) => {
    void reportError("cron", e);
    return 0;
  });
  const discord = await sendDiscordReminders(db, now).catch((e) => {
    void reportError("cron", e);
    return 0;
  });
  if (!pushEnabled()) return NextResponse.json({ ok: true, at: now.toISOString(), push: "disabled", events: 0, sent: 0, telegram, discord });

  const summary = { events: 0, players: 0, sent: 0, gone: 0, failed: 0, telegram, discord, errors: [] as string[] };
  try {
    const due = await findPushRemindersDue(db, now);
    for (const ev of due) {
      if (!(await markPushReminded(db, ev.id, now))) continue;
      summary.events++;
      const detail = await getEventDetail(db, ev);
      const participants = detail.roster.filter((s) => isOccupied(s) && s.player).map((s) => s.player!);
      const subs = await subscriptionsFor(db, participants.map((p) => p.id));
      for (const player of participants) {
        const mine = subs.filter((s) => s.playerId === player.id);
        if (mine.length === 0) continue;
        summary.players++;
        const { t, locale } = await translatorFor(player.locale);
        const venue = venueWithCourt(ev, { venueTbd: t("event.venueTbd"), courtNumber: (n) => t("event.courtNumber", { n }) });
        const payload = {
          title: t("push.reminderTitle", { time: formatEventTime(ev.startsAt, ev.tz, locale) }),
          body: t("push.reminderBody", { venue }),
          url: personalEventUrl(baseUrl(), await getOrCreatePersonalToken(db, player.id), ev.code),
          tag: `reminder-${ev.code}`,
        };
        for (const sub of mine) {
          const r = await sendPush(sub, payload);
          summary[r]++;
          if (r === "gone") await removePushSubscription(db, sub.endpoint);
        }
      }
    }
  } catch (e) {
    summary.errors.push(String(e));
  }
  try {
    await setMetric(db, "cron_push_at", Math.floor(now.getTime() / 1000));
    if (summary.sent) await bumpMetric(db, "push_sent", summary.sent);
  } catch (e) {
    summary.errors.push(`metrics: ${String(e)}`);
  }
  if (summary.errors.length) await reportError("cron", summary.errors.join(" | "));
  return NextResponse.json({ ok: summary.errors.length === 0, at: now.toISOString(), push: "enabled", ...summary });
}
