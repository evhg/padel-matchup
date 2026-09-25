import "server-only";
import { pushEnabled, sendPush } from "@/lib/push";
import { removePushSubscription, subscriptionsFor } from "@/lib/domain/push";
import { groupMembers as groupMembersTable, players as playersTable, slots as slotsTable, type Group } from "@/db/schema";

/** How many people one quiet-hour match may reach. A club fills a court, it does not run a mailing list. */
const CLUB_FANOUT_MAX = 40;
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, type Event, type Player, type Slot } from "@/db/schema";
import { buildIcs, inviteFields } from "@/lib/calendar";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { personalEventUrl, personalUrl } from "@/lib/personal";
import { APP_NAME, baseUrl, emailEnabled, emailFrom, shortHost } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { getEventDetail, participantsWithEmail, type EventDetail } from "@/lib/domain/queries";
import { isClaimable, isOccupied, isSeated } from "@/lib/domain/events";
import { refillRecipients } from "@/lib/domain/refill";
import { markWantsNotified, wantAudience } from "@/lib/domain/demand";
import { claimCourtOffer, COURT_OFFERS, courtOfferLink, courtOffersDue } from "@/lib/domain/courtOffers";
import { chatTicket } from "@/lib/telegram/identity";
import { getPlayer } from "@/lib/domain/players";
import type { Promotion } from "@/lib/domain/slots";
import { sendEmail } from "@/lib/email/send";
import { layout, telegramLine, translatorFor } from "@/lib/email/templates";
import { lineupComplete } from "@/lib/lineup";
import { channelFor, tell } from "@/lib/coach/notify";
import { channelsOffered } from "@/lib/coach/reach";
import { esc, miniAppUrl, sendMessage, telegramEnabled } from "@/lib/telegram/api";
import { botLocale, cardTitle, strings as botStrings, whenLine, whereLine } from "@/lib/telegram/card";
import { isOptedOut, optOutPath } from "@/lib/domain/optouts";
import { eventUrl, inviteUrl } from "@/lib/share";
import { markedAmong, normalAddress } from "@/lib/domain/emailMarks";

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

type Recipient = Pick<Player, "id" | "displayName" | "email" | "locale" | "telegramId">;

async function ctx(db: Db, ev: Event, localeLike: string | null | undefined, recipient?: Recipient | null, detail?: EventDetail) {
  const { t, locale } = await translatorFor(localeLike);
  const d = detail ?? (await getEventDetail(db, ev));
  const base = baseUrl();
  // The same title, place and players line the player's own calendar feed writes (src/lib/calendarFeed.ts).
  const { title, location: venue, complete, names, playersLine } = inviteFields(ev, d.roster, t as unknown as Parameters<typeof inviteFields>[2]);
  const day = formatEventDay(ev.startsAt, ev.tz, locale);
  const time = formatEventTime(ev.startsAt, ev.tz, locale);
  // Every message may use every one of these. Kept in one bag on purpose: a sender that has to remember
  // to pass an extra variable eventually forgets, and next-intl answers a missing one with the key itself.
  const spots = t("event.spotsLeft", { count: d.roster.filter(isClaimable).length });
  const vars = { day, time, venue, names: names.join(", "), count: names.length, capacity: ev.capacity, spots };
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
  return { t, locale, url, publicUrl, vars, meta, footer: t("email.footer", { app: APP_NAME }), openLabel: t("email.openMatch"), title, venue, personal, telegram: telegramLine(t("email.telegramLine"), recipient), complete, names, playersLine, detail: d };
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
export async function sendCalendarInvite(db: Db, ev: Event, player: Player, kind: "joined" | "promoted" = "joined", detail?: EventDetail): Promise<boolean> {
  if (!emailEnabled() || !player.email) return false;
  const c = await ctx(db, ev, player.locale, player, detail);
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
  telegram: c.telegram,
  });
  return sendEmail({
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
    telegram: telegramLine(t("email.telegramLine"), player),
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
    if (isSeated({ roster: detail.roster }, player.id) && ev.status !== "cancelled") {
      await sendCalendarInvite(db, ev, player, "joined", detail);
      return;
    }
  }
  await sendPersonalLinkEmail(db, player);
}

