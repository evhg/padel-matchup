import "server-only";
import type { Db } from "@/db";
import type { Event, Player, Slot } from "@/db/schema";
import { buildIcs, calendarTitle, googleCalendarUrl } from "@/lib/calendar";
import { APP_NAME, baseUrl, emailEnabled, emailFrom, shortHost } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { getEventDetail, participantsWithEmail, type EventDetail } from "@/lib/domain/queries";
import { isOccupied } from "@/lib/domain/events";
import { getPlayer } from "@/lib/domain/players";
import type { Promotion } from "@/lib/domain/slots";
import { sendEmail } from "@/lib/email/send";
import { eventVars, layout, translatorFor } from "@/lib/email/templates";
import { eventUrl, inviteUrl } from "@/lib/share";

/**
 * All outbound notifications live here. Every function is safe to call when
 * email is disabled (no-ops) and never throws into the request path.
 */

function organizerAddress(): string {
  const from = emailFrom();
  const m = from.match(/<([^>]+)>/);
  return m ? m[1] : from;
}

function rosterCount(detail: EventDetail): number {
  return detail.roster.filter(isOccupied).length;
}

async function common(localeLike: string | null | undefined, ev: Event) {
  const { t, locale } = await translatorFor(localeLike);
  const url = eventUrl(baseUrl(), ev.code);
  const vars = eventVars(ev, locale, t("event.venueTbd"));
  const footer = t("email.footer", { app: APP_NAME });
  const meta = [
    { label: t("email.when"), value: `${formatEventDay(ev.startsAt, ev.tz, locale)} · ${formatEventTime(ev.startsAt, ev.tz, locale)}` },
    { label: t("email.where"), value: ev.venueName ?? t("event.venueTbd") },
  ];
  return { t, locale, url, vars, footer, meta, openLabel: t("email.openMatch") };
}

function icsFor(ev: Event, title: string, url: string, creator: Player, attendee: { name: string; email: string }, method: "REQUEST" | "CANCEL") {
  return {
    method,
    content: buildIcs({
      event: ev,
      title,
      url,
      organizer: { name: creator.displayName, email: organizerAddress() },
      attendee,
      method,
      domain: shortHost(),
    }),
  };
}

/** Player joined/confirmed/was promoted: calendar invite (.ics REQUEST). */
export async function sendCalendarInvite(db: Db, ev: Event, player: Player, kind: "joined" | "promoted" = "joined"): Promise<void> {
  if (!emailEnabled() || !player.email) return;
  const creator = await getPlayer(db, ev.creatorPlayerId);
  if (!creator) return;
  const c = await common(player.locale, ev);
  const title = calendarTitle(ev, c.t(ev.type === "match" ? "event.match" : "event.tournament"));
  const ns = kind === "promoted" ? "email.promotedPlayer" : "email.calendarInvite";
  const { html, text } = layout({
    heading: c.t(`${ns}.heading` as "email.calendarInvite.heading"),
    body: c.t(`${ns}.body` as "email.calendarInvite.body", c.vars),
    meta: c.meta,
    cta: { label: c.t("event.addToCalendar"), url: googleUrl(ev, title, c.url) },
    footer: c.footer,
    eventUrl: c.url,
    openLabel: c.openLabel,
  });
  await sendEmail({
    to: player.email,
    subject: c.t(`${ns}.subject` as "email.calendarInvite.subject", c.vars),
    html,
    text,
    ics: icsFor(ev, title, c.url, creator, { name: player.displayName, email: player.email }, "REQUEST"),
  });
}

function googleUrl(ev: Event, title: string, url: string) {
  return googleCalendarUrl(ev, { title, url, tz: ev.tz });
}

type CreatorKind = "joined" | "waitlisted" | "left" | "confirmed" | "declined" | "promoted";

/** Creator notifications (decision 11). Skipped when the actor is the creator. */
export async function notifyCreator(db: Db, ev: Event, kind: CreatorKind, actorName: string, actorPlayerId?: string | null): Promise<void> {
  if (!emailEnabled()) return;
  if (actorPlayerId && actorPlayerId === ev.creatorPlayerId) return;
  const creator = await getPlayer(db, ev.creatorPlayerId);
  if (!creator?.email) return;
  const detail = await getEventDetail(db, ev);
  const c = await common(creator.locale, ev);
  const vars = { ...c.vars, name: actorName, count: rosterCount(detail), capacity: ev.capacity };
  const subjectKey = (kind === "waitlisted" ? "joined" : kind) as Exclude<CreatorKind, "waitlisted">;
  const subject = c.t(`email.creator.${subjectKey}Subject`, vars);
  const body = c.t(`email.creator.${kind}Body`, vars);
  const { html, text } = layout({
    heading: subject,
    body,
    meta: c.meta,
    cta: { label: c.openLabel, url: c.url },
    footer: c.footer,
    eventUrl: c.url,
    openLabel: c.openLabel,
  });
  await sendEmail({ to: creator.email, subject, html, text });
}

