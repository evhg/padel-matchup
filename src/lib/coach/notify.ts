import type { Db } from "@/db";
import type { Coach, Lesson, LessonPackage, Player } from "@/db/schema";
import { APP_NAME, baseUrl, emailEnabled, emailFrom, shortHost } from "@/lib/config";
import { icsStamp } from "@/lib/dates";
import { getPlayerById, packageLine, type CancelOutcome } from "@/lib/domain/coaching";
import { sendEmail } from "@/lib/email/send";
import { layout, translatorFor } from "@/lib/email/templates";
import { esc, sendMessage, telegramEnabled } from "@/lib/telegram/api";
import { coachBotLocale, coachStrings, whenLabel, type CoachBotStrings } from "./strings";

/**
 * What leaves the book when something changes: one quiet line to the other side,
 * and a calendar invitation by email when there is an address. The coach hears
 * about students' moves; students hear about the coach's. Nobody is pestered twice.
 */

export type LessonNotice = { lesson: Lesson; coach: Coach; student: Player; pkg: LessonPackage | null; by: "coach" | "student" };

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
    await dm(n.student.telegramId, s.coachCancelled(n.coach.displayName, whenLabel(n.lesson.startsAt, n.coach.tz, n.student.locale)));
  }
  if (n.by === "student" && coachPlayer?.telegramId) {
    const s = coachStrings(coachBotLocale(coachPlayer.locale));
    await dm(coachPlayer.telegramId, s.studentCancelled(n.student.displayName, whenLabel(n.lesson.startsAt, n.coach.tz, coachPlayer.locale), outcomeText(s, n.outcome)));
  }
  await emailLesson(n, "CANCEL").catch(() => undefined);
}

export async function notifyStudentRequest(db: Db, coach: Coach, student: Player): Promise<void> {
  const coachPlayer = await getPlayerById(db, coach.playerId);
  if (!coachPlayer?.telegramId) return;
  const s = coachStrings(coachBotLocale(coachPlayer.locale));
  await dm(coachPlayer.telegramId, s.studentAsked(student.displayName), { inline_keyboard: [[{ text: s.accept, callback_data: `cs:${student.id}` }]] });
}

export async function notifyStudentAccepted(coach: Coach, student: Player): Promise<void> {
  if (!student.telegramId) return;
  const s = coachStrings(coachBotLocale(student.locale));
  await dm(student.telegramId, s.youWereAccepted(coach.displayName), { inline_keyboard: [[{ text: s.open, url: `${baseUrl()}/c/${coach.handle}` }]] });
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
