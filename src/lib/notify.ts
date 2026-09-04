import "server-only";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, type Event, type Player, type Slot } from "@/db/schema";
import { buildIcs } from "@/lib/calendar";
import { eventTitleLine, venueWithCourt } from "@/lib/labels";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { personalEventUrl, personalUrl } from "@/lib/personal";
import { APP_NAME, baseUrl, emailEnabled, emailFrom, shortHost } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { getEventDetail, participantsWithEmail, type EventDetail } from "@/lib/domain/queries";
import { isOccupied } from "@/lib/domain/events";
import { getPlayer } from "@/lib/domain/players";
import type { Promotion } from "@/lib/domain/slots";
import { sendEmail } from "@/lib/email/send";
import { layout, translatorFor } from "@/lib/email/templates";
import { lineupComplete, withCompleteSuffix } from "@/lib/lineup";
import { eventUrl, inviteUrl } from "@/lib/share";

/**
 * All outbound notifications live here. Every function is safe to call when
 * email is disabled (no-ops) and never throws into the request path.
 *
 * Links: a recipient with an identity always gets their *private* event link
 * (/p/{token}/{code}) — it signs the device in and opens the match — plus the
 * bare personal link. Anonymous recipients (invitees) get the public link.
 */

function organizerAddress(): string {
  const from = emailFrom();
  const m = from.match(/<([^>]+)>/);
  return m ? m[1] : from;
}

type Recipient = Pick<Player, "id" | "displayName" | "email" | "locale">;

async function ctx(db: Db, ev: Event, localeLike: string | null | undefined, recipient?: Recipient | null, detail?: EventDetail) {
  const { t, locale } = await translatorFor(localeLike);
  const d = detail ?? (await getEventDetail(db, ev));
  const base = baseUrl();
  const courtNumber = (n: string) => t("event.courtNumber", { n });
  const venue = venueWithCourt(ev, { venueTbd: t("event.venueTbd"), courtNumber });
  const complete = lineupComplete(d.roster, ev.capacity);
  const names = d.roster.filter(isOccupied).map((s) => s.player?.displayName ?? s.invitedName ?? "?");
  const title = withCompleteSuffix(eventTitleLine(ev, { fallback: t(ev.type === "match" ? "event.match" : "event.tournament"), courtNumber }), complete, t("calendar.completeSuffix"));
  const day = formatEventDay(ev.startsAt, ev.tz, locale);
  const time = formatEventTime(ev.startsAt, ev.tz, locale);
  const vars = { day, time, venue, names: names.join(", "), count: names.length, capacity: ev.capacity };
  const meta = [
    { label: t("email.when"), value: `${day} · ${time}` },
    { label: t("email.where"), value: venue },
    ...(names.length ? [{ label: t("calendar.playersLabel"), value: names.join(", ") }] : []),
  ];
  const publicUrl = eventUrl(base, ev.code);
  let url = publicUrl;
  let personal: { label: string; url: string } | undefined;
  if (recipient) {
    try {
      const token = await getOrCreatePersonalToken(db, recipient.id);
      personal = { label: t("email.personalLink"), url: personalUrl(base, token) };
      url = personalEventUrl(base, token, ev.code);
    } catch (e) {
      console.warn("[notify] personal link unavailable", e);
    }
  }
  const playersLine = names.length ? t("calendar.players", { names: names.join(", ") }) : null;
  return { t, locale, url, publicUrl, vars, meta, footer: t("email.footer", { app: APP_NAME }), openLabel: t("email.openMatch"), title, venue, personal, complete, names, playersLine, detail: d };
}
type Ctx = Awaited<ReturnType<typeof ctx>>;

function icsFor(ev: Event, c: Ctx, attendee: { name: string; email: string } | undefined, method: "REQUEST" | "CANCEL" | "PUBLISH") {
  return buildIcs({
    event: ev,
    title: c.title,
    url: c.url,
    organizer: { name: c.detail.creator.displayName, email: organizerAddress() },
    attendee,
    method,
    domain: shortHost(),
    location: c.venue,
    extraDescription: c.playersLine ? [c.playersLine] : undefined,
  });
}

