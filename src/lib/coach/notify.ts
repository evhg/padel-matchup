import type { Db } from "@/db";
import type { Coach, Lesson, LessonPackage, Player } from "@/db/schema";
import { APP_NAME, baseUrl, emailEnabled, emailFrom, shortHost } from "@/lib/config";
import { icsStamp } from "@/lib/dates";
import { getPlayerById, packageLine, type CancelOutcome } from "@/lib/domain/coaching";
import { sendEmail } from "@/lib/email/send";
import { pushEnabled, sendPush } from "@/lib/push";
import { removePushSubscription, subscriptionsFor } from "@/lib/domain/push";
import { layout, translatorFor } from "@/lib/email/templates";
import { esc, sendMessage, telegramEnabled } from "@/lib/telegram/api";
import { epochMin, OFFER_MINUTES, type Offer } from "./chains";
import { coachBotLocale, coachStrings, whenLabel, type CoachBotStrings } from "./strings";
import type { LessonRequest } from "@/db/schema";

/**
 * What leaves the book when something changes: one quiet line to the other side,
 * and a calendar invitation by email when there is an address. The coach hears
 * about students' moves; students hear about the coach's. Nobody is pestered twice.
 */

export type LessonNotice = { lesson: Lesson; coach: Coach; student: Player; pkg: LessonPackage | null; by: "coach" | "student"; /** Free times to tap instead, when the coach cancelled. */ alternatives?: Date[] };

const pkgText = (s: CoachBotStrings, pkg: LessonPackage | null, now = new Date()) => {
  if (!pkg) return s.noPackage;
  const line = packageLine(pkg, now);
  return s.pkgLine(line.left, pkg.size, line.daysLeft);
};

type Keyboard = { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };

/**
 * One notice, to whichever channel this person actually has.
 *
 * Every one of these used to be Telegram or nothing: the call sites all read `if (p.telegramId)`, so a
 * coach who skipped the bot step and gave no address heard nothing at all — sixteen notices with no
 * delivery path, silently. The buttons only exist in Telegram, so the other two channels carry the
 * words and a link to the page where the same thing can be done.
 */
export function channelFor(
  p: Pick<Player, "telegramId" | "email" | "emailNotifications"> | null | undefined,
  configured: { telegram: boolean; email: boolean; push: boolean },
): "telegram" | "email" | "push" | "none" {
  if (!p) return "none";
  if (configured.telegram && p.telegramId) return "telegram";
  if (configured.email && p.email && p.emailNotifications) return "email";
  return configured.push ? "push" : "none";
}

async function tell(db: Db, p: Player | null | undefined, text: string, keyboard?: Keyboard): Promise<void> {
  if (!p) return;
  const via = channelFor(p, { telegram: telegramEnabled(), email: emailEnabled(), push: pushEnabled() });
  if (via === "none") return;
  if (via === "telegram" && p.telegramId) {
    await sendMessage(p.telegramId, esc(text), { silent: true, keyboard: keyboard ?? null }).catch(() => undefined);
    return;
  }
  // The link a button would have opened, so the fallback is not a dead end.
  const url = keyboard?.inline_keyboard.flat().find((b) => b.url)?.url ?? `${baseUrl()}/coach`;
  if (via === "email" && p.email) {
    const { t } = await translatorFor(p.locale);
    const [heading, ...rest] = text.split("\n");
    const { html, text: plain } = layout({ heading, body: rest.join("\n") || heading, footer: t("email.footer", { app: APP_NAME }), eventUrl: url, openLabel: t("email.openMatch"), cta: { label: t("email.openMatch"), url } });
    await sendEmail({ to: p.email, subject: heading, html, text: plain }).catch(() => undefined);
    return;
  }
  // Last resort: the coach is a player, and a player may have turned push on.
  const [title, ...rest] = text.split("\n");
  for (const sub of await subscriptionsFor(db, [p.id])) {
    const r = await sendPush(sub, { title, body: rest.join(" ").slice(0, 140) || title, url }).catch(() => "failed" as const);
    if (r === "gone") await removePushSubscription(db, sub.endpoint).catch(() => undefined);
  }
}

const outcomeText = (s: CoachBotStrings, outcome: CancelOutcome) => (outcome === "free_pass" ? s.outcomeFreePass : outcome === "counted" ? s.outcomeCounted : outcome === "refunded" ? s.outcomeRefunded : s.outcomeNone);

