import type { Db } from "@/db";
import type { Coach, Lesson, LessonPackage, Player } from "@/db/schema";
import { APP_NAME, baseUrl, emailEnabled, emailFrom, shortHost } from "@/lib/config";
import { icsStamp } from "@/lib/dates";
import { getPlayerById, packageLine, type CancelOutcome } from "@/lib/domain/coaching";
import { sendEmail } from "@/lib/email/send";
import { pushEnabled, sendPush } from "@/lib/push";
import { removePushSubscription, subscriptionsFor } from "@/lib/domain/push";
import { layout, telegramLine, translatorFor } from "@/lib/email/templates";
import { esc, sendMessage, telegramEnabled } from "@/lib/telegram/api";
import { sendWaTemplate, whatsappNotices, type WaTemplateName } from "@/lib/whatsapp/templates";
import { epochMin, OFFER_MINUTES, type Offer } from "./chains";
import { coachBotLocale, coachStrings, whenLabel, type CoachBotStrings } from "./strings";
import type { LessonRequest } from "@/db/schema";
import { recordNotice, type NoticeInput } from "@/lib/domain/notices";
import type { Receipt, Release } from "@/lib/domain/noticeKinds";

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
 *
 * WhatsApp comes second, and only where the caller says it may (`configured.whatsapp`): outside a
 * conversation it carries nothing but a template Meta approved, so only a notice that has one can go
 * there. A caller that does not name WhatsApp gets exactly the order it always had.
 */
export function channelFor(
  p: (Pick<Player, "telegramId" | "email" | "emailNotifications"> & { phone?: string | null }) | null | undefined,
  configured: { telegram: boolean; whatsapp?: boolean; email: boolean; push: boolean },
): "telegram" | "whatsapp" | "email" | "push" | "none" {
  if (!p) return "none";
  if (configured.telegram && p.telegramId) return "telegram";
  // `players.phone` is written only by the WhatsApp thread, so a number here is one that wrote to us.
  if (configured.whatsapp && p.phone) return "whatsapp";
  if (configured.email && p.email && p.emailNotifications) return "email";
  return configured.push ? "push" : "none";
}

/** A notice as a WhatsApp template: its name, the body's variables, and a match code for its button (never a personal link). */
export type WaNotice = { template: WaTemplateName; body: string[]; button?: string; quickReply?: string; image?: string };

/**
 * Which notice this is, and so whether it may go (`src/lib/domain/notices.ts`). Required, so a new
 * caller cannot skip the gate by forgetting it:
 * - the notice itself (its sender and what it is about): `tell()` writes the inbox row and asks the gate;
 * - `released`: the caller wrote the rows for a whole fan-out in one insert and passes each answer on;
 * - `receipt`: not a notice but the answer to the person's own request (`RECEIPTS`), never held.
 */
export type TellNotice = Omit<NoticeInput, "playerId"> | { released: Release } | { receipt: Receipt };

async function releaseFor(db: Db, p: Player, n: TellNotice): Promise<Release> {
  if ("released" in n) return n.released;
  if ("receipt" in n) return "now";
  return recordNotice(db, { ...n, playerId: p.id });
}