/** Handles the fallout of a promotion: promoted player invite + creator notice. */
export async function notifyPromotion(db: Db, ev: Event, promotion: Promotion | null): Promise<void> {
  if (!promotion) return;
  const promoted = await getPlayer(db, promotion.playerId);
  if (!promoted) return;
  await Promise.all([sendCalendarInvite(db, ev, promoted, "promoted"), notifyCreator(db, ev, "promoted", promoted.displayName, promoted.id)]);
}

/** Time/venue changed → updated .ics (same UID, bumped SEQUENCE) to everyone with an email. */
export async function notifyEventUpdated(db: Db, ev: Event): Promise<void> {
  if (!emailEnabled()) return;
  const detail = await getEventDetail(db, ev);
  const recipients = participantsWithEmail(detail.roster);
  await Promise.all(
    recipients.map(async (r) => {
      const c = await common(r.locale, ev);
      const title = calendarTitle(ev, c.t(ev.type === "match" ? "event.match" : "event.tournament"));
      const { html, text } = layout({
        heading: c.t("email.updated.heading"),
        body: c.t("email.updated.body", c.vars),
        meta: c.meta,
        cta: { label: c.openLabel, url: c.url },
        footer: c.footer,
        eventUrl: c.url,
        openLabel: c.openLabel,
      });
      await sendEmail({
        to: r.email,
        subject: c.t("email.updated.subject", c.vars),
        html,
        text,
        ics: icsFor(ev, title, c.url, detail.creator, { name: r.name, email: r.email }, "REQUEST"),
      });
    }),
  );
}

export async function notifyEventCancelled(db: Db, ev: Event): Promise<void> {
  if (!emailEnabled()) return;
  const detail = await getEventDetail(db, ev);
  const recipients = participantsWithEmail(detail.roster);
  await Promise.all(
    recipients.map(async (r) => {
      const c = await common(r.locale, ev);
      const title = calendarTitle(ev, c.t(ev.type === "match" ? "event.match" : "event.tournament"));
      const { html, text } = layout({
        heading: c.t("email.cancelled.heading"),
        body: c.t("email.cancelled.body", { ...c.vars, organizer: detail.creator.displayName }),
        meta: c.meta,
        footer: c.footer,
        eventUrl: c.url,
        openLabel: c.openLabel,
      });
      await sendEmail({
        to: r.email,
        subject: c.t("email.cancelled.subject", c.vars),
        html,
        text,
        ics: icsFor(ev, title, c.url, detail.creator, { name: r.name, email: r.email }, "CANCEL"),
      });
    }),
  );
}

/** Removed by the organizer → cancel their calendar entry (courtesy). */
export async function notifyRemoved(db: Db, ev: Event, removedPlayerId: string | null): Promise<void> {
  if (!emailEnabled() || !removedPlayerId) return;
  const p = await getPlayer(db, removedPlayerId);
  if (!p?.email) return;
  const creator = await getPlayer(db, ev.creatorPlayerId);
  if (!creator) return;
  const c = await common(p.locale, ev);
  const title = calendarTitle(ev, c.t(ev.type === "match" ? "event.match" : "event.tournament"));
  const { html, text } = layout({
    heading: c.t("activity.removed", { name: p.displayName }),
    body: c.t("email.footer", { app: APP_NAME }),
    meta: c.meta,
    footer: c.footer,
    eventUrl: c.url,
    openLabel: c.openLabel,
  });
  await sendEmail({
    to: p.email,
    subject: c.t("email.cancelled.subject", c.vars),
    html,
    text,
    ics: icsFor(ev, title, c.url, creator, { name: p.displayName, email: p.email }, "CANCEL"),
  });
}

/** 24h reminder to an unconfirmed invitee with an email (decision 12). */
export async function sendInviteReminder(ev: Event, slot: Slot, creator: Player): Promise<boolean> {
  if (!emailEnabled() || !slot.invitedEmail || !slot.inviteCode) return false;
  const c = await common(creator.locale, ev);
  const link = inviteUrl(baseUrl(), ev.code, slot.inviteCode);
  const { html, text } = layout({
    heading: c.t("email.inviteReminder.heading", { organizer: creator.displayName }),
    body: c.t("email.inviteReminder.body", c.vars),
    meta: c.meta,
    cta: { label: c.t("email.inviteReminder.confirm"), url: link },
    secondary: { label: c.t("email.inviteReminder.decline"), url: `${link}?decline=1` },
    footer: c.footer,
    eventUrl: c.url,
    openLabel: c.openLabel,
  });
  return sendEmail({ to: slot.invitedEmail, subject: c.t("email.inviteReminder.subject", c.vars), html, text });
}

/** The single post-match score reminder to the creator (decision 13). */
export async function sendScoreReminder(ev: Event, creator: Player): Promise<boolean> {
  if (!emailEnabled() || !creator.email) return false;
  const c = await common(creator.locale, ev);
  const { html, text } = layout({
    heading: c.t("email.scoreReminder.heading"),
    body: c.t("email.scoreReminder.body", c.vars),
    meta: c.meta,
    cta: { label: c.t("email.scoreReminder.cta"), url: `${c.url}#score` },
    footer: c.footer,
    eventUrl: c.url,
    openLabel: c.openLabel,
  });
  return sendEmail({ to: creator.email, subject: c.t("email.scoreReminder.subject"), html, text });
}