export async function notifyLessonBooked(db: Db, n: LessonNotice): Promise<void> {
  const coachPlayer = await getPlayerById(db, n.coach.playerId);
  if (n.by === "coach") {
    const s = coachStrings(coachBotLocale(n.student.locale));
    await tell(db, n.student, s.coachBooked(n.coach.displayName, whenLabel(n.lesson.startsAt, n.coach.tz, n.student.locale), pkgText(s, n.pkg)), { inline_keyboard: [[{ text: s.cancel, callback_data: `lc:${n.lesson.id}` }]] });
  }
  if (n.by === "student" && coachPlayer) {
    const s = coachStrings(coachBotLocale(coachPlayer.locale));
    await tell(db, coachPlayer, s.studentBooked(n.student.displayName, whenLabel(n.lesson.startsAt, n.coach.tz, coachPlayer.locale), pkgText(s, n.pkg)));
  }
  await emailLesson(n, "REQUEST").catch(() => undefined);
}

export async function notifyLessonCancelled(db: Db, n: LessonNotice & { outcome: CancelOutcome }): Promise<void> {
  const coachPlayer = await getPlayerById(db, n.coach.playerId);
  if (n.by === "coach") {
    const s = coachStrings(coachBotLocale(n.student.locale));
    const alts = n.alternatives ?? [];
    const text = s.coachCancelled(n.coach.displayName, whenLabel(n.lesson.startsAt, n.coach.tz, n.student.locale)) + (alts.length ? `\n${s.altTimes}` : "");
    const keyboard = alts.length ? { inline_keyboard: [alts.map((d) => ({ text: whenLabel(d, n.coach.tz, n.student.locale), callback_data: `lb:${n.coach.id}:${epochMin(d)}` }))] } : undefined;
    await tell(db, n.student, text, keyboard);
  }
  if (n.by === "student" && coachPlayer) {
    const s = coachStrings(coachBotLocale(coachPlayer.locale));
    await tell(db, coachPlayer, s.studentCancelled(n.student.displayName, whenLabel(n.lesson.startsAt, n.coach.tz, coachPlayer.locale), outcomeText(s, n.outcome)));
  }
  await emailLesson(n, "CANCEL").catch(() => undefined);
}

/**
 * One line for a move, not a cancellation followed by an unrelated booking. Before this, the coach's
 * side of a reschedule looked like two events with nothing joining them, which is most of why it felt
 * like something had gone wrong.
 *
 * And this is the first coach notice with an email behind it. Every student-initiated event reached a
 * coach on Telegram or nowhere, so a coach who never opened the bot ran a silent book.
 */
export async function notifyLessonMoved(db: Db, n: { from: Lesson; to: Lesson; coach: Coach; student: Player; by: "coach" | "student" }): Promise<void> {
  const coachPlayer = await getPlayerById(db, n.coach.playerId);
  const told = n.by === "student" ? coachPlayer : n.student;
  if (!told) return;
  const fromWhen = whenLabel(n.from.startsAt, n.coach.tz, told.locale);
  const toWhen = whenLabel(n.to.startsAt, n.coach.tz, told.locale);
  const s = coachStrings(coachBotLocale(told.locale));
  await tell(db, told, n.by === "student" ? s.studentMoved(n.student.displayName, fromWhen, toWhen) : s.coachMoved(n.coach.displayName, fromWhen, toWhen));
  // The student's calendar entry moves with it: one REQUEST at the new hour replaces the old.
  await emailLesson({ lesson: n.to, coach: n.coach, student: n.student, pkg: null, by: n.by }, "REQUEST").catch(() => undefined);
}

/** A student says the money is sent. The coach hears it and taps once; nothing else changes state. */
export async function notifyPaidClaimed(db: Db, n: { coach: Coach; student: Player; lesson: Lesson }): Promise<void> {
  const coachPlayer = await getPlayerById(db, n.coach.playerId);
  if (!coachPlayer) return;
  const when = whenLabel(n.lesson.startsAt, n.coach.tz, coachPlayer.locale);
  const amount = n.lesson.amount ? `${n.lesson.amount} ${n.coach.currency}` : "";
  const s = coachStrings(coachBotLocale(coachPlayer.locale));
  await tell(db, coachPlayer, s.paidClaimed(n.student.displayName, when, amount));
}

/**
 * The other half of a claim. A student said the money was sent and heard nothing back until they
 * next opened the page, which is the kind of silence people read as "it did not work" and ask about
 * in a message — the thing the payment status exists to stop.
 */
export async function notifyPaidConfirmed(db: Db, n: { coach: Coach; student: Player; lesson: Lesson }): Promise<void> {
  const when = whenLabel(n.lesson.startsAt, n.coach.tz, n.student.locale);
  const s = coachStrings(coachBotLocale(n.student.locale));
  await tell(db, n.student, s.paidConfirmed(n.coach.displayName, when));
}

/** A student came in through the coach's own link: one quiet line, no button, nothing to decide. */
export async function notifyStudentJoined(db: Db, coach: Coach, student: Player): Promise<void> {
  const coachPlayer = await getPlayerById(db, coach.playerId);
  if (!coachPlayer) return;
  const s = coachStrings(coachBotLocale(coachPlayer.locale));
  await tell(db, coachPlayer, s.studentJoined(student.displayName));
}