export type CreatorKind = "joined" | "waitlisted" | "left" | "confirmed" | "declined" | "promoted" | "requested";

/** Creator notifications (decision 11). Skipped when the actor is the creator. */
export async function notifyCreator(db: Db, ev: Event, kind: CreatorKind, actorName: string, actorPlayerId?: string | null): Promise<void> {
  if (actorPlayerId && actorPlayerId === ev.creatorPlayerId) return;
  const creator = await getPlayer(db, ev.creatorPlayerId);
  if (!creator) return;
  if (emailEnabled() && creator.email && creator.emailNotifications) {
    const c = await ctx(db, ev, creator.locale, creator);
    const vars = { ...c.vars, name: actorName };
    const subjectKey = (kind === "waitlisted" ? "joined" : kind) as Exclude<CreatorKind, "waitlisted">;
    const subject = c.t(`email.creator.${subjectKey}Subject`, vars);
    const body = c.t(`email.creator.${kind}Body`, vars);
    const { html, text } = layout({ heading: subject, body, meta: c.meta, cta: { label: c.openLabel, url: c.url }, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel, telegram: c.telegram });
    await sendEmail({ to: creator.email, subject, html, text });
  }
  // Organizers who linked Telegram get the same line there. Loaded lazily: the bot imports the operations, which import this file.
  if (creator.telegramId) {
    try {
      const bot = await import("@/lib/telegram/bot");
      await bot.telegramCreatorNote(db, await getEventDetail(db, ev), creator, kind, actorName);
    } catch (e) {
      console.warn("[telegram] organizer note failed", e);
    }
  }
}

/** Join request decided: approved players get their calendar invite, declined ones a short, kind note. */
export async function notifyRequestDecided(db: Db, ev: Event, player: Player, approved: boolean): Promise<void> {
  if (!emailEnabled()) return;
  if (approved) {
    await sendCalendarInvite(db, ev, player);
    return;
  }
  if (!player.email) return;
  const c = await ctx(db, ev, player.locale, player);
  const vars = { ...c.vars, title: c.title, organizer: c.detail.creator.displayName };
  const { html, text } = layout({ heading: c.t("email.requestDeclined.heading"), body: c.t("email.requestDeclined.body", vars), meta: c.meta, footer: c.footer, eventUrl: c.publicUrl, openLabel: c.openLabel, telegram: c.telegram });
  await sendEmail({ to: player.email, subject: c.t("email.requestDeclined.subject", vars), html, text });
}

/** A group got a new match (by a member or the weekly slot): email + push to every other member. */
export async function notifyGroupMatch(db: Db, group: Group, ev: Event, excludePlayerId?: string | null): Promise<{ emails: number; pushes: number }> {
  const rows = await db.select({ player: playersTable }).from(groupMembersTable).innerJoin(playersTable, eq(playersTable.id, groupMembersTable.playerId)).where(eq(groupMembersTable.groupId, group.id));
  const organizer = await getPlayer(db, ev.creatorPlayerId);
  const detail = await getEventDetail(db, ev);
  let emails = 0;
  let pushes = 0;
  for (const { player: p } of rows) {
    if (excludePlayerId && p.id === excludePlayerId) continue;
    const c = await ctx(db, ev, p.locale, p, detail);
    const vars = { ...c.vars, group: group.name, organizer: organizer?.displayName ?? "" };
    if (emailEnabled() && p.email && p.emailNotifications) {
      const { html, text } = layout({ heading: c.t("email.groupMatch.heading", vars), body: c.t("email.groupMatch.body", vars), meta: c.meta, cta: { label: c.openLabel, url: c.url }, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel, telegram: c.telegram });
      await sendEmail({ to: p.email, subject: c.t("email.groupMatch.subject", vars), html, text });
      emails++;
    }
    if (pushEnabled()) {
      for (const sub of await subscriptionsFor(db, [p.id])) {
        const r = await sendPush(sub, { title: c.t("push.groupMatchTitle", vars), body: c.t("push.groupMatchBody", vars), url: c.url, tag: `group-${ev.code}` });
        if (r === "sent") pushes++;
        if (r === "gone") await removePushSubscription(db, sub.endpoint);
      }
    }
  }
  return { emails, pushes };
}

