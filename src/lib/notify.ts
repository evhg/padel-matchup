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
import { APP_NAME, baseUrl, emailEnabled, emailFrom, REFILL_EMAIL_MAX, shortHost } from "@/lib/config";
import { formatEventDay, formatEventTime, formatEventTimeRange, utcToZonedParts } from "@/lib/dates";
import { eventEnd } from "@/lib/domain/matchLength";
import { getEventDetail, participantsWithEmail, type EventDetail } from "@/lib/domain/queries";
import { isClaimable, isOccupied, isSeated } from "@/lib/domain/events";
import { refillRecipients } from "@/lib/domain/refill";
import { groupAdmins } from "@/lib/domain/groups";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";
import { markWantsNotified, wantAudience } from "@/lib/domain/demand";
import { claimCourtOffer, COURT_OFFERS, courtOfferLink, courtOffersDue } from "@/lib/domain/courtOffers";
import { chatTicket } from "@/lib/telegram/identity";
import { getPlayer } from "@/lib/domain/players";
import { promotedOf, type Promotion } from "@/lib/domain/slots";
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
import { sendWaTemplate, waLocale, waMatchLine } from "@/lib/whatsapp/templates";
import { markHeldDelivered, matchParams, quietSummariesDue, recordNotice, recordNotices, type NoticeInput } from "@/lib/domain/notices";
import { kindOn, type Sender } from "@/lib/domain/noticeKinds";

/**
 * All outbound notifications live here. Every function is safe to call when
 * email is disabled (no-ops) and never throws into the request path.
 *
 * Every notice to a player passes the gate first (`recordNotices` in src/lib/domain/notices.ts): its
 * row goes into the player's inbox, in one insert for a whole fan-out, and the sender delivers only to
 * the people the gate released — their switch for that kind is on, and it is not their quiet hours, or
 * the match starts within three hours. What a person asked for themselves (the calendar invitation of
 * a match they just joined, a code, their link) is not a notice and passes no gate.
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
    // The end as well as the start: the email says how long the court is booked, as its invitation does.
    { label: t("email.when"), value: `${day} · ${formatEventTimeRange(ev.startsAt, eventEnd(ev), ev.tz, locale)}` },
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
  // The organiser's feed is a notice like any other: kept in the inbox, held at night, off when they say so.
  const release = await recordNotice(db, { playerId: creator.id, sender: "organizerFeed", eventId: ev.id, params: { ...matchParams(ev), what: kind, name: actorName }, startsAt: ev.startsAt, tz: ev.tz });
  if (release !== "now") return;
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
  const release = await recordNotice(db, { playerId: player.id, sender: approved ? "requestApproved" : "requestDeclined", eventId: ev.id, params: matchParams(ev), startsAt: ev.startsAt, tz: ev.tz });
  if (release !== "now" || !emailEnabled()) return;
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

/**
 * A new ask to join a group reaches its admins by `tell()`: Telegram, else email, else push, with one
 * button to the group page where Approve and Decline sit. Never WhatsApp: `tell()` sends there only
 * with a template, and no template carries a group's ask. Called from `after()`, never in the
 * request path, and through `notifyGroupAskCapped`, which holds the day's ceiling.
 */
export async function notifyGroupAsk(db: Db, group: Pick<Group, "id" | "code" | "name">, asker: Pick<Player, "id" | "displayName">, note: string | null): Promise<number> {
  const admins = (await groupAdmins(db, group.id)).filter((a) => a.id !== asker.id);
  const url = `${baseUrl()}/g/${group.code}`;
  // The note is the asker's own words for the admins: it goes on their channel, never into a row.
  const released = await recordNotices(db, admins.map((a) => ({ playerId: a.id, sender: "groupAsk", params: { name: asker.displayName, group: group.name } })));
  let told = 0;
  for (const admin of admins) {
    const { t } = await translatorFor(admin.locale);
    const lines = [t("group.askNotice", { name: asker.displayName, group: group.name }), ...(note ? [`💬 ${note}`] : []), t("group.askNoticeHelp")];
    await tell(db, admin, lines.join("\n"), { inline_keyboard: [[{ text: t("group.open"), url }]] }, { notice: { released: released.get(admin.id) ?? "now" }, label: t("group.open") }).catch(() => undefined);
    told++;
  }
  return told;
}

