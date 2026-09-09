import "server-only";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, coaches, players, type Event, type LevelCheck, type Player } from "@/db/schema";
import { APP_NAME, baseUrl, emailEnabled } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { formatLevel } from "@/lib/domain/levels";
import type { Admitted } from "@/lib/domain/verify";
import { sendEmail } from "@/lib/email/send";
import { layout, translatorFor } from "@/lib/email/templates";
import { esc, sendMessage, telegramEnabled } from "@/lib/telegram/api";

/**
 * Two quiet lines around a level check: the coach or club hears that someone
 * asked (one tap to answer), the player hears the answer, once, on the
 * channels they have. Nothing here throws into the request path.
 */

async function reach(p: Pick<Player, "email" | "telegramId" | "locale">, n: { subject: string; heading: string; body: string; url: string; open: string; footer: string }): Promise<void> {
  if (emailEnabled() && p.email) {
    const { html, text } = layout({ heading: n.heading, body: n.body, cta: { label: n.open, url: n.url }, footer: n.footer, eventUrl: n.url, openLabel: n.open });
    await sendEmail({ to: p.email, subject: n.subject, html, text }).catch(() => undefined);
  }
  if (telegramEnabled() && p.telegramId) {
    await sendMessage(p.telegramId, `${esc(n.heading)}\n${esc(n.body)}`, { silent: true, keyboard: { inline_keyboard: [[{ text: n.open, url: n.url }]] } }).catch(() => undefined);
  }
}

/** Who answers this ask, and where they answer it. */
async function verifierOf(db: Db, check: LevelCheck): Promise<{ player: Player; url: string } | null> {
  const base = baseUrl();
  if (check.coachId) {
    const [coach] = await db.select().from(coaches).where(eq(coaches.id, check.coachId)).limit(1);
    if (!coach) return null;
    const [p] = await db.select().from(players).where(eq(players.id, coach.playerId)).limit(1);
    return p ? { player: p, url: `${base}/coach` } : null;
  }
  if (check.clubSlug) {
    const [club] = await db.select().from(clubs).where(eq(clubs.slug, check.clubSlug)).limit(1);
    if (!club?.claimedBy) return null;
    const [p] = await db.select().from(players).where(eq(players.id, club.claimedBy)).limit(1);
    return p ? { player: p, url: `${base}/v/${club.slug}/manage/${club.manageToken}` } : null;
  }
  return null;
}

export async function notifyLevelCheckAsked(db: Db, check: LevelCheck, asker: Player): Promise<void> {
  const v = await verifierOf(db, check);
  if (!v) return;
  const { t } = await translatorFor(v.player.locale);
  const vars = { name: asker.displayName, level: check.level != null ? formatLevel(check.level) : "?", app: APP_NAME };
  await reach(v.player, {
    subject: t("levelCheck.notify.askedSubject", vars),
    heading: t("levelCheck.notify.askedSubject", vars),
    body: t("levelCheck.notify.askedBody", vars),
    url: v.url,
    open: t("levelCheck.notify.open"),
    footer: t("email.footer", { app: APP_NAME }),
  });
}

export async function notifyLevelCheckDecided(db: Db, n: { check: LevelCheck; player: Player; verifierName: string; approve: boolean; admitted: Admitted[] }): Promise<void> {
  const { t, locale } = await translatorFor(n.player.locale);
  const base = baseUrl();
  const level = n.player.levelVerifiedLevel ?? n.player.level;
  const vars = { verifier: n.verifierName, level: level != null ? formatLevel(level) : "?", app: APP_NAME };
  const matchLine = (ev: Event) => `${formatEventDay(ev.startsAt, ev.tz, locale)} ${formatEventTime(ev.startsAt, ev.tz, locale)} · ${ev.venueName ?? ev.code}`;
  const seated = n.admitted.filter((a) => a.join.outcome === "joined");
  const body = n.approve ? [t("levelCheck.notify.confirmedBody", vars), ...(seated.length ? [t("levelCheck.notify.admittedBody", { matches: seated.map((a) => matchLine(a.event)).join("; ") })] : [])].join(" ") : t("levelCheck.notify.declinedBody", vars);
  const url = seated[0] ? `${base}/${seated[0].event.code}` : `${base}/me`;
  await reach(n.player, {
    subject: n.approve ? t("levelCheck.notify.confirmedSubject", vars) : t("levelCheck.notify.declinedSubject", vars),
    heading: n.approve ? t("levelCheck.notify.confirmedSubject", vars) : t("levelCheck.notify.declinedSubject", vars),
    body,
    url,
    open: t("levelCheck.notify.open"),
    footer: t("email.footer", { app: APP_NAME }),
  });
}