/**
 * A club's weekly programme creates a match and, until now, told nobody: no push, no email, no card,
 * unlike the group matches made in the very same cron tick. It sat on the club's page waiting to be
 * browsed to, which is not how a quiet Tuesday hour gets filled.
 *
 * Who hears it: people with a match at that club in the last three months or still to come, at a level
 * the match admits. Bounded on purpose (rule 12) — one indexed read on (venue_slug, starts_at), a
 * hard cap on recipients, and it runs in the cron tick, never in a path a person waits on.
 */
export async function notifyClubMatch(db: Db, club: { slug: string; name: string }, ev: Event, now = new Date()): Promise<{ emails: number; pushes: number; told: number }> {
  const since = new Date(now.getTime() - 90 * 24 * 3600_000);
  const rows = await db
    .select({ playerId: slotsTable.playerId })
    .from(slotsTable)
    .innerJoin(events, eq(events.id, slotsTable.eventId))
    .where(and(eq(events.venueSlug, club.slug), gte(events.startsAt, since), isNotNull(slotsTable.playerId)))
    .limit(400);
  const ids = [...new Set(rows.map((r) => r.playerId).filter((id): id is string => Boolean(id)))].filter((id) => id !== ev.creatorPlayerId).slice(0, CLUB_FANOUT_MAX);
  if (ids.length === 0) return { emails: 0, pushes: 0, told: 0 };
  const people = await db.select().from(playersTable).where(inArray(playersTable.id, ids));
  const detail = await getEventDetail(db, ev);
  let emails = 0;
  let pushes = 0;
  let told = 0;
  for (const p of people) {
    // A match with a level range is for the people it admits; an unrated player is not chased.
    if (ev.levelMin !== null || ev.levelMax !== null) {
      if (p.level === null) continue;
      if (ev.levelMin !== null && p.level < ev.levelMin) continue;
      if (ev.levelMax !== null && p.level > ev.levelMax) continue;
    }
    told++;
    const c = await ctx(db, ev, p.locale, p, detail);
    const vars = { ...c.vars, club: club.name };
    if (emailEnabled() && p.email && p.emailNotifications) {
      const { html, text } = layout({ heading: c.t("email.clubMatch.heading", vars), body: c.t("email.clubMatch.body", vars), meta: c.meta, cta: { label: c.openLabel, url: c.url }, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel, telegram: c.telegram });
      await sendEmail({ to: p.email, subject: c.t("email.clubMatch.subject", vars), html, text }).catch(() => undefined);
      emails++;
    }
    if (pushEnabled()) {
      for (const sub of await subscriptionsFor(db, [p.id])) {
        const r = await sendPush(sub, { title: c.t("push.clubMatchTitle", vars), body: c.t("push.clubMatchBody", vars), url: c.url, tag: `club-${ev.code}` });
        if (r === "sent") pushes++;
        if (r === "gone") await removePushSubscription(db, sub.endpoint);
      }
    }
  }
  return { emails, pushes, told };
}

/**
 * Somebody asked to play around this time, at this place, and here is a match that answers it.
 *
 * The other notices here start from a room somebody is already in — a crew, a club's regulars. This
 * one starts from the player: they said what they wanted, and the app is keeping its side of that.
 * Which is why the email says so in as many words, and says how to stop it.
 *
 * Push and email both: a want is about next Tuesday, so an inbox is a perfectly good place for it.
 */