/**
 * The ceiling on the admins' ask notices: `LIMITS.groupAskNoticesPerGroupPerDay` a day for each
 * group, counted on `metrics_daily` like every other limit. Past it the ask still stands and waits on
 * the group page; only the notice is skipped, so a script that makes names and asks cannot turn an
 * admin's phone into a pager. Returns how many admins were told, or null when the day's notices are
 * used up.
 */
export async function notifyGroupAskCapped(db: Db, group: Pick<Group, "id" | "code" | "name">, asker: Pick<Player, "id" | "displayName">, note: string | null, now = new Date()): Promise<number | null> {
  if (!(await takeRate(db, "group_ask_notice", group.id, LIMITS.groupAskNoticesPerGroupPerDay, "day", now))) return null;
  return notifyGroupAsk(db, group, asker, note);
}

/** The asker hears the answer either way: a yes with the door to the group, a no kindly, with when they may ask again. */
export async function notifyGroupAskDecided(db: Db, group: Pick<Group, "code" | "name">, player: Player, approved: boolean): Promise<void> {
  const { t } = await translatorFor(player.locale);
  const url = `${baseUrl()}/g/${group.code}`;
  const text = approved ? t("group.askApprovedNotice", { group: group.name }) : t("group.askDeclinedNotice", { group: group.name });
  await tell(db, player, text, { inline_keyboard: [[{ text: t("group.open"), url }]] }, { notice: { sender: approved ? "groupAskApproved" : "groupAskDeclined", params: { group: group.name } }, label: t("group.open") }).catch(() => undefined);
}