export async function tell(db: Db, p: Player | null | undefined, text: string, keyboard: Keyboard | undefined, o: { notice: TellNotice; /** A last line for Telegram only, the way a reply to this message is recognised ("↳ ks:…"); email and push never carry it. */ trailer?: string; /** The email's button, when "Open the match" is not what its link does. */ label?: string; /** The notice as a WhatsApp template. Without it WhatsApp is never tried: a coach's notices have no template. */ whatsapp?: WaNotice }): Promise<Release> {
  if (!p) return "off";
  const release = await releaseFor(db, p, o.notice);
  if (release !== "now") return release;
  let via = channelFor(p, { telegram: telegramEnabled(), whatsapp: Boolean(o.whatsapp) && whatsappNotices(), email: emailEnabled(), push: pushEnabled() });
  if (via === "none") return release;
  if (via === "telegram" && p.telegramId) {
    await sendMessage(p.telegramId, esc(text) + (o.trailer ? `\n${esc(o.trailer)}` : ""), { silent: true, keyboard: keyboard ?? null }).catch(() => undefined);
    return release;
  }
  if (via === "whatsapp" && p.phone && o.whatsapp) {
    const w = o.whatsapp;
    const sent = await sendWaTemplate(db, p.phone, w.template, p.locale, { body: w.body, button: w.button, quickReply: w.quickReply, image: w.image });
    if (sent.ok) return release;
    // Not sent: the day's cap, a template Meta has not approved yet, or an error. The notice goes on
    // to email, then push, exactly as it would have gone without WhatsApp.
    via = channelFor(p, { telegram: false, whatsapp: false, email: emailEnabled(), push: pushEnabled() });
    if (via === "none") return release;
  }
  // The link a button would have opened, so the fallback is not a dead end.
  const url = keyboard?.inline_keyboard.flat().find((b) => b.url)?.url ?? `${baseUrl()}/coach`;
  if (via === "email" && p.email) {
    const { t } = await translatorFor(p.locale);
    const [heading, ...rest] = text.split("\n");
    const { html, text: plain } = layout({ heading, body: rest.join("\n") || heading, footer: t("email.footer", { app: APP_NAME }), eventUrl: url, openLabel: t("email.openMatch"), cta: { label: o.label ?? t("email.openMatch"), url }, telegram: telegramLine(t("email.telegramLine"), p) });
    await sendEmail({ to: p.email, subject: heading, html, text: plain }).catch(() => undefined);
    return release;
  }
  // Last resort: the coach is a player, and a player may have turned push on.
  const [title, ...rest] = text.split("\n");
  for (const sub of await subscriptionsFor(db, [p.id])) {
    const r = await sendPush(sub, { title, body: rest.join(" ").slice(0, 140) || title, url }).catch(() => "failed" as const);
    if (r === "gone") await removePushSubscription(db, sub.endpoint).catch(() => undefined);
  }
  return release;
}

/** A lesson as a notice row keeps: the hour and the coach's zone, and the other person's name. Never a link. */
const lessonAt = (at: Date, coach: Coach, name: string) => ({ at: at.toISOString(), tz: coach.tz, name });

const outcomeText = (s: CoachBotStrings, outcome: CancelOutcome) => (outcome === "free_pass" ? s.outcomeFreePass : outcome === "counted" ? s.outcomeCounted : outcome === "refunded" ? s.outcomeRefunded : s.outcomeNone);

/**
 * The calendar file goes with the notice. The side that acted gets theirs always: it is their own
 * booking. The side that was told gets it only when the gate released the notice, so a person who
 * switched lessons off, or is inside quiet hours, is not mailed by the back door.
 */
const filed = (actedBy: "coach" | "student", side: "coach" | "student", told: Release) => actedBy === side || told === "now";

export async function notifyLessonBooked(db: Db, n: LessonNotice): Promise<void> {
  const coachPlayer = await getPlayerById(db, n.coach.playerId);
  let student: Release = "off";
  let coach: Release = "off";
  if (n.by === "coach") {
    const s = coachStrings(coachBotLocale(n.student.locale));
    student = await tell(db, n.student, s.coachBooked(n.coach.displayName, whenLabel(n.lesson.startsAt, n.coach.tz, n.student.locale), pkgText(s, n.pkg)), { inline_keyboard: [[{ text: s.cancel, callback_data: `lc:${n.lesson.id}` }]] }, { notice: { sender: "lessonBooked", startsAt: n.lesson.startsAt, tz: n.coach.tz, params: lessonAt(n.lesson.startsAt, n.coach, n.coach.displayName) } });
  }
  if (n.by === "student" && coachPlayer) {
    const s = coachStrings(coachBotLocale(coachPlayer.locale));
    coach = await tell(db, coachPlayer, s.studentBooked(n.student.displayName, whenLabel(n.lesson.startsAt, n.coach.tz, coachPlayer.locale), pkgText(s, n.pkg)), undefined, { notice: { sender: "lessonBooked", startsAt: n.lesson.startsAt, tz: n.coach.tz, params: lessonAt(n.lesson.startsAt, n.coach, n.student.displayName) } });
  }
  if (filed(n.by, "student", student)) await emailLesson(n, "REQUEST").catch(() => undefined);
  if (filed(n.by, "coach", coach)) await emailLessonToCoach(coachPlayer, n, "REQUEST").catch(() => undefined);
}