export async function notifyWanted(db: Db, ev: Event, now = new Date()): Promise<{ emails: number; pushes: number; told: number }> {
  const { players: people, signalIds } = await wantAudience(db, ev, now);
  if (people.length === 0) return { emails: 0, pushes: 0, told: 0 };
  const detail = await getEventDetail(db, ev);
  let emails = 0;
  let pushes = 0;
  for (const p of people) {
    const c = await ctx(db, ev, p.locale, p, detail);
    if (emailEnabled() && p.email && p.emailNotifications) {
      const { html, text } = layout({ heading: c.t("email.wanted.heading", c.vars), body: c.t("email.wanted.body", c.vars), meta: c.meta, cta: { label: c.openLabel, url: c.url }, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel, telegram: c.telegram });
      await sendEmail({ to: p.email, subject: c.t("email.wanted.subject", c.vars), html, text }).catch(() => undefined);
      emails++;
    }
    if (pushEnabled()) {
      for (const sub of await subscriptionsFor(db, [p.id])) {
        const r = await sendPush(sub, { title: c.t("push.wantedTitle", c.vars), body: c.t("push.wantedBody", c.vars), url: c.url, tag: `wanted-${ev.code}` });
        if (r === "sent") pushes++;
        if (r === "gone") await removePushSubscription(db, sub.endpoint);
      }
    }
  }
  // Only after they were actually told: a cooldown started by a notice that never went out would
  // silence the next match for six hours for nothing.
  await markWantsNotified(db, signalIds, now);
  return { emails, pushes, told: people.length };
}

/**
 * The club's own feed says a court is free at an hour and a club somebody asked for (the rules are in
 * `courtOffersDue`). They hear once, on the channel they have (`tell`: Telegram, else email, else push),
 * with one button: the match form at that club, that day and that hour. Unlike `notifyWanted`, the
 * claim comes before the send, because it is what stops a second run from sending the same court; a
 * person nothing can reach is never claimed.
 */
export async function offerFreeCourts(db: Db, now = new Date(), say: typeof tell = tell): Promise<{ offered: number }> {
  const reach = { telegram: telegramEnabled(), email: emailEnabled(), push: pushEnabled() };
  let offered = 0;
  for (const offer of await courtOffersDue(db, now, reach)) {
    if (offered >= COURT_OFFERS.perRun) break;
    if ((await claimCourtOffer(db, offer, now)).length === 0) continue;
    const { t, locale } = await translatorFor(offer.player.locale);
    const vars = { club: offer.club.name, time: formatEventTime(offer.hour.start, offer.club.tz, locale) };
    const ticket = reach.telegram && offer.player.telegramId ? chatTicket(offer.player.telegramId, now) : null;
    const button = { text: t("want.courtButton"), url: courtOfferLink(baseUrl(), offer, ticket) };
    await say(db, offer.player, `${t("want.courtTitle", vars)}\n${t("want.courtBody", vars)}`, { inline_keyboard: [[button]] }, { label: button.text }).catch(() => undefined);
    offered++;
  }
  return { offered };
}

/**
 * A spot opened, or was never taken, and nobody was waiting for it. The crew, the club's regulars and
 * the people its players played with are the ones who would take it, and until now they were never
 * told: the slot sat open until three players turned up or the match quietly died.
 *
 * Each person hears once, on the channel they have (`channelFor`): in Telegram a private message whose
 * ✅ is the same one-tap join the card carries, else an email with the match link, else a push. Who
 * hears it, and the once-ever rule, are decided in `refillRecipients`; this only carries the words.
 */