/** The downloadable .ics for the current viewer (Apple Calendar & co.). */
export async function icsForDownload(db: Db, detail: EventDetail, viewer: Recipient | null): Promise<string> {
  const c = await ctx(db, detail.event, viewer?.locale ?? detail.creator.locale, viewer, detail);
  return icsFor(detail.event, c, undefined, "PUBLISH");
}

/** Player joined/confirmed/was promoted: calendar invite (.ics REQUEST). */
export async function sendCalendarInvite(db: Db, ev: Event, player: Player, kind: "joined" | "promoted" = "joined"): Promise<void> {
  if (!emailEnabled() || !player.email) return;
  const c = await ctx(db, ev, player.locale, player);
  const ns = kind === "promoted" ? "email.promotedPlayer" : "email.calendarInvite";
  const { html, text } = layout({
    heading: c.t(`${ns}.heading` as "email.calendarInvite.heading"),
    body: c.t(`${ns}.body` as "email.calendarInvite.body", c.vars),
    meta: c.meta,
    cta: { label: c.openLabel, url: c.url },
    footer: c.footer,
    eventUrl: c.url,
    openLabel: c.openLabel,
    personal: c.personal,
  });
  await sendEmail({
    to: player.email,
    subject: c.t(`${ns}.subject` as "email.calendarInvite.subject", c.vars),
    html,
    text,
    ics: { method: "REQUEST", content: icsFor(ev, c, { name: player.displayName, email: player.email }, "REQUEST") },
  });
}

/** "Here is your personal link" — sent when an email is attached outside of a match. */
export async function sendPersonalLinkEmail(db: Db, player: Player): Promise<boolean> {
  if (!emailEnabled() || !player.email) return false;
  const { t } = await translatorFor(player.locale);
  const url = personalUrl(baseUrl(), await getOrCreatePersonalToken(db, player.id));
  const { html, text } = layout({
    heading: t("email.personal.heading"),
    body: t("email.personal.body"),
    cta: { label: t("email.personal.cta"), url },
    footer: t("email.personal.footer"),
    eventUrl: url,
    openLabel: t("common.myMatches"),
  });
  return sendEmail({ to: player.email, subject: t("email.personal.subject"), html, text });
}

/**
 * New email for a player: calendar invite if they're in this event (it carries
 * the personal link), otherwise the plain personal-link email.
 */
export async function welcomeEmail(db: Db, player: Player, ev: Event | null): Promise<void> {
  if (!emailEnabled() || !player.email) return;
  if (ev) {
    const detail = await getEventDetail(db, ev);
    const inEvent = detail.roster.some((s) => s.playerId === player.id && isOccupied(s));
    if (inEvent && ev.status !== "cancelled") {
      await sendCalendarInvite(db, ev, player);
      return;
    }
  }
  await sendPersonalLinkEmail(db, player);
}

type CreatorKind = "joined" | "waitlisted" | "left" | "confirmed" | "declined" | "promoted";

/** Creator notifications (decision 11). Skipped when the actor is the creator. */
export async function notifyCreator(db: Db, ev: Event, kind: CreatorKind, actorName: string, actorPlayerId?: string | null): Promise<void> {
  if (!emailEnabled()) return;
  if (actorPlayerId && actorPlayerId === ev.creatorPlayerId) return;
  const creator = await getPlayer(db, ev.creatorPlayerId);
  if (!creator?.email || !creator.emailNotifications) return;
  const c = await ctx(db, ev, creator.locale, creator);
  const vars = { ...c.vars, name: actorName };
  const subjectKey = (kind === "waitlisted" ? "joined" : kind) as Exclude<CreatorKind, "waitlisted">;
  const subject = c.t(`email.creator.${subjectKey}Subject`, vars);
  const body = c.t(`email.creator.${kind}Body`, vars);
  const { html, text } = layout({ heading: subject, body, meta: c.meta, cta: { label: c.openLabel, url: c.url }, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel });
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
  await Promise.all(
    participantsWithEmail(detail.roster).map(async (r) => {
      const c = await ctx(db, ev, r.locale, r.playerId ? await getPlayer(db, r.playerId) : null, detail);
      const { html, text } = layout({ heading: c.t("email.updated.heading"), body: c.t("email.updated.body", c.vars), meta: c.meta, cta: { label: c.openLabel, url: c.url }, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel });
      await sendEmail({ to: r.email, subject: c.t("email.updated.subject", c.vars), html, text, ics: { method: "REQUEST", content: icsFor(ev, c, { name: r.name, email: r.email }, "REQUEST") } });
    }),
  );
}