export async function notifyLessonCancelled(db: Db, n: LessonNotice & { outcome: CancelOutcome }): Promise<void> {
  const coachPlayer = await getPlayerById(db, n.coach.playerId);
  let student: Release = "off";
  let coach: Release = "off";
  if (n.by === "coach") {
    const s = coachStrings(coachBotLocale(n.student.locale));
    const alts = n.alternatives ?? [];
    const text = s.coachCancelled(n.coach.displayName, whenLabel(n.lesson.startsAt, n.coach.tz, n.student.locale)) + (alts.length ? `\n${s.altTimes}` : "");
    const keyboard = alts.length ? { inline_keyboard: [alts.map((d) => ({ text: whenLabel(d, n.coach.tz, n.student.locale), callback_data: `lb:${n.coach.id}:${epochMin(d)}` }))] } : undefined;
    student = await tell(db, n.student, text, keyboard, { notice: { sender: "lessonCancelled", startsAt: n.lesson.startsAt, tz: n.coach.tz, params: lessonAt(n.lesson.startsAt, n.coach, n.coach.displayName) } });
  }
  if (n.by === "student" && coachPlayer) {
    const s = coachStrings(coachBotLocale(coachPlayer.locale));
    coach = await tell(db, coachPlayer, s.studentCancelled(n.student.displayName, whenLabel(n.lesson.startsAt, n.coach.tz, coachPlayer.locale), outcomeText(s, n.outcome)), undefined, { notice: { sender: "lessonCancelled", startsAt: n.lesson.startsAt, tz: n.coach.tz, params: lessonAt(n.lesson.startsAt, n.coach, n.student.displayName) } });
  }
  if (filed(n.by, "student", student)) await emailLesson(n, "CANCEL").catch(() => undefined);
  if (filed(n.by, "coach", coach)) await emailLessonToCoach(coachPlayer, n, "CANCEL").catch(() => undefined);
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
  const release = await tell(db, told, n.by === "student" ? s.studentMoved(n.student.displayName, fromWhen, toWhen) : s.coachMoved(n.coach.displayName, fromWhen, toWhen), undefined, { notice: { sender: "lessonMoved", startsAt: n.to.startsAt, tz: n.coach.tz, params: lessonAt(n.to.startsAt, n.coach, n.by === "student" ? n.student.displayName : n.coach.displayName) } });
  // The student's calendar entry moves with it: one REQUEST at the new hour replaces the old.
  if (filed(n.by, "student", release)) await emailLesson({ lesson: n.to, coach: n.coach, student: n.student, pkg: null, by: n.by }, "REQUEST").catch(() => undefined);
  // The move lands in the coach's calendar too: same UID, new hour, so the old entry is replaced.
  if (filed(n.by, "coach", release)) await emailLessonToCoach(coachPlayer, { lesson: n.to, coach: n.coach, student: n.student, pkg: null, by: n.by }, "REQUEST").catch(() => undefined);
}

/** A student says the money is sent. The coach hears it and taps once; nothing else changes state. */
export async function notifyPaidClaimed(db: Db, n: { coach: Coach; student: Player; lesson: Lesson }): Promise<void> {
  const coachPlayer = await getPlayerById(db, n.coach.playerId);
  if (!coachPlayer) return;
  const when = whenLabel(n.lesson.startsAt, n.coach.tz, coachPlayer.locale);
  const amount = n.lesson.amount ? `${n.lesson.amount} ${n.coach.currency}` : "";
  const s = coachStrings(coachBotLocale(coachPlayer.locale));
  await tell(db, coachPlayer, s.paidClaimed(n.student.displayName, when, amount), undefined, { notice: { sender: "paidClaimed", startsAt: n.lesson.startsAt, tz: n.coach.tz, params: lessonAt(n.lesson.startsAt, n.coach, n.student.displayName) } });
}