export async function notifyRefill(db: Db, eventId: string, now = new Date()): Promise<{ telegram: number; emails: number; pushes: number; told: number }> {
  const sent = { telegram: 0, emails: 0, pushes: 0, told: 0 };
  const reach = channelsOffered();
  if (!reach.telegram && !reach.email && !reach.push) return sent;
  const found = await refillRecipients(db, eventId, now, reach);
  if (!found) return sent;
  const { event: ev, players: people } = found;
  const detail = await getEventDetail(db, ev);
  const seated = detail.roster.filter(isOccupied);
  const left = detail.roster.filter(isClaimable).length;
  for (const p of people) {
    const via = channelFor(p, reach);
    if (via === "telegram" && p.telegramId) {
      const locale = botLocale(p.locale);
      const s = botStrings(locale);
      // First names only (rule 7), and the public link: a forwarded message keeps its buttons.
      const who = seated.map((x) => (x.player?.displayName ?? x.invitedName ?? "").trim().split(/\s+/)[0]).filter(Boolean).join(", ");
      const text = s.refillOffer(cardTitle(detail, locale), whenLine(detail, locale), whereLine(detail, locale), who, s.spots(left));
      const keyboard = { inline_keyboard: [[{ text: s.in, callback_data: `j:${ev.code}` }, { text: s.open, url: miniAppUrl(ev.code) ?? eventUrl(baseUrl(), ev.code) }]] };
      const res = await sendMessage(p.telegramId, esc(text), { keyboard }).catch(() => null);
      if (res?.ok) sent.telegram++;
      continue;
    }
    const c = await ctx(db, ev, p.locale, p, detail);
    // The push's own two lines: the email is the same notice for somebody with no bot and no device.
    const title = c.t("push.refillTitle", c.vars);
    const body = c.t("push.refillBody", c.vars);
    if (via === "email" && p.email) {
      const { html, text } = layout({ heading: title, body, meta: c.meta, cta: { label: c.openLabel, url: c.url }, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel, telegram: c.telegram });
      if (await sendEmail({ to: p.email, subject: title, html, text }).catch(() => false)) sent.emails++;
      continue;
    }
    for (const sub of await subscriptionsFor(db, [p.id])) {
      const r = await sendPush(sub, { title, body, url: c.url, tag: `refill-${ev.code}` });
      if (r === "sent") sent.pushes++;
      if (r === "gone") await removePushSubscription(db, sub.endpoint);
    }
  }
  sent.told = people.length;
  return sent;
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
  const detail = await getEventDetail(db, ev);
  if (emailEnabled())
    await Promise.all(
      participantsWithEmail(detail.roster).map(async (r) => {
        const c = await ctx(db, ev, r.locale, r.playerId ? await getPlayer(db, r.playerId) : null, detail);
        const { html, text } = layout({ heading: c.t("email.updated.heading"), body: c.t("email.updated.body", c.vars), meta: c.meta, cta: { label: c.openLabel, url: c.url }, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel, telegram: c.telegram });
        await sendEmail({ to: r.email, subject: c.t("email.updated.subject", c.vars), html, text, ics: { method: "REQUEST", content: icsFor(ev, c, { name: r.name, email: r.email }, "REQUEST") } });
      }),
    );
  await tellTheRest(db, ev, detail, "updated");
}

/**
 * Everybody on the roster an email cannot reach, told on the channel they do have.
 *
 * The match was the last thing here that spoke by email alone. The coach's book learned this once
 * already — sixteen notices that read `if (p.telegramId)`, so somebody with no address heard
 * nothing — and `tell()` is the answer it landed on: Telegram, then email, then web push. The
 * tournament uses it too. "The line-up is complete", "the time moved" and "it is off" did not, so a
 * player who linked Telegram, or who allowed push, heard nothing at all about their own match.
 *
 * Only people with no address. Somebody who turned activity emails off made a choice, and a push
 * instead of the email they refused is not a fix, it is a way around them.
 */
