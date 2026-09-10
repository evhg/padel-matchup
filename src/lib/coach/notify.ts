import type { Db } from "@/db";
import type { Coach, Lesson, LessonPackage, Player } from "@/db/schema";
import { APP_NAME, baseUrl, emailEnabled, emailFrom, shortHost } from "@/lib/config";
import { icsStamp } from "@/lib/dates";
import { getPlayerById, packageLine, type CancelOutcome } from "@/lib/domain/coaching";
import { sendEmail } from "@/lib/email/send";
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

const dm = async (chatId: number, text: string, keyboard?: { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] }) => {
  if (!telegramEnabled()) return;
  await sendMessage(chatId, esc(text), { silent: true, keyboard: keyboard ?? null }).catch(() => undefined);
};

const outcomeText = (s: CoachBotStrings, outcome: CancelOutcome) => (outcome === "free_pass" ? s.outcomeFreePass : outcome === "counted" ? s.outcomeCounted : outcome === "refunded" ? s.outcomeRefunded : s.outcomeNone);

export async function notifyLessonBooked(db: Db, n: LessonNotice): Promise<void> {
  const coachPlayer = await getPlayerById(db, n.coach.playerId);
  if (n.by === "coach" && n.student.telegramId) {
    const s = coachStrings(coachBotLocale(n.student.locale));
    await dm(n.student.telegramId, s.coachBooked(n.coach.displayName, whenLabel(n.lesson.startsAt, n.coach.tz, n.student.locale), pkgText(s, n.pkg)), { inline_keyboard: [[{ text: s.cancel, callback_data: `lc:${n.lesson.id}` }]] });
  }
  if (n.by === "student" && coachPlayer?.telegramId) {
    const s = coachStrings(coachBotLocale(coachPlayer.locale));
    await dm(coachPlayer.telegramId, s.studentBooked(n.student.displayName, whenLabel(n.lesson.startsAt, n.coach.tz, coachPlayer.locale), pkgText(s, n.pkg)));
  }
  await emailLesson(n, "REQUEST").catch(() => undefined);
}

export async function notifyLessonCancelled(db: Db, n: LessonNotice & { outcome: CancelOutcome }): Promise<void> {
  const coachPlayer = await getPlayerById(db, n.coach.playerId);
  if (n.by === "coach" && n.student.telegramId) {
    const s = coachStrings(coachBotLocale(n.student.locale));
    const alts = n.alternatives ?? [];
    const text = s.coachCancelled(n.coach.displayName, whenLabel(n.lesson.startsAt, n.coach.tz, n.student.locale)) + (alts.length ? `\n${s.altTimes}` : "");
    const keyboard = alts.length ? { inline_keyboard: [alts.map((d) => ({ text: whenLabel(d, n.coach.tz, n.student.locale), callback_data: `lb:${n.coach.id}:${epochMin(d)}` }))] } : undefined;
    await dm(n.student.telegramId, text, keyboard);
  }
  if (n.by === "student" && coachPlayer?.telegramId) {
    const s = coachStrings(coachBotLocale(coachPlayer.locale));
    await dm(coachPlayer.telegramId, s.studentCancelled(n.student.displayName, whenLabel(n.lesson.startsAt, n.coach.tz, coachPlayer.locale), outcomeText(s, n.outcome)));
  }
  await emailLesson(n, "CANCEL").catch(() => undefined);
}

/** A student came in through the coach's own link: one quiet line, no button, nothing to decide. */
export async function notifyStudentJoined(db: Db, coach: Coach, student: Player): Promise<void> {
  const coachPlayer = await getPlayerById(db, coach.playerId);
  if (!coachPlayer?.telegramId) return;
  const s = coachStrings(coachBotLocale(coachPlayer.locale));
  await dm(coachPlayer.telegramId, s.studentJoined(student.displayName));
}

export async function notifyStudentRequest(db: Db, coach: Coach, student: Player): Promise<void> {
  const coachPlayer = await getPlayerById(db, coach.playerId);
  if (!coachPlayer?.telegramId) return;
  const s = coachStrings(coachBotLocale(coachPlayer.locale));
  await dm(coachPlayer.telegramId, s.studentAsked(student.displayName), { inline_keyboard: [[{ text: s.accept, callback_data: `cs:${student.id}` }]] });
}