/**
 * The other half of a claim. A student said the money was sent and heard nothing back until they
 * next opened the page, which is the kind of silence people read as "it did not work" and ask about
 * in a message — the thing the payment status exists to stop.
 */
export async function notifyPaidConfirmed(db: Db, n: { coach: Coach; student: Player; lesson: Lesson }): Promise<void> {
  const when = whenLabel(n.lesson.startsAt, n.coach.tz, n.student.locale);
  const s = coachStrings(coachBotLocale(n.student.locale));
  await tell(db, n.student, s.paidConfirmed(n.coach.displayName, when), undefined, { notice: { sender: "paidConfirmed", startsAt: n.lesson.startsAt, tz: n.coach.tz, params: lessonAt(n.lesson.startsAt, n.coach, n.coach.displayName) } });
}

/** A student came in through the coach's own link: one quiet line, no button, nothing to decide. */
export async function notifyStudentJoined(db: Db, coach: Coach, student: Player): Promise<void> {
  const coachPlayer = await getPlayerById(db, coach.playerId);
  if (!coachPlayer) return;
  const s = coachStrings(coachBotLocale(coachPlayer.locale));
  await tell(db, coachPlayer, s.studentJoined(student.displayName), undefined, { notice: { sender: "studentJoined", params: { name: student.displayName } } });
}

/** A student took a package from the page. Unpaid until the coach says so; this is what asks them to look. */
export async function notifyPackageTaken(db: Db, n: { coach: Coach; student: Player; pkg: LessonPackage }): Promise<void> {
  const coachPlayer = await getPlayerById(db, n.coach.playerId);
  if (!coachPlayer) return;
  const s = coachStrings(coachBotLocale(coachPlayer.locale));
  await tell(db, coachPlayer, s.packageTaken(n.student.displayName, n.pkg.size, n.pkg.amount != null ? `${n.pkg.amount} ${n.pkg.currency}` : ""), { inline_keyboard: [[{ text: s.open, url: `${baseUrl()}/coach/students#s-${n.student.id}` }]] }, { notice: { sender: "packageTaken", params: { name: n.student.displayName, count: n.pkg.size } } });
}

export async function notifyStudentRequest(db: Db, coach: Coach, student: Player): Promise<void> {
  const coachPlayer = await getPlayerById(db, coach.playerId);
  if (!coachPlayer) return;
  const s = coachStrings(coachBotLocale(coachPlayer.locale));
  await tell(db, coachPlayer, s.studentAsked(student.displayName), { inline_keyboard: [[{ text: s.accept, callback_data: `cs:${student.id}` }]] }, { notice: { sender: "studentAsked", params: { name: student.displayName } } });
}

/** A student the coach added by hand, with an email: one note with the coach's link, nothing else. */
export async function notifyStudentInvited(db: Db, coach: Coach, student: Player): Promise<void> {
  if ((await recordNotice(db, { playerId: student.id, sender: "studentInvited", params: { name: coach.displayName } })) !== "now") return;
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
    telegram: telegramLine(t("email.telegramLine"), student),
  });
  await sendEmail({ to: student.email, subject: t("coach.email.invitedSubject", vars), html, text });
}

export async function notifyStudentAccepted(db: Db, coach: Coach, student: Player): Promise<void> {
  const s = coachStrings(coachBotLocale(student.locale));
  await tell(db, student, s.youWereAccepted(coach.displayName), { inline_keyboard: [[{ text: s.open, url: `${baseUrl()}/c/${coach.handle}` }]] }, { notice: { sender: "studentAccepted", params: { name: coach.displayName } } });
}

/** A freed slot offered to the first in line: one message with a button, thirty minutes on the clock. */
export async function notifyOffer(db: Db, coach: Coach, offer: Offer): Promise<void> {
  const student = offer.player;
  const when = whenLabel(offer.startsAt, coach.tz, student.locale);
  const s = coachStrings(coachBotLocale(student.locale));
  await tell(db, student, s.offer(coach.displayName, when, OFFER_MINUTES), { inline_keyboard: [[{ text: s.offerTake, callback_data: `lo:${offer.entry.id}` }, { text: s.offerNo, callback_data: `lw:${offer.entry.id}` }]] }, { notice: { sender: "lessonOffer", startsAt: offer.startsAt, tz: coach.tz, params: lessonAt(offer.startsAt, coach, coach.displayName) } });
}