async function tellTheRest(db: Db, ev: Event, detail: EventDetail, key: "lineupComplete" | "lineupOpen" | "updated" | "cancelled", excludePlayerId?: string | null): Promise<number> {
  let told = 0;
  // An address that bounced or complained is no address: sendEmail refuses it, so its owner is told
  // here, on the channel they do have (src/lib/domain/emailMarks.ts).
  const marked = await markedAmong(db, detail.roster.flatMap((s) => [s.player?.email, s.invitedEmail]));
  const works = (a: string | null | undefined) => Boolean(a) && !marked.has(normalAddress(a));
  for (const slot of detail.roster) {
    if (slot.status !== "joined" && slot.status !== "confirmed") continue;
    // The complement of participantsWithEmail(), read the same way, so nobody is told twice and
    // nobody falls between the two.
    if (works(slot.player?.email) || works(slot.invitedEmail)) continue;
    const player = slot.player;
    if (!player || (excludePlayerId && player.id === excludePlayerId)) continue;
    const c = await ctx(db, ev, player.locale, player, detail);
    const heading = c.t(`push.${key}Title` as "push.lineupCompleteTitle", c.vars);
    const body = c.t(`push.${key}Body` as "push.lineupCompleteBody", c.vars);
    await tell(db, player, `${heading}\n${body}`, { inline_keyboard: [[{ text: c.openLabel, url: c.url }]] });
    told++;
  }
  return told;
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
  const freshDetail = { ...detail, event: fresh };
  const ns = complete ? "email.lineupComplete" : "email.lineupOpen";
  if (emailEnabled())
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
            telegram: c.telegram,
          });
          await sendEmail({ to: r.email, subject: c.t(`${ns}.subject` as "email.lineupComplete.subject", c.vars), html, text, ics: { method: "REQUEST", content: icsFor(fresh, c, { name: r.name, email: r.email }, "REQUEST") } });
        }),
    );
  await tellTheRest(db, fresh, freshDetail, complete ? "lineupComplete" : "lineupOpen", excludePlayerId);
  return fresh;
}

export async function notifyEventCancelled(db: Db, ev: Event): Promise<void> {
  const detail = await getEventDetail(db, ev);
  if (emailEnabled())
    await Promise.all(
      participantsWithEmail(detail.roster).map(async (r) => {
        const c = await ctx(db, ev, r.locale, r.playerId ? await getPlayer(db, r.playerId) : null, detail);
        const { html, text } = layout({ heading: c.t("email.cancelled.heading"), body: c.t("email.cancelled.body", { ...c.vars, organizer: detail.creator.displayName }), meta: c.meta, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel, telegram: c.telegram });
        await sendEmail({ to: r.email, subject: c.t("email.cancelled.subject", c.vars), html, text, ics: { method: "CANCEL", content: icsFor(ev, c, { name: r.name, email: r.email }, "CANCEL") } });
      }),
    );
  await tellTheRest(db, ev, detail, "cancelled");
}

/** Removed by the organizer → cancel their calendar entry (courtesy). */
export async function notifyRemoved(db: Db, ev: Event, removedPlayerId: string | null): Promise<void> {
  if (!emailEnabled() || !removedPlayerId) return;
  const p = await getPlayer(db, removedPlayerId);
  if (!p?.email) return;
  const c = await ctx(db, ev, p.locale, p);
  const { html, text } = layout({ heading: c.t("activity.removed", { name: p.displayName }), body: c.t("email.footer", { app: APP_NAME }), meta: c.meta, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel, telegram: c.telegram });
  await sendEmail({ to: p.email, subject: c.t("email.cancelled.subject", c.vars), html, text, ics: { method: "CANCEL", content: icsFor(ev, c, { name: p.displayName, email: p.email }, "CANCEL") } });
}