/** A student the coach added by hand, with an email: one note with the coach's link, nothing else. */
export async function notifyStudentInvited(coach: Coach, student: Player): Promise<void> {
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

export async function notifyStudentAccepted(coach: Coach, student: Player): Promise<void> {
  if (!student.telegramId) return;
  const s = coachStrings(coachBotLocale(student.locale));
  await dm(student.telegramId, s.youWereAccepted(coach.displayName), { inline_keyboard: [[{ text: s.open, url: `${baseUrl()}/c/${coach.handle}` }]] });
}

/** A freed slot offered to the first in line: one message with a button, thirty minutes on the clock. */
export async function notifyOffer(db: Db, coach: Coach, offer: Offer): Promise<void> {
  const student = offer.player;
  const when = whenLabel(offer.startsAt, coach.tz, student.locale);
  if (student.telegramId) {
    const s = coachStrings(coachBotLocale(student.locale));
    await dm(student.telegramId, s.offer(coach.displayName, when, OFFER_MINUTES), { inline_keyboard: [[{ text: s.offerTake, callback_data: `lo:${offer.entry.id}` }, { text: s.offerNo, callback_data: `lw:${offer.entry.id}` }]] });
    return;
  }
  if (!emailEnabled() || !student.email) return;
  const { t } = await translatorFor(student.locale);
  const url = `${baseUrl()}/c/${coach.handle}`;
  const vars = { coach: coach.displayName, when, minutes: OFFER_MINUTES };
  const { html, text } = layout({ heading: t("coach.email.offerHeading", vars), body: t("coach.email.offerBody", vars), cta: { label: t("coach.email.offerCta"), url }, footer: t("email.footer", { app: APP_NAME }), eventUrl: url, openLabel: t("coach.email.offerCta") });
  await sendEmail({ to: student.email, subject: t("coach.email.offerSubject", vars), html, text });
}

export async function notifyOfferLapsed(coach: Coach, student: Player, startsAt: Date): Promise<void> {
  if (!student.telegramId) return;
  const s = coachStrings(coachBotLocale(student.locale));
  await dm(student.telegramId, s.offerLapsed(whenLabel(startsAt, coach.tz, student.locale)));
}

/** A time outside the hours: the coach gets one yes/no. Telegram when they have it, email otherwise. */
export async function notifyRequest(db: Db, coach: Coach, student: Player, request: LessonRequest): Promise<void> {
  const coachPlayer = await getPlayerById(db, coach.playerId);
  if (!coachPlayer) return;
  const when = whenLabel(request.startsAt, coach.tz, coachPlayer.locale);
  if (coachPlayer.telegramId) {
    const s = coachStrings(coachBotLocale(coachPlayer.locale));
    await dm(coachPlayer.telegramId, s.requestAsk(student.displayName, when) + (request.note ? `\n“${request.note}”` : ""), { inline_keyboard: [[{ text: `✓ ${s.requestYes}`, callback_data: `rq:${request.id}:y` }, { text: `✕ ${s.requestNo}`, callback_data: `rq:${request.id}:n` }]] });
    return;
  }
  if (!emailEnabled() || !coachPlayer.email) return;
  const { t } = await translatorFor(coachPlayer.locale);
  const url = `${baseUrl()}/coach`;
  const vars = { student: student.displayName, when };
  const { html, text } = layout({ heading: t("coach.email.requestHeading", vars), body: t("coach.email.requestBody", vars), cta: { label: t("coach.email.requestCta"), url }, footer: t("email.footer", { app: APP_NAME }), eventUrl: url, openLabel: t("coach.email.requestCta") });
  await sendEmail({ to: coachPlayer.email, subject: t("coach.email.requestSubject", vars), html, text });
}

export async function notifyRequestDecided(db: Db, n: { coach: Coach; student: Player; request: LessonRequest; lesson: Lesson | null; pkg: LessonPackage | null }): Promise<void> {
  const { coach, student, request, lesson } = n;
  const when = whenLabel(request.startsAt, coach.tz, student.locale);
  if (student.telegramId) {
    const s = coachStrings(coachBotLocale(student.locale));
    if (lesson) await dm(student.telegramId, s.requestAccepted(coach.displayName, when, pkgText(s, n.pkg)), { inline_keyboard: [[{ text: s.cancel, callback_data: `lc:${lesson.id}` }]] });
    else await dm(student.telegramId, s.requestDeclined(coach.displayName, when), { inline_keyboard: [[{ text: s.open, url: `${baseUrl()}/c/${coach.handle}` }]] });
  }
  if (lesson) await emailLesson({ lesson, coach, student, pkg: n.pkg, by: "coach" }, "REQUEST").catch(() => undefined);
  else if (emailEnabled() && student.email) {
    const { t } = await translatorFor(student.locale);
    const url = `${baseUrl()}/c/${coach.handle}`;
    const vars = { coach: coach.displayName, when };
    const { html, text } = layout({ heading: t("coach.email.declinedHeading", vars), body: t("coach.email.declinedBody", vars), cta: { label: t("coach.email.open"), url }, footer: t("email.footer", { app: APP_NAME }), eventUrl: url, openLabel: t("coach.email.open") });
    await sendEmail({ to: student.email, subject: t("coach.email.declinedSubject", vars), html, text }).catch(() => undefined);
  }
}

/** The evening-before reminder: one line, a cancel button, nothing else. */
export async function notifyLessonReminder(n: { lesson: Lesson; coach: Coach; student: Player; pkg: LessonPackage | null }): Promise<void> {
  const when = whenLabel(n.lesson.startsAt, n.coach.tz, n.student.locale);
  if (n.student.telegramId) {
    const s = coachStrings(coachBotLocale(n.student.locale));
    await dm(n.student.telegramId, s.reminder(n.coach.displayName, when, pkgText(s, n.pkg)), { inline_keyboard: [[{ text: s.cancel, callback_data: `lc:${n.lesson.id}` }]] });
    return;
  }
  if (!emailEnabled() || !n.student.email) return;
  const { t } = await translatorFor(n.student.locale);
  const url = `${baseUrl()}/c/${n.coach.handle}`;
  const vars = { coach: n.coach.displayName, when };
  const { html, text } = layout({ heading: t("coach.email.reminderHeading", vars), body: t("coach.email.reminderBody", vars), cta: { label: t("coach.email.open"), url }, footer: t("email.footer", { app: APP_NAME }), eventUrl: url, openLabel: t("coach.email.open") });
  await sendEmail({ to: n.student.email, subject: t("coach.email.reminderSubject", vars), html, text });
}

/** Nearly out, or nearly expired: one note to the student, which is also the rebooking nudge. */
export async function notifyLowPackage(n: { pkg: LessonPackage; coach: Coach; student: Player; left: number; daysLeft: number | null }): Promise<void> {
  if (n.student.telegramId) {
    const s = coachStrings(coachBotLocale(n.student.locale));
    await dm(n.student.telegramId, s.lowPackage(n.coach.displayName, s.pkgLine(n.left, n.pkg.size, n.daysLeft)), { inline_keyboard: [[{ text: s.open, url: `${baseUrl()}/c/${n.coach.handle}` }]] });
    return;
  }
  if (!emailEnabled() || !n.student.email) return;
  const { t } = await translatorFor(n.student.locale);
  const url = `${baseUrl()}/c/${n.coach.handle}`;
  const line = n.daysLeft === null ? t("coach.packageLineNoExpiry", { left: n.left, size: n.pkg.size }) : t("coach.packageLine", { left: n.left, size: n.pkg.size, days: n.daysLeft });
  const vars = { coach: n.coach.displayName, line };
  const { html, text } = layout({ heading: t("coach.email.lowHeading", vars), body: t("coach.email.lowBody", vars), cta: { label: t("coach.email.open"), url }, footer: t("email.footer", { app: APP_NAME }), eventUrl: url, openLabel: t("coach.email.open") });
  await sendEmail({ to: n.student.email, subject: t("coach.email.lowSubject", vars), html, text });
}

export async function notifyManagerJoined(db: Db, coach: Coach, manager: Player): Promise<void> {
  const coachPlayer = await getPlayerById(db, coach.playerId);
  if (!coachPlayer?.telegramId) return;
  const s = coachStrings(coachBotLocale(coachPlayer.locale));
  await dm(coachPlayer.telegramId, s.managerJoined(manager.displayName));
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