/**
 * Line-up became complete (every spot joined/confirmed) or stopped being
 * complete: bump the calendar SEQUENCE and resend the invite so the title
 * gains/loses "- COMPLETE" and the description lists the players.
 * Returns the refreshed event when something changed, else null.
 */
export async function notifyLineupChange(db: Db, ev: Event, wasComplete: boolean, excludePlayerId?: string | null): Promise<Event | null> {
  const detail = await getEventDetail(db, ev);
  const complete = lineupComplete(detail.roster, ev.capacity);
  if (complete === wasComplete || ev.status === "cancelled") return null;
  const [fresh] = await db
    .update(events)
    .set({ icsSequence: sql`${events.icsSequence} + 1` })
    .where(eq(events.id, ev.id))
    .returning();
  if (!fresh) return null;
  if (!emailEnabled()) return fresh;
  const freshDetail = { ...detail, event: fresh };
  const ns = complete ? "email.lineupComplete" : "email.lineupOpen";
  await Promise.all(
    participantsWithEmail(detail.roster)
      .filter((r) => !excludePlayerId || r.playerId !== excludePlayerId)
      .map(async (r) => {
        const player = r.playerId ? await getPlayer(db, r.playerId) : null;
        if (player && !player.emailNotifications) return;
        const c = await ctx(db, fresh, r.locale, player, freshDetail);
        const { html, text } = layout({
          heading: c.t(`${ns}.heading` as "email.lineupComplete.heading", c.vars),
          body: c.t(`${ns}.body` as "email.lineupComplete.body", c.vars),
          meta: c.meta,
          cta: { label: c.openLabel, url: c.url },
          footer: c.footer,
          eventUrl: c.url,
          openLabel: c.openLabel,
        });
        await sendEmail({ to: r.email, subject: c.t(`${ns}.subject` as "email.lineupComplete.subject", c.vars), html, text, ics: { method: "REQUEST", content: icsFor(fresh, c, { name: r.name, email: r.email }, "REQUEST") } });
      }),
  );
  return fresh;
}

export async function notifyEventCancelled(db: Db, ev: Event): Promise<void> {
  if (!emailEnabled()) return;
  const detail = await getEventDetail(db, ev);
  await Promise.all(
    participantsWithEmail(detail.roster).map(async (r) => {
      const c = await ctx(db, ev, r.locale, r.playerId ? await getPlayer(db, r.playerId) : null, detail);
      const { html, text } = layout({ heading: c.t("email.cancelled.heading"), body: c.t("email.cancelled.body", { ...c.vars, organizer: detail.creator.displayName }), meta: c.meta, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel });
      await sendEmail({ to: r.email, subject: c.t("email.cancelled.subject", c.vars), html, text, ics: { method: "CANCEL", content: icsFor(ev, c, { name: r.name, email: r.email }, "CANCEL") } });
    }),
  );
}