export async function notifyStudentRequest(db: Db, coach: Coach, student: Player): Promise<void> {
  const coachPlayer = await getPlayerById(db, coach.playerId);
  if (!coachPlayer) return;
  const s = coachStrings(coachBotLocale(coachPlayer.locale));
  await tell(db, coachPlayer, s.studentAsked(student.displayName), { inline_keyboard: [[{ text: s.accept, callback_data: `cs:${student.id}` }]] });
}

/** A student the coach added by hand, with an email: one note with the coach's link, nothing else. */
export async function notifyStudentInvited(db: Db, coach: Coach, student: Player): Promise<void> {
  if (!emailEnabled() || !student.email) return;
  const { t } = await translatorFor(student.locale);
  const url = `${baseUrl()}/c/${coach.handle}`;
  const vars = { coach: coach.displayName, app: APP_NAME };
  const { html, text } = layout({
    heading: t("coach.email.invitedHeading", vars),
    body: t("coach.email.invitedBody", vars),
    cta: { label: t("coach.email.open"), url },
    footer: t("email.footer", { app: APP_NAME }),
    eventUrl: url,
    openLabel: t("coach.email.open"),
  });
  await sendEmail({ to: student.email, subject: t("coach.email.invitedSubject", vars), html, text });
}

export async function notifyStudentAccepted(db: Db, coach: Coach, student: Player): Promise<void> {
  
  const s = coachStrings(coachBotLocale(student.locale));
  await tell(db, student, s.youWereAccepted(coach.displayName), { inline_keyboard: [[{ text: s.open, url: `${baseUrl()}/c/${coach.handle}` }]] });
}

/** A freed slot offered to the first in line: one message with a button, thirty minutes on the clock. */
export async function notifyOffer(db: Db, coach: Coach, offer: Offer): Promise<void> {
  const student = offer.player;
  const when = whenLabel(offer.startsAt, coach.tz, student.locale);
  const s = coachStrings(coachBotLocale(student.locale));
  await tell(db, student, s.offer(coach.displayName, when, OFFER_MINUTES), { inline_keyboard: [[{ text: s.offerTake, callback_data: `lo:${offer.entry.id}` }, { text: s.offerNo, callback_data: `lw:${offer.entry.id}` }]] });
}

export async function notifyOfferLapsed(db: Db, coach: Coach, student: Player, startsAt: Date): Promise<void> {
  const s = coachStrings(coachBotLocale(student.locale));
  await tell(db, student, s.offerLapsed(whenLabel(startsAt, coach.tz, student.locale)));
}

/** A time outside the hours: the coach gets one yes/no. Telegram when they have it, email otherwise. */
export async function notifyRequest(db: Db, coach: Coach, student: Player, request: LessonRequest): Promise<void> {
  const coachPlayer = await getPlayerById(db, coach.playerId);
  if (!coachPlayer) return;
  const when = whenLabel(request.startsAt, coach.tz, coachPlayer.locale);
  const s = coachStrings(coachBotLocale(coachPlayer.locale));
  await tell(db, coachPlayer, s.requestAsk(student.displayName, when) + (request.note ? `\n“${request.note}”` : ""), { inline_keyboard: [[{ text: `✓ ${s.requestYes}`, callback_data: `rq:${request.id}:y` }, { text: `✕ ${s.requestNo}`, callback_data: `rq:${request.id}:n` }]] });
}

export async function notifyRequestDecided(db: Db, n: { coach: Coach; student: Player; request: LessonRequest; lesson: Lesson | null; pkg: LessonPackage | null }): Promise<void> {
  const { coach, student, request, lesson } = n;
  const when = whenLabel(request.startsAt, coach.tz, student.locale);
  const s = coachStrings(coachBotLocale(student.locale));
  if (lesson) await tell(db, student, s.requestAccepted(coach.displayName, when, pkgText(s, n.pkg)), { inline_keyboard: [[{ text: s.cancel, callback_data: `lc:${lesson.id}` }]] });
  else await tell(db, student, s.requestDeclined(coach.displayName, when), { inline_keyboard: [[{ text: s.open, url: `${baseUrl()}/c/${coach.handle}` }]] });
  // The calendar entry only exists when the answer was yes; a no is carried by tell() like any notice.
  if (lesson) await emailLesson({ lesson, coach, student, pkg: n.pkg, by: "coach" }, "REQUEST").catch(() => undefined);
}