export async function notifyOfferLapsed(db: Db, coach: Coach, student: Player, startsAt: Date): Promise<void> {
  const s = coachStrings(coachBotLocale(student.locale));
  await tell(db, student, s.offerLapsed(whenLabel(startsAt, coach.tz, student.locale)), undefined, { notice: { sender: "offerLapsed", startsAt: startsAt, tz: coach.tz, params: lessonAt(startsAt, coach, coach.displayName) } });
}

/** A time outside the hours: the coach gets one yes/no. Telegram when they have it, email otherwise. */
export async function notifyRequest(db: Db, coach: Coach, student: Player, request: LessonRequest): Promise<void> {
  const coachPlayer = await getPlayerById(db, coach.playerId);
  if (!coachPlayer) return;
  const when = whenLabel(request.startsAt, coach.tz, coachPlayer.locale);
  const s = coachStrings(coachBotLocale(coachPlayer.locale));
  await tell(db, coachPlayer, s.requestAsk(student.displayName, when) + (request.note ? `\n“${request.note}”` : ""), { inline_keyboard: [[{ text: `✓ ${s.requestYes}`, callback_data: `rq:${request.id}:y` }, { text: `✕ ${s.requestNo}`, callback_data: `rq:${request.id}:n` }]] }, { notice: { sender: "lessonRequest", startsAt: request.startsAt, tz: coach.tz, params: lessonAt(request.startsAt, coach, student.displayName) } });
}

export async function notifyRequestDecided(db: Db, n: { coach: Coach; student: Player; request: LessonRequest; lesson: Lesson | null; pkg: LessonPackage | null }): Promise<void> {
  const { coach, student, request, lesson } = n;
  const coachPlayer = await getPlayerById(db, coach.playerId);
  const when = whenLabel(request.startsAt, coach.tz, student.locale);
  const s = coachStrings(coachBotLocale(student.locale));
  const params = lessonAt(request.startsAt, coach, coach.displayName);
  const about = { startsAt: request.startsAt, tz: coach.tz };
  const release = lesson
    ? await tell(db, student, s.requestAccepted(coach.displayName, when, pkgText(s, n.pkg)), { inline_keyboard: [[{ text: s.cancel, callback_data: `lc:${lesson.id}` }]] }, { notice: { sender: "lessonRequestAccepted", ...about, params } })
    : await tell(db, student, s.requestDeclined(coach.displayName, when), { inline_keyboard: [[{ text: s.open, url: `${baseUrl()}/c/${coach.handle}` }]] }, { notice: { sender: "lessonRequestDeclined", ...about, params } });
  // The calendar entry only exists when the answer was yes; a no is carried by tell() like any notice.
  if (lesson && release === "now") await emailLesson({ lesson, coach, student, pkg: n.pkg, by: "coach" }, "REQUEST").catch(() => undefined);
  // The coach said yes to an hour outside their own template, so their calendar is exactly where it needs to land.
  if (lesson) await emailLessonToCoach(coachPlayer, { lesson, coach, student, pkg: n.pkg, by: "coach" }, "REQUEST").catch(() => undefined);
}

/** The evening-before reminder: one line, a cancel button, nothing else. */
export async function notifyLessonReminder(db: Db, n: { lesson: Lesson; coach: Coach; student: Player; pkg: LessonPackage | null }): Promise<void> {
  const when = whenLabel(n.lesson.startsAt, n.coach.tz, n.student.locale);
  const s = coachStrings(coachBotLocale(n.student.locale));
  await tell(db, n.student, s.reminder(n.coach.displayName, when, pkgText(s, n.pkg)), { inline_keyboard: [[{ text: s.cancel, callback_data: `lc:${n.lesson.id}` }]] }, { notice: { sender: "lessonReminder", startsAt: n.lesson.startsAt, tz: n.coach.tz, params: lessonAt(n.lesson.startsAt, n.coach, n.coach.displayName) } });
}