/** Removed by the organizer → cancel their calendar entry (courtesy). */
export async function notifyRemoved(db: Db, ev: Event, removedPlayerId: string | null): Promise<void> {
  if (!emailEnabled() || !removedPlayerId) return;
  const p = await getPlayer(db, removedPlayerId);
  if (!p?.email) return;
  const c = await ctx(db, ev, p.locale, p);
  const { html, text } = layout({ heading: c.t("activity.removed", { name: p.displayName }), body: c.t("email.footer", { app: APP_NAME }), meta: c.meta, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel });
  await sendEmail({ to: p.email, subject: c.t("email.cancelled.subject", c.vars), html, text, ics: { method: "CANCEL", content: icsFor(ev, c, { name: p.displayName, email: p.email }, "CANCEL") } });
}

/** Immediate invite to a reserved spot when the organizer entered an email. */
export async function sendInviteEmail(db: Db, ev: Event, slot: Slot, creator: Player): Promise<boolean> {
  if (!emailEnabled() || !slot.invitedEmail || !slot.inviteCode) return false;
  const c = await ctx(db, ev, creator.locale);
  const link = inviteUrl(baseUrl(), ev.code, slot.inviteCode);
  const { html, text } = layout({
    heading: c.t("email.invite.heading", { organizer: creator.displayName }),
    body: c.t("email.invite.body", { ...c.vars, name: slot.invitedName ?? "" }),
    meta: c.meta,
    cta: { label: c.t("email.inviteReminder.confirm"), url: link },
    secondary: { label: c.t("email.inviteReminder.decline"), url: `${link}?decline=1` },
    footer: c.footer,
    eventUrl: c.publicUrl,
    openLabel: c.openLabel,
  });
  return sendEmail({ to: slot.invitedEmail, subject: c.t("email.invite.subject", { ...c.vars, organizer: creator.displayName }), html, text });
}

/** 24h reminder to an unconfirmed invitee with an email (decision 12). */
export async function sendInviteReminder(db: Db, ev: Event, slot: Slot, creator: Player): Promise<boolean> {
  if (!emailEnabled() || !slot.invitedEmail || !slot.inviteCode) return false;
  const c = await ctx(db, ev, creator.locale);
  const link = inviteUrl(baseUrl(), ev.code, slot.inviteCode);
  const { html, text } = layout({
    heading: c.t("email.inviteReminder.heading", { organizer: creator.displayName }),
    body: c.t("email.inviteReminder.body", c.vars),
    meta: c.meta,
    cta: { label: c.t("email.inviteReminder.confirm"), url: link },
    secondary: { label: c.t("email.inviteReminder.decline"), url: `${link}?decline=1` },
    footer: c.footer,
    eventUrl: c.publicUrl,
    openLabel: c.openLabel,
  });
  return sendEmail({ to: slot.invitedEmail, subject: c.t("email.inviteReminder.subject", c.vars), html, text });
}

/** The single post-match score reminder to the creator (decision 13). */
export async function sendScoreReminder(db: Db, ev: Event, creator: Player): Promise<boolean> {
  if (!emailEnabled() || !creator.email || !creator.emailNotifications) return false;
  const c = await ctx(db, ev, creator.locale, creator);
  const { html, text } = layout({ heading: c.t("email.scoreReminder.heading"), body: c.t("email.scoreReminder.body", c.vars), meta: c.meta, cta: { label: c.t("email.scoreReminder.cta"), url: `${c.url}#score` }, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel });
  return sendEmail({ to: creator.email, subject: c.t("email.scoreReminder.subject"), html, text });
}

/** One-time code for restoring history on a new device. */
export async function sendEmailCode(email: string, code: string, localeLike: string | null | undefined): Promise<boolean> {
  if (!emailEnabled()) return false;
  const { t } = await translatorFor(localeLike);
  const base = baseUrl();
  const { html, text } = layout({
    heading: t("email.code.heading"),
    body: t("email.code.body", { code }),
    meta: [{ label: t("email.code.codeLabel"), value: code }],
    footer: t("email.code.footer"),
    eventUrl: `${base}/me`,
    openLabel: t("common.myMatches"),
  });
  return sendEmail({ to: email, subject: t("email.code.subject", { code }), html, text });
}