/** Immediate invite to a reserved spot when the organizer entered an email. */
export async function sendInviteEmail(db: Db, ev: Event, slot: Slot, creator: Player): Promise<boolean> {
  if (!emailEnabled() || !slot.invitedEmail || !slot.inviteCode) return false;
  if (await isOptedOut(db, slot.invitedEmail)) return false;
  const c = await ctx(db, ev, creator.locale);
  const link = inviteUrl(baseUrl(), ev.code, slot.inviteCode);
  const { html, text } = layout({
    heading: c.t("email.invite.heading", { organizer: creator.displayName }),
    body: c.t("email.invite.body", { ...c.vars, name: slot.invitedName ?? "" }),
    meta: c.meta,
    cta: { label: c.t("email.inviteReminder.confirm"), url: link },
    secondary: { label: c.t("email.inviteReminder.decline"), url: `${link}?decline=1` },
    footer: c.t("email.footerInvite", { app: APP_NAME, organizer: creator.displayName }),
    footerLink: { label: c.t("email.optOut"), url: `${baseUrl()}${optOutPath(slot.invitedEmail)}` },
    eventUrl: c.publicUrl,
    openLabel: c.openLabel,
  telegram: c.telegram,
});
  return sendEmail({ to: slot.invitedEmail, subject: c.t("email.invite.subject", { ...c.vars, organizer: creator.displayName }), html, text });
}

/** 24h reminder to an unconfirmed invitee with an email (decision 12). */
export async function sendInviteReminder(db: Db, ev: Event, slot: Slot, creator: Player): Promise<boolean> {
  if (!emailEnabled() || !slot.invitedEmail || !slot.inviteCode) return false;
  // Opted out counts as handled: no retry every hour.
  if (await isOptedOut(db, slot.invitedEmail)) return true;
  const c = await ctx(db, ev, creator.locale);
  const link = inviteUrl(baseUrl(), ev.code, slot.inviteCode);
  const { html, text } = layout({
    heading: c.t("email.inviteReminder.heading", { organizer: creator.displayName }),
    body: c.t("email.inviteReminder.body", c.vars),
    meta: c.meta,
    cta: { label: c.t("email.inviteReminder.confirm"), url: link },
    secondary: { label: c.t("email.inviteReminder.decline"), url: `${link}?decline=1` },
    footer: c.t("email.footerInvite", { app: APP_NAME, organizer: creator.displayName }),
    footerLink: { label: c.t("email.optOut"), url: `${baseUrl()}${optOutPath(slot.invitedEmail)}` },
    eventUrl: c.publicUrl,
    openLabel: c.openLabel,
  telegram: c.telegram,
});
  return sendEmail({ to: slot.invitedEmail, subject: c.t("email.inviteReminder.subject", c.vars), html, text });
}

/** The single post-match score reminder to the creator (decision 13). */
export async function sendScoreReminder(db: Db, ev: Event, creator: Player): Promise<boolean> {
  if (!emailEnabled() || !creator.email || !creator.emailNotifications) return false;
  const c = await ctx(db, ev, creator.locale, creator);
  const { html, text } = layout({ heading: c.t("email.scoreReminder.heading"), body: c.t("email.scoreReminder.body", c.vars), meta: c.meta, cta: { label: c.t("email.scoreReminder.cta"), url: `${c.url}#score` }, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel, telegram: c.telegram });
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
  return sendEmail({ to: email, subject: t("email.code.subject", { code }), html, text, proof: true });
}

/** The claim's code: to a work email at the club's own domain, so the address itself is the proof. */
export async function sendClaimCodeEmail(email: string, code: string, club: string, localeLike: string | null | undefined): Promise<boolean> {
  if (!emailEnabled()) return false;
  const { t } = await translatorFor(localeLike);
  const base = baseUrl();
  const { html, text } = layout({
    heading: t("email.claimCode.heading", { club }),
    body: t("email.claimCode.body", { club }),
    meta: [{ label: t("email.code.codeLabel"), value: code }],
    footer: t("email.claimCode.footer"),
    eventUrl: `${base}/clubs`,
    openLabel: t("common.clubs"),
  });
  return sendEmail({ to: email, subject: t("email.claimCode.subject", { code, club }), html, text, proof: true });
}