/** Nearly out, or nearly expired: one note to the student, which is also the rebooking nudge. */
export async function notifyLowPackage(db: Db, n: { pkg: LessonPackage; coach: Coach; student: Player; left: number; daysLeft: number | null }): Promise<void> {
  const s = coachStrings(coachBotLocale(n.student.locale));
  await tell(db, n.student, s.lowPackage(n.coach.displayName, s.pkgLine(n.left, n.pkg.size, n.daysLeft)), { inline_keyboard: [[{ text: s.open, url: `${baseUrl()}/c/${n.coach.handle}` }]] }, { notice: { sender: "lowPackage", params: { name: n.coach.displayName, count: n.left } } });
}

export async function notifyManagerJoined(db: Db, coach: Coach, manager: Player): Promise<void> {
  const coachPlayer = await getPlayerById(db, coach.playerId);
  if (!coachPlayer) return;
  const s = coachStrings(coachBotLocale(coachPlayer.locale));
  await tell(db, coachPlayer, s.managerJoined(manager.displayName), undefined, { notice: { sender: "managerJoined", params: { name: manager.displayName } } });
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
export function lessonIcs(input: { lesson: Lesson; coach: Coach; student: Player; title: string; method: "REQUEST" | "CANCEL"; /** The coach's own address, on the copy that goes to them. */ coachEmail?: string | null }): string {
  const { lesson, coach, student, title, method, coachEmail } = input;
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
    ...(coachEmail ? [`ATTENDEE;CN=${icsEscape(coach.displayName)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${coachEmail}`] : []),
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

/**
 * The same lesson, in the coach's own calendar.
 *
 * The student has had a calendar invitation since the book existed. The coach never got one, so a
 * lesson lived only on a screen they had to remember to open. The other way in is Google Calendar,
 * and it needs the coach to share a calendar with a service account — which the Google Calendar phone
 * apps cannot do at all. A calendar object in an email can, with one tap, on any phone and into any
 * calendar; a CANCEL takes it out again.
 *
 * The activity-email switch is not consulted, the same way the student's copy does not consult it: a
 * lesson somebody booked is not activity mail.
 */
async function emailLessonToCoach(coachPlayer: Player | null | undefined, n: LessonNotice, method: "REQUEST" | "CANCEL"): Promise<void> {
  if (!emailEnabled() || !coachPlayer?.email) return;
  const { t, locale } = await translatorFor(coachPlayer.locale);
  const when = whenLabel(n.lesson.startsAt, n.coach.tz, locale);
  const where = n.coach.clubNames.length ? ` \u00b7 ${n.coach.clubNames.join(", ")}` : "";
  const pkg = n.pkg
    ? (() => {
        const line = packageLine(n.pkg, new Date());
        return line.daysLeft === null ? t("coach.packageLineNoExpiry", { left: line.left, size: n.pkg.size }) : t("coach.packageLine", { left: line.left, size: n.pkg.size, days: line.daysLeft });
      })()
    : t("coach.email.packageNone");
  const vars = { student: n.student.displayName, when, where, package: pkg };
  const url = `${baseUrl()}/coach`;
  const isCancel = method === "CANCEL";
  const { html, text } = layout({
    heading: t(isCancel ? "coach.email.coachCancelHeading" : "coach.email.coachInviteHeading"),
    body: t(isCancel ? "coach.email.coachCancelBody" : "coach.email.coachInviteBody", vars),
    cta: { label: t("coach.email.requestCta"), url },
    footer: t("email.footer", { app: APP_NAME }),
    eventUrl: url,
    openLabel: t("coach.email.requestCta"),
  });
  const title = `${n.student.displayName}${where}`;
  await sendEmail({
    to: coachPlayer.email,
    subject: t(isCancel ? "coach.email.coachCancelSubject" : "coach.email.coachInviteSubject", vars),
    html,
    text,
    ics: { method, content: lessonIcs({ lesson: n.lesson, coach: n.coach, student: n.student, title, method, coachEmail: coachPlayer.email }) },
  });
}