/** The evening-before reminder: one line, a cancel button, nothing else. */
export async function notifyLessonReminder(db: Db, n: { lesson: Lesson; coach: Coach; student: Player; pkg: LessonPackage | null }): Promise<void> {
  const when = whenLabel(n.lesson.startsAt, n.coach.tz, n.student.locale);
  const s = coachStrings(coachBotLocale(n.student.locale));
  await tell(db, n.student, s.reminder(n.coach.displayName, when, pkgText(s, n.pkg)), { inline_keyboard: [[{ text: s.cancel, callback_data: `lc:${n.lesson.id}` }]] });
}

/** Nearly out, or nearly expired: one note to the student, which is also the rebooking nudge. */
export async function notifyLowPackage(db: Db, n: { pkg: LessonPackage; coach: Coach; student: Player; left: number; daysLeft: number | null }): Promise<void> {
  const s = coachStrings(coachBotLocale(n.student.locale));
  await tell(db, n.student, s.lowPackage(n.coach.displayName, s.pkgLine(n.left, n.pkg.size, n.daysLeft)), { inline_keyboard: [[{ text: s.open, url: `${baseUrl()}/c/${n.coach.handle}` }]] });
}

export async function notifyManagerJoined(db: Db, coach: Coach, manager: Player): Promise<void> {
  const coachPlayer = await getPlayerById(db, coach.playerId);
  if (!coachPlayer) return;
  const s = coachStrings(coachBotLocale(coachPlayer.locale));
  await tell(db, coachPlayer, s.managerJoined(manager.displayName));
}

// ------------------------------------------------------------------ email

const icsEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const fold = (line: string) => {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 73) {
    out.push(rest.slice(0, 73));
    rest = " " + rest.slice(73);
  }
  out.push(rest);
  return out.join("\r\n");
};
const organizerAddress = () => {
  const from = emailFrom();
  const m = from.match(/<([^>]+)>/);
  return m ? m[1] : from;
};

/** One lesson as a calendar object: a REQUEST that Google and Apple add at once, a CANCEL that removes it. */
export function lessonIcs(input: { lesson: Lesson; coach: Coach; student: Player; title: string; method: "REQUEST" | "CANCEL" }): string {
  const { lesson, coach, student, title, method } = input;
  const url = `${baseUrl()}/c/${coach.handle}`;
  const end = new Date(lesson.startsAt.getTime() + lesson.minutes * 60_000);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${APP_NAME}//Coach//EN`,
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:lesson-${lesson.id}@${shortHost()}`,
    `SEQUENCE:${method === "CANCEL" ? 1 : 0}`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(lesson.startsAt)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsEscape(title)}`,
    ...(coach.clubNames.length ? [`LOCATION:${icsEscape(coach.clubNames.join(", "))}`] : []),
    `DESCRIPTION:${icsEscape(url)}`,
    `URL:${url}`,
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    `ORGANIZER;CN=${icsEscape(coach.displayName)}:mailto:${organizerAddress()}`,
    ...(student.email ? [`ATTENDEE;CN=${icsEscape(student.displayName)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${student.email}`] : []),
    "BEGIN:VALARM",
    "TRIGGER:-PT2H",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(title)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

async function emailLesson(n: LessonNotice, method: "REQUEST" | "CANCEL"): Promise<void> {
  if (!emailEnabled() || !n.student.email) return;
  const { t, locale } = await translatorFor(n.student.locale);
  const when = whenLabel(n.lesson.startsAt, n.coach.tz, locale);
  const where = n.coach.clubNames.length ? ` · ${n.coach.clubNames.join(", ")}` : "";
  const pkg = n.pkg ? (() => {
        const line = packageLine(n.pkg, new Date());
        return line.daysLeft === null ? t("coach.packageLineNoExpiry", { left: line.left, size: n.pkg.size }) : t("coach.packageLine", { left: line.left, size: n.pkg.size, days: line.daysLeft });
      })() : t("coach.email.packageNone");
  const vars = { coach: n.coach.displayName, when, where, package: pkg };
  const url = `${baseUrl()}/c/${n.coach.handle}`;
  const isCancel = method === "CANCEL";
  const { html, text } = layout({
    heading: t(isCancel ? "coach.email.cancelHeading" : "coach.email.inviteHeading"),
    body: t(isCancel ? "coach.email.cancelBody" : "coach.email.inviteBody", vars),
    cta: { label: t("coach.email.open"), url },
    footer: t("email.footer", { app: APP_NAME }),
    eventUrl: url,
    openLabel: t("coach.email.open"),
  });
  const title = `${t("coach.page.coach")} · ${n.coach.displayName}`;
  await sendEmail({
    to: n.student.email,
    subject: t(isCancel ? "coach.email.cancelSubject" : "coach.email.inviteSubject", vars),
    html,
    text,
    ics: { method, content: lessonIcs({ lesson: n.lesson, coach: n.coach, student: n.student, title, method }) },
  });
}