/** A group got a new match (by a member or the weekly slot): email + push to every other member. */
export async function notifyGroupMatch(db: Db, group: Group, ev: Event, excludePlayerId?: string | null): Promise<{ emails: number; pushes: number }> {
  const rows = await db.select({ player: playersTable }).from(groupMembersTable).innerJoin(playersTable, eq(playersTable.id, groupMembersTable.playerId)).where(eq(groupMembersTable.groupId, group.id));
  const organizer = await getPlayer(db, ev.creatorPlayerId);
  const detail = await getEventDetail(db, ev);
  const members = rows.map((r) => r.player).filter((p) => !(excludePlayerId && p.id === excludePlayerId));
  const released = await recordNotices(db, members.map((p) => ({ playerId: p.id, sender: "crewMatch", eventId: ev.id, params: { ...matchParams(ev), group: group.name }, startsAt: ev.startsAt, tz: ev.tz })));
  let emails = 0;
  let pushes = 0;
  for (const p of members) {
    if (released.get(p.id) !== "now") continue;
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
 * May this player get the club programme's email about a new match? Only a player who switched
 * "club matches" on: the owner's decision B (9 October 2026) made it an opt-in, and decision D made
 * the opt-in one of the notice kinds, off by default (`KIND_DEFAULTS`). The gate in `notifyClubMatch`
 * already holds every channel behind the same switch; this is the email path's own answer, kept so
 * the email can never be the one channel that forgets it.
 */
export function mayEmailClubMatch(p: Pick<Player, "noticeKinds">): boolean {
  return kindOn(p.noticeKinds, "clubMatches");
}

/**
 * A club's weekly programme creates a match and, until now, told nobody: no push, no email, no card,
 * unlike the group matches made in the very same cron tick. It sat on the club's page waiting to be
 * browsed to, which is not how a quiet Tuesday hour gets filled.
 *
 * Who hears it: people with a match at that club in the last three months or still to come, at a level
 * the match admits. Bounded on purpose (rule 12) — one indexed read on (venue_slug, starts_at), a
 * hard cap on recipients, and it runs in the cron tick, never in a path a person waits on.
 *
 * Only to the players who switched "club matches" on: the email went to up to forty past players who
 * never asked for it, and /about promises that emails go out only for things a player asked for. The
 * owner stopped it on 9 October 2026 (decision B), and decision D made the whole notice one kind, off
 * by default (`mayEmailClubMatch`). Everybody it was for still finds it in their inbox.
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
  // A match with a level range is for the people it admits; an unrated player is not chased.
  const admitted = (await db.select().from(playersTable).where(inArray(playersTable.id, ids))).filter(
    (p) => (ev.levelMin === null && ev.levelMax === null) || (p.level !== null && (ev.levelMin === null || p.level >= ev.levelMin) && (ev.levelMax === null || p.level <= ev.levelMax)),
  );
  const detail = await getEventDetail(db, ev);
  // Off by default (decision B): every one of them finds it in the inbox, and only those who switched club matches on hear it.
  const released = await recordNotices(db, admitted.map((p) => ({ playerId: p.id, sender: "clubMatch", eventId: ev.id, params: { ...matchParams(ev), club: club.name }, startsAt: ev.startsAt, tz: ev.tz })), now);
  let emails = 0;
  let pushes = 0;
  let told = 0;
  for (const p of admitted) {
    if (released.get(p.id) !== "now") continue;
    told++;
    const c = await ctx(db, ev, p.locale, p, detail);
    const vars = { ...c.vars, club: club.name };
    if (emailEnabled() && p.email && p.emailNotifications && mayEmailClubMatch(p)) {
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
  const released = await recordNotices(db, people.map((p) => ({ playerId: p.id, sender: "wanted", eventId: ev.id, params: matchParams(ev), startsAt: ev.startsAt, tz: ev.tz })), now);
  let emails = 0;
  let pushes = 0;
  for (const p of people) {
    if (released.get(p.id) !== "now") continue;
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
 * The club's free courts say a court is free at an hour and a club somebody asked for (the rules are in
 * `courtOffersDue`): from the club's own feed, or from a read of its booking platform's public page. A
 * read covers three days, so an hour after the club's midnight says "tomorrow". They hear once, through
 * the notice gate (kind `spots`, sender `courtFree`), on the channel they have (`tell`: Telegram, else
 * email, else push), with one button: the match form at that club, that day and that hour. Unlike `notifyWanted`, the
 * claim comes before the send, because it is what stops a second run from sending the same court; a
 * person nothing can reach is never claimed.
 */
export async function offerFreeCourts(db: Db, now = new Date(), say: typeof tell = tell): Promise<{ offered: number }> {
  const reach = { telegram: telegramEnabled(), email: emailEnabled(), push: pushEnabled() };
  const claimed: Awaited<ReturnType<typeof courtOffersDue>> = [];
  for (const offer of await courtOffersDue(db, now, reach)) {
    if (claimed.length >= COURT_OFFERS.perRun) break;
    if ((await claimCourtOffer(db, offer, now)).length === 0) continue;
    claimed.push(offer);
  }
  // Claimed first, then one insert for the run's offers, then the sends (rule 12).
  const released = await recordNotices(db, claimed.map((o) => ({ playerId: o.player.id, sender: "courtFree", params: { club: o.club.name, at: o.hour.start.toISOString(), tz: o.club.tz ?? undefined }, startsAt: o.hour.start, tz: o.club.tz })), now);
  for (const offer of claimed) {
    const { t, locale } = await translatorFor(offer.player.locale);
    const vars = { club: offer.club.name, time: formatEventTime(offer.hour.start, offer.club.tz, locale) };
    const ticket = reach.telegram && offer.player.telegramId ? chatTicket(offer.player.telegramId, now) : null;
    const button = { text: t("want.courtButton"), url: courtOfferLink(baseUrl(), offer, ticket) };
    const title = offer.hour.date === utcToZonedParts(now, offer.club.tz).date ? t("want.courtTitle", vars) : t("want.courtTitleTomorrow", vars);
    await say(db, offer.player, `${title}\n${t("want.courtBody", vars)}`, { inline_keyboard: [[button]] }, { notice: { released: released.get(offer.player.id) ?? "now" }, label: button.text }).catch(() => undefined);
  }
  return { offered: claimed.length };
}

/**
 * A spot opened, or was never taken, and nobody was waiting for it. The crew, the club's regulars and
 * the people its players played with are the ones who would take it, and until now they were never
 * told: the slot sat open until three players turned up or the match quietly died.
 *
 * Each person hears once, on the channel they have (`channelFor`): in Telegram a private message whose
 * ✅ is the same one-tap join the card carries, else the `ks_spot_open` template in WhatsApp whose
 * "I'm in" is the thread's own `wj:` join, else an email with the match link, else a push. Who hears
 * it, and the once-ever rule, are decided in `refillRecipients`; this only carries the words.
 */
export async function notifyRefill(db: Db, eventId: string, now = new Date()): Promise<{ telegram: number; whatsapp: number; emails: number; pushes: number; told: number }> {
  const sent = { telegram: 0, whatsapp: 0, emails: 0, pushes: 0, told: 0 };
  const reach = channelsOffered();
  if (!reach.telegram && !reach.whatsapp && !reach.email && !reach.push) return sent;
  const found = await refillRecipients(db, eventId, now, reach);
  if (!found) return sent;
  const { event: ev, players: people } = found;
  const detail = await getEventDetail(db, ev);
  const seated = detail.roster.filter(isOccupied);
  const left = detail.roster.filter(isClaimable).length;
  // First names only (rule 7), and the public link: a forwarded message keeps its buttons.
  const who = seated.map((x) => (x.player?.displayName ?? x.invitedName ?? "").trim().split(/\s+/)[0]).filter(Boolean).join(", ");
  const released = await recordNotices(db, people.map((p) => ({ playerId: p.id, sender: "spotOpen", eventId: ev.id, params: matchParams(ev), startsAt: ev.startsAt, tz: ev.tz })), now);
  for (const p of people) {
    if (released.get(p.id) !== "now") continue;
    let via = channelFor(p, reach);
    if (via === "telegram" && p.telegramId) {
      const locale = botLocale(p.locale);
      const s = botStrings(locale);
      const text = s.refillOffer(cardTitle(detail, locale), whenLine(detail, locale), whereLine(detail, locale), who, s.spots(left));
      const keyboard = { inline_keyboard: [[{ text: s.in, callback_data: `j:${ev.code}` }, { text: s.open, url: miniAppUrl(ev.code) ?? eventUrl(baseUrl(), ev.code) }]] };
      const res = await sendMessage(p.telegramId, esc(text), { keyboard }).catch(() => null);
      if (res?.ok) sent.telegram++;
      continue;
    }
    if (via === "whatsapp" && p.phone) {
      const locale = waLocale(p.locale);
      const { t } = await translatorFor(locale);
      // "I'm in" comes back as `wj:<code>`, which the thread joins exactly as its own button does.
      const res = await sendWaTemplate(db, p.phone, "ks_spot_open", locale, { body: [waMatchLine(detail, locale), who, t("event.spotsLeft", { count: left })], quickReply: `wj:${ev.code}`, button: ev.code }, now);
      if (res.ok) {
        sent.whatsapp++;
        continue;
      }
      // Not sent (the day's cap, a template not approved yet): email, then push, as without WhatsApp,
      // and the email still inside this spot's email cap.
      via = channelFor(p, { ...reach, telegram: false, whatsapp: false });
      if (via === "none" || (via === "email" && sent.emails >= REFILL_EMAIL_MAX)) continue;
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

/**
 * Handles the fallout of a promotion: promoted player invite + creator notice. Every player it moved
 * up, one after another: a fixed-pairs night moves a pair, or a single and a single, in one write.
 */
export async function notifyPromotion(db: Db, ev: Event, promotion: Promotion | null): Promise<void> {
  // Every player it moved up, in one insert (rule 12); each hears it once, and the organiser's feed as before.
  const moved: Player[] = [];
  for (const p of promotedOf(promotion)) {
    const promoted = await getPlayer(db, p.playerId);
    if (promoted) moved.push(promoted);
  }
  const released = await recordNotices(db, moved.map((p) => ({ playerId: p.id, sender: "movedUp", eventId: ev.id, params: matchParams(ev), startsAt: ev.startsAt, tz: ev.tz })));
  for (const promoted of moved) {
    await Promise.all([released.get(promoted.id) === "now" ? sendCalendarInvite(db, ev, promoted, "promoted") : null, notifyCreator(db, ev, "promoted", promoted.displayName, promoted.id)]);
  }
}

/**
 * The gate for a notice to a whole line-up: one row for each seated player but `except` (the person
 * who made the change, or who hears of it another way), in one insert. A seat with no player row (an
 * invitee known only by an address) is nobody's inbox and is told as before; so is `except`, whose
 * calendar still has to follow their own change.
 */
async function gateRoster(db: Db, ev: Event, detail: EventDetail, sender: Sender, except: readonly string[] = []): Promise<(playerId: string | null | undefined) => boolean> {
  const ids = [...new Set(detail.roster.filter((s) => (s.status === "joined" || s.status === "confirmed") && s.playerId && !except.includes(s.playerId)).map((s) => s.playerId!))];
  const released = await recordNotices(db, ids.map((playerId): NoticeInput => ({ playerId, sender, eventId: ev.id, params: matchParams(ev), startsAt: ev.startsAt, tz: ev.tz })));
  return (playerId) => !playerId || (released.get(playerId) ?? "now") === "now";
}

/** Time/venue changed → updated .ics (same UID, bumped SEQUENCE) to everyone with an email. */
export async function notifyEventUpdated(db: Db, ev: Event): Promise<void> {
  const detail = await getEventDetail(db, ev);
  const goes = await gateRoster(db, ev, detail, "matchUpdated", [ev.creatorPlayerId]);
  if (emailEnabled())
    await Promise.all(
      participantsWithEmail(detail.roster).filter((r) => goes(r.playerId)).map(async (r) => {
        const c = await ctx(db, ev, r.locale, r.playerId ? await getPlayer(db, r.playerId) : null, detail);
        const { html, text } = layout({ heading: c.t("email.updated.heading"), body: c.t("email.updated.body", c.vars), meta: c.meta, cta: { label: c.openLabel, url: c.url }, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel, telegram: c.telegram });
        await sendEmail({ to: r.email, subject: c.t("email.updated.subject", c.vars), html, text, ics: { method: "REQUEST", content: icsFor(ev, c, { name: r.name, email: r.email }, "REQUEST") } });
      }),
    );
  await tellTheRest(db, ev, detail, "updated", goes);
}

/**
 * Everybody on the roster an email cannot reach, told on the channel they do have.
 *
 * The match was the last thing here that spoke by email alone. The coach's book learned this once
 * already — sixteen notices that read `if (p.telegramId)`, so somebody with no address heard
 * nothing — and `tell()` is the answer it landed on: Telegram, then WhatsApp, then email, then web
 * push. The tournament uses it too. "The line-up is complete", "the time moved" and "it is off" did
 * not, so a player who linked Telegram, or who allowed push, heard nothing at all about their own
 * match. In WhatsApp the notice is the `ks_match_update` template: the match, the one line that
 * changed, and a button to the public match page.
 *
 * Only people with no address. Somebody who turned activity emails off made a choice, and a push
 * instead of the email they refused is not a fix, it is a way around them. And only the people the
 * caller's gate released (`goes`): the rows were written once, for the whole line-up.
 */
async function tellTheRest(db: Db, ev: Event, detail: EventDetail, key: "lineupComplete" | "lineupOpen" | "updated" | "cancelled", goes: (playerId: string) => boolean, excludePlayerIds: readonly string[] = []): Promise<number> {
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
    if (!player || excludePlayerIds.includes(player.id) || !goes(player.id)) continue;
    const c = await ctx(db, ev, player.locale, player, detail);
    const heading = c.t(`push.${key}Title` as "push.lineupCompleteTitle", c.vars);
    const body = c.t(`push.${key}Body` as "push.lineupCompleteBody", c.vars);
    const wa = waLocale(player.locale);
    await tell(db, player, `${heading}\n${body}`, { inline_keyboard: [[{ text: c.openLabel, url: c.url }]] }, { notice: { released: "now" }, whatsapp: { template: "ks_match_update", body: [waMatchLine(c.detail, wa), heading], button: ev.code } });
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
/** `excludePlayerId`: who hears of this another way (the joiner, the players a promotion moved up). */
export async function notifyLineupChange(db: Db, ev: Event, wasComplete: boolean, excludePlayerId?: string | readonly string[] | null): Promise<Event | null> {
  const excluded = new Set(typeof excludePlayerId === "string" ? [excludePlayerId] : (excludePlayerId ?? []));
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
  const goes = await gateRoster(db, fresh, freshDetail, complete ? "lineupComplete" : "lineupOpen", [...excluded]);
  if (emailEnabled())
    await Promise.all(
      participantsWithEmail(detail.roster)
        .filter((r) => (!r.playerId || !excluded.has(r.playerId)) && goes(r.playerId))
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
  await tellTheRest(db, fresh, freshDetail, complete ? "lineupComplete" : "lineupOpen", goes, [...excluded]);
  return fresh;
}

export async function notifyEventCancelled(db: Db, ev: Event): Promise<void> {
  const detail = await getEventDetail(db, ev);
  const goes = await gateRoster(db, ev, detail, "matchCancelled", [ev.creatorPlayerId]);
  if (emailEnabled())
    await Promise.all(
      participantsWithEmail(detail.roster).filter((r) => goes(r.playerId)).map(async (r) => {
        const c = await ctx(db, ev, r.locale, r.playerId ? await getPlayer(db, r.playerId) : null, detail);
        const { html, text } = layout({ heading: c.t("email.cancelled.heading"), body: c.t("email.cancelled.body", { ...c.vars, organizer: detail.creator.displayName }), meta: c.meta, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel, telegram: c.telegram });
        await sendEmail({ to: r.email, subject: c.t("email.cancelled.subject", c.vars), html, text, ics: { method: "CANCEL", content: icsFor(ev, c, { name: r.name, email: r.email }, "CANCEL") } });
      }),
    );
  await tellTheRest(db, ev, detail, "cancelled", goes);
}

/** Removed by the organizer → cancel their calendar entry (courtesy). */
/**
 * The organiser took a player out. `absent` is the tournament's check-in ("Who is here?"): the
 * same notice and the same calendar cancel, in words that say the night went on without them
 * rather than that they were struck off.
 */
export async function notifyRemoved(db: Db, ev: Event, removedPlayerId: string | null, opts: { absent?: boolean } = {}): Promise<void> {
  if (!removedPlayerId) return;
  if ((await recordNotice(db, { playerId: removedPlayerId, sender: "removed", eventId: ev.id, params: matchParams(ev), startsAt: ev.startsAt, tz: ev.tz })) !== "now") return;
  if (!emailEnabled()) return;
  const p = await getPlayer(db, removedPlayerId);
  if (!p?.email) return;
  const c = await ctx(db, ev, p.locale, p);
  const heading = opts.absent ? c.t("email.cancelled.absentHeading") : c.t("activity.removed", { name: p.displayName });
  const body = opts.absent ? c.t("email.cancelled.absentBody") : c.t("email.footer", { app: APP_NAME });
  const { html, text } = layout({ heading, body, meta: c.meta, footer: c.footer, eventUrl: c.url, openLabel: c.openLabel, telegram: c.telegram });
  await sendEmail({ to: p.email, subject: c.t(opts.absent ? "email.cancelled.absentSubject" : "email.cancelled.subject", c.vars), html, text, ics: { method: "CANCEL", content: icsFor(ev, c, { name: p.displayName, email: p.email }, "CANCEL") } });
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

/**
 * Quiet hours are over and notices waited through them: each person hears once, one short message on
 * each channel they have ("3 updates while you were away", with the way to My matches), never the
 * notices one by one. The hourly job calls this; the rows then count as delivered, so the next hour
 * does not send it again. A kind switched off never waits here (`releaseOf`), so it is never sent late.
 *
 * WhatsApp gets no summary: outside a conversation it carries only a template Meta approved, and
 * there is none for this. A player whose only channel it is reads the inbox.
 */
export async function sendQuietSummaries(db: Db, now = new Date()): Promise<{ people: number; messages: number }> {
  const due = await quietSummariesDue(db, now);
  if (due.length === 0) return { people: 0, messages: 0 };
  const people = await db.select().from(playersTable).where(inArray(playersTable.id, due.map((d) => d.playerId)));
  const subs = pushEnabled() ? await subscriptionsFor(db, people.map((p) => p.id)) : [];
  const url = `${baseUrl()}/me#inbox`;
  let messages = 0;
  for (const p of people) {
    const count = due.find((d) => d.playerId === p.id)?.count ?? 0;
    const { t } = await translatorFor(p.locale);
    const title = t("notices.awayTitle", { count });
    const body = t("notices.awayBody");
    const open = t("common.myMatches");
    if (telegramEnabled() && p.telegramId) {
      const res = await sendMessage(p.telegramId, esc(`${title}\n${body}`), { silent: true, keyboard: { inline_keyboard: [[{ text: open, url }]] } }).catch(() => null);
      if (res?.ok) messages++;
    }
    if (emailEnabled() && p.email && p.emailNotifications) {
      const { html, text } = layout({ heading: title, body, cta: { label: open, url }, footer: t("email.footer", { app: APP_NAME }), eventUrl: url, openLabel: open, telegram: telegramLine(t("email.telegramLine"), p) });
      if (await sendEmail({ to: p.email, subject: title, html, text }).catch(() => false)) messages++;
    }
    for (const sub of subs.filter((x) => x.playerId === p.id)) {
      const r = await sendPush(sub, { title, body, url, tag: "notices-away" }).catch(() => "failed" as const);
      if (r === "sent") messages++;
      if (r === "gone") await removePushSubscription(db, sub.endpoint).catch(() => undefined);
    }
  }
  await markHeldDelivered(db, due.map((d) => d.playerId), now);
  return { people: due.length, messages };
}
