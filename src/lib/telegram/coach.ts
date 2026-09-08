import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { lessonPackages, type Coach, type Player } from "@/db/schema";
import { parseCoachLine, parseStudentLine, type CoachIntent, type Match, type StudentRef } from "@/lib/coach/assistant";
import { acceptOffer, afterLessonFreed, decideRequest, epochMin, fromEpochMin, getWaitlistEntry, withdrawWaitlist } from "@/lib/coach/chains";
import { notifyLessonBooked, notifyLessonCancelled, notifyOffer, notifyRequestDecided, notifyStudentAccepted } from "@/lib/coach/notify";
import { coachBotLocale, coachStrings, dayOnlyLabel, whenLabel, type CoachBotLocale, type CoachBotStrings } from "@/lib/coach/strings";
import { baseUrl } from "@/lib/config";
import { utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";
import {
  activePackage,
  addBlock,
  addStudentByName,
  availableSlots,
  bookLesson,
  cancelLesson,
  createPackage,
  DAY_MS,
  getCoachForActor,
  getLesson,
  getPlayerById,
  listCoachLessons,
  listStudentLessons,
  listStudents,
  lowPackages,
  packageLine,
  setPackagePaid,
  setStudentStatus,
  studentCoaches,
  studentStatus,
  type LessonWithPeople,
} from "@/lib/domain/coaching";
import { isDomainError } from "@/lib/domain/errors";
import { answerCallbackQuery, editMessageText, esc, sendMessage, sendPhoto, type InlineKeyboard, type TgMessage, type TgUpdate, type TgUser } from "./api";

/**
 * The courtside assistant. In the bot's private chat a coach types one line and the
 * book answers; a student writes a day and a time and gets a lesson, or the nearest
 * free ones as buttons. Everything the web does, without leaving the phone's chat.
 */

type Cb = NonNullable<TgUpdate["callback_query"]>;
const kb = (rows: { text: string; callback_data?: string; url?: string }[][]): InlineKeyboard => ({ inline_keyboard: rows });

const pkgText = (s: CoachBotStrings, pkg: { size: number; used: number; expiresAt: Date | null; closedAt: Date | null } | null, now = new Date()) => {
  if (!pkg) return s.noPackage;
  const line = packageLine(pkg as Parameters<typeof packageLine>[0], now);
  return s.pkgLine(line.left, pkg.size, line.daysLeft);
};

const lessonLine = (l: LessonWithPeople, coach: Coach, locale: string, s: CoachBotStrings) => `${whenLabel(l.startsAt, coach.tz, locale).split(" ").slice(-1)[0]} ${l.student?.displayName ?? "?"} · ${pkgText(s, l.package)}`;

async function studentRefs(db: Db, coachId: string): Promise<StudentRef[]> {
  return (await listStudents(db, coachId)).filter((x) => x.status !== "requested").map((x) => ({ id: x.player.id, name: x.player.displayName }));
}

// ------------------------------------------------------------------ coach flow

async function bookForCoach(db: Db, coach: Coach, coachPlayer: Player, student: StudentRef, startsAt: Date, s: CoachBotStrings, locale: string, chatId: number, extraNote?: string): Promise<string> {
  try {
    const { lesson, package: pkg } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt, byCoach: true, source: "telegram", createdByPlayerId: coachPlayer.id });
    const studentPlayer = await getPlayerById(db, student.id);
    if (studentPlayer) await notifyLessonBooked(db, { lesson, coach, student: studentPlayer, pkg, by: "coach" });
    const text = `${s.booked(student.name, whenLabel(startsAt, coach.tz, locale), pkgText(s, pkg))}${extraNote ? `\n${extraNote}` : ""}`;
    await sendMessage(chatId, esc(text), { keyboard: kb([[{ text: s.undo, callback_data: `cu:${lesson.id}` }]]), silent: true });
    return "coach:booked";
  } catch (e) {
    if (isDomainError(e) && e.code === "slot_taken") {
      const day = utcToZonedParts(startsAt, coach.tz).date;
      const from = zonedTimeToUtc(day, "00:00", coach.tz);
      const free = (await availableSlots(db, { ...coach, minNoticeHours: 0 }, from, new Date(from.getTime() + DAY_MS), new Date())).filter((d) => Math.abs(d.getTime() - startsAt.getTime()) <= 4 * 3_600_000).slice(0, 4);
      if (free.length === 0) {
        await sendMessage(chatId, esc(s.slotTakenNone), { silent: true });
        return "coach:slot_taken";
      }
      await sendMessage(chatId, esc(s.slotTaken), { keyboard: kb([free.map((d) => ({ text: whenLabel(d, coach.tz, locale).split(" ").slice(-1)[0], callback_data: `cb:${student.id}:${epochMin(d)}` }))]), silent: true });
      return "coach:slot_taken";
    }
    if (isDomainError(e) && e.code === "past") {
      await sendMessage(chatId, esc(s.past), { silent: true });
      return "coach:past";
    }
    throw e;
  }
}

async function coachFlow(db: Db, coach: Coach, coachPlayer: Player, text: string, chatId: number): Promise<string> {
  const locale: CoachBotLocale = coachBotLocale(coachPlayer.locale);
  const s = coachStrings(locale);
  const now = new Date();
  const students = await studentRefs(db, coach.id);
  const intent: CoachIntent = parseCoachLine(text, { now, tz: coach.tz, students });
  const say = (t: string, keyboard?: InlineKeyboard) => sendMessage(chatId, esc(t), { silent: true, keyboard: keyboard ?? null });

  const resolve = async (m: Match, allowNew: boolean): Promise<StudentRef | null> => {
    if (m.kind === "one") return m.student;
    if (m.kind === "many") {
      await say(s.which(m.candidates.map((c) => c.name).join(", ")));
      return null;
    }
    if (m.kind === "new" && allowNew) {
      const p = await addStudentByName(db, coach.id, m.name, locale);
      await say(s.bookedNew(p.displayName));
      return { id: p.id, name: p.displayName };
    }
    await say(s.help);
    return null;
  };

  switch (intent.kind) {
    case "help": {
      await say(s.help);
      return "coach:help";
    }
    case "low": {
      const low = await lowPackages(db, coach.id, now);
      await say(low.length === 0 ? s.lowNone : s.low(low.map((l) => `${l.player.displayName} · ${s.pkgLine(l.left, l.pkg.size, l.daysLeft)}`).join("\n")));
      return "coach:low";
    }
    case "agenda": {
      const today = utcToZonedParts(now, coach.tz).date;
      const dayStr = intent.day === "week" ? today : intent.day;
      const from = zonedTimeToUtc(dayStr, "00:00", coach.tz);
      const to = new Date(from.getTime() + (intent.day === "week" ? 7 : 1) * DAY_MS);
      const rows = (await listCoachLessons(db, coach.id, from, to)).filter((l) => l.status === "booked" || l.status === "done");
      const label = intent.day === "week" ? `${dayOnlyLabel(dayStr, locale)} → ${dayOnlyLabel(utcToZonedParts(new Date(to.getTime() - 1), coach.tz).date, locale)}` : dayOnlyLabel(dayStr, locale);
      if (rows.length === 0) await say(s.agendaEmpty(label));
      else await say(s.agenda(label, rows.map((l) => (intent.day === "week" ? `${whenLabel(l.startsAt, coach.tz, locale)} ${l.student?.displayName ?? "?"}` : lessonLine(l, coach, locale, s))).join("\n")));
      return "coach:agenda";
    }
    case "block": {
      await addBlock(db, coach.id, intent.from, intent.to, "telegram");
      const inside = (await listCoachLessons(db, coach.id, intent.from, intent.to)).filter((l) => l.status === "booked");
      const label = intent.to.getTime() - intent.from.getTime() >= 23 * 3_600_000 ? dayOnlyLabel(intent.day, locale) : `${whenLabel(intent.from, coach.tz, locale)}–${whenLabel(intent.to, coach.tz, locale).split(" ").slice(-1)[0]}`;
      if (inside.length === 0) await say(s.blocked(label));
      else await say(s.blockedWithLessons(label, inside.map((l) => lessonLine(l, coach, locale, s)).join("\n")), kb(inside.map((l) => [{ text: `✕ ${l.student?.displayName ?? "?"} ${whenLabel(l.startsAt, coach.tz, locale)}`, callback_data: `cu:${l.id}` }])));
      return "coach:block";
    }
    case "package": {
      const student = await resolve(intent.student, true);
      if (!student) return "coach:package:ask";
      const pkg = await createPackage(db, { coachId: coach.id, studentPlayerId: student.id, size: intent.size, validDays: intent.validDays ?? (intent.expiresAt ? null : 90), expiresAt: intent.expiresAt, amount: intent.amount }, now);
      const until = pkg.expiresAt ? `, ${locale === "ru" ? "до" : locale === "es" ? "hasta" : "until"} ${dayOnlyLabel(utcToZonedParts(pkg.expiresAt, coach.tz).date, locale)}` : "";
      const amount = pkg.amount ? `, ${pkg.amount} ${pkg.currency}` : "";
      const caption = s.packageMade(student.name, pkg.size, until, amount);
      const keyboard = kb([[{ text: `${s.unpaid} → ${s.paid}`, callback_data: `cp:${pkg.id}` }]]);
      if (coach.promptpayId || coach.qrAssetId) {
        const photo = await sendPhoto(chatId, `${baseUrl()}/c/${coach.handle}/pay/${pkg.id}`, esc(caption), { keyboard, silent: true });
        if (!photo.ok) await say(caption, keyboard);
      } else await say(caption, keyboard);
      return "coach:package";
    }
    case "cancel": {
      let rows: LessonWithPeople[];
      if (intent.day) {
        const from = zonedTimeToUtc(intent.day, "00:00", coach.tz);
        rows = await listCoachLessons(db, coach.id, from, new Date(from.getTime() + DAY_MS));
      } else rows = await listCoachLessons(db, coach.id, now, new Date(now.getTime() + 14 * DAY_MS));
      rows = rows.filter((l) => l.status === "booked");
      if (intent.student?.kind === "one") {
        const sid = intent.student.student.id;
        rows = rows.filter((l) => l.studentPlayerId === sid);
      }
      if (intent.time) rows = rows.filter((l) => utcToZonedParts(l.startsAt, coach.tz).time === intent.time);
      if (rows.length === 0) {
        await say(s.nothingToCancel);
        return "coach:cancel:none";
      }
      if (rows.length > 1) {
        await say(s.whichOne, kb(rows.slice(0, 6).map((l) => [{ text: `✕ ${l.student?.displayName ?? "?"} ${whenLabel(l.startsAt, coach.tz, locale)}`, callback_data: `cu:${l.id}` }])));
        return "coach:cancel:which";
      }
      return cancelByCoach(db, coach, rows[0].id, s, locale, chatId);
    }
    case "book": {
      const student = await resolve(intent.student, true);
      if (!student) return "coach:book:ask";
      return bookForCoach(db, coach, coachPlayer, student, intent.startsAt, s, locale, chatId);
    }
  }
}

async function cancelByCoach(db: Db, coach: Coach, lessonId: string, s: CoachBotStrings, locale: string, chatId: number, editMessageId?: number): Promise<string> {
  const { lesson, outcome } = await cancelLesson(db, { lessonId, by: "coach", coach });
  const student = lesson.studentPlayerId ? await getPlayerById(db, lesson.studentPlayerId) : null;
  const pkg = lesson.packageId ? (await db.select().from(lessonPackages).where(eq(lessonPackages.id, lesson.packageId)).limit(1))[0] ?? null : null;
  const freed = await afterLessonFreed(db, coach, lesson, "coach");
  if (student) await notifyLessonCancelled(db, { lesson, coach, student, pkg, by: "coach", outcome, alternatives: freed.alternatives });
  if (freed.offer) await notifyOffer(db, coach, freed.offer).catch(() => undefined);
  const text = s.cancelled(student?.displayName ?? "?", whenLabel(lesson.startsAt, coach.tz, locale));
  if (editMessageId) await editMessageText(chatId, editMessageId, esc(text), null).catch(() => undefined);
  else await sendMessage(chatId, esc(text), { silent: true });
  return "coach:cancelled";
}

// ------------------------------------------------------------------ student flow

async function studentFlow(db: Db, player: Player, text: string, chatId: number): Promise<string | null> {
  const mine = (await studentCoaches(db, player.id)).filter((m) => m.status === "accepted");
  if (mine.length === 0) return null;
  const locale: CoachBotLocale = coachBotLocale(player.locale);
  const s = coachStrings(locale);
  const now = new Date();
  const tz = mine[0].coach.tz;
  const intent = parseStudentLine(text, { now, tz });
  const say = (t: string, keyboard?: InlineKeyboard) => sendMessage(chatId, esc(t), { silent: true, keyboard: keyboard ?? null });

  if (intent.kind === "help") return null;
  if (intent.kind === "left") {
    await say(mine.map((m) => s.left(m.coach.displayName, pkgText(s, m.activePackage))).join("\n"));
    return "student:left";
  }
  if (intent.kind === "lessons") return lessonsFor(db, player, chatId);
  if (intent.kind === "cancel") {
    let rows = (await listStudentLessons(db, player.id, now)).filter((l) => l.status === "booked");
    if (intent.day) rows = rows.filter((l) => utcToZonedParts(l.startsAt, l.coach.tz).date === intent.day);
    if (intent.time) rows = rows.filter((l) => utcToZonedParts(l.startsAt, l.coach.tz).time === intent.time);
    if (rows.length === 0) {
      await say(s.nothingToCancel);
      return "student:cancel:none";
    }
    if (rows.length > 1) {
      await say(s.whichOne, kb(rows.slice(0, 6).map((l) => [{ text: `✕ ${whenLabel(l.startsAt, l.coach.tz, locale)} ${s.withCoach(l.coach.displayName)}`, callback_data: `lc:${l.id}` }])));
      return "student:cancel:which";
    }
    return studentCancel(db, player, rows[0].id, s, locale, chatId, false);
  }
  // book
  if (mine.length > 1 && intent.time) {
    await say(s.whichCoach, kb(mine.map((m) => [{ text: m.coach.displayName, callback_data: `ld:${m.coach.id}:${intent.day}` }])));
    return "student:which_coach";
  }
  const coach = mine[0].coach;
  if (intent.startsAt) {
    try {
      const { lesson, package: pkg } = await bookLesson(db, { coach, studentPlayerId: player.id, startsAt: intent.startsAt, byCoach: false, source: "telegram", createdByPlayerId: player.id });
      await notifyLessonBooked(db, { lesson, coach, student: player, pkg, by: "student" });
      await say(s.youBooked(coach.displayName, whenLabel(lesson.startsAt, coach.tz, locale), pkgText(s, pkg)), kb([[{ text: s.cancel, callback_data: `lc:${lesson.id}` }]]));
      return "student:booked";
    } catch (e) {
      if (!isDomainError(e) || !["slot_taken", "outside_hours", "too_soon", "past"].includes(e.code)) throw e;
    }
  }
  return offerSlots(db, coach, intent.day, s, locale, chatId);
}

async function offerSlots(db: Db, coach: Coach, day: string, s: CoachBotStrings, locale: string, chatId: number, editMessageId?: number): Promise<string> {
  const from = zonedTimeToUtc(day, "00:00", coach.tz);
  const free = (await availableSlots(db, coach, from, new Date(from.getTime() + DAY_MS), new Date())).slice(0, 8);
  const label = dayOnlyLabel(day, locale);
  if (free.length === 0) {
    await sendMessage(chatId, esc(s.noFree(coach.displayName, label)), { silent: true });
    return "student:no_free";
  }
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < free.length; i += 4) rows.push(free.slice(i, i + 4).map((d) => ({ text: whenLabel(d, coach.tz, locale).split(" ").slice(-1)[0], callback_data: `lb:${coach.id}:${epochMin(d)}` })));
  const text = esc(s.freeTimes(coach.displayName, label));
  if (editMessageId) await editMessageText(chatId, editMessageId, text, kb(rows)).catch(() => undefined);
  else await sendMessage(chatId, text, { silent: true, keyboard: kb(rows) });
  return "student:slots";
}

async function studentCancel(db: Db, player: Player, lessonId: string, s: CoachBotStrings, locale: string, chatId: number, confirmed: boolean, editMessageId?: number): Promise<string> {
  const lesson = await getLesson(db, lessonId);
  if (!lesson || lesson.studentPlayerId !== player.id || lesson.status !== "booked") {
    await sendMessage(chatId, esc(s.nothingToCancel), { silent: true });
    return "student:cancel:none";
  }
  const coachRow = (await studentCoaches(db, player.id)).find((m) => m.coach.id === lesson.coachId)?.coach;
  if (!coachRow) return "student:cancel:none";
  const hoursUntil = (lesson.startsAt.getTime() - Date.now()) / 3_600_000;
  if (!confirmed && hoursUntil < coachRow.cutoffHours) {
    await sendMessage(chatId, esc(`${s.lateWarning(coachRow.cutoffHours)}`), { silent: true, keyboard: kb([[{ text: `✕ ${s.cancel}`, callback_data: `lx:${lesson.id}` }]]) });
    return "student:cancel:confirm";
  }
  const { lesson: updated, outcome } = await cancelLesson(db, { lessonId, by: "student", coach: coachRow, actorPlayerId: player.id });
  const pkg = updated.packageId ? (await db.select().from(lessonPackages).where(eq(lessonPackages.id, updated.packageId)).limit(1))[0] ?? null : null;
  await notifyLessonCancelled(db, { lesson: updated, coach: coachRow, student: player, pkg, by: "student", outcome });
  const freed = await afterLessonFreed(db, coachRow, updated, "student");
  if (freed.offer) await notifyOffer(db, coachRow, freed.offer).catch(() => undefined);
  const text = esc(s.youCancelled(outcome === "free_pass" ? s.outcomeFreePass : outcome === "counted" ? s.outcomeCounted : outcome === "refunded" ? s.outcomeRefunded : ""));
  if (editMessageId) await editMessageText(chatId, editMessageId, text, null).catch(() => undefined);
  else await sendMessage(chatId, text, { silent: true });
  return "student:cancelled";
}

/** /lessons: the student's next lessons with each coach, a cancel button each, and a link to book. */
export async function lessonsFor(db: Db, player: Player, chatId: number): Promise<string> {
  const locale = coachBotLocale(player.locale);
  const s = coachStrings(locale);
  const mine = (await studentCoaches(db, player.id)).filter((m) => m.status === "accepted");
  if (mine.length === 0) {
    await sendMessage(chatId, esc(s.notStudent), { silent: true });
    return "student:none";
  }
  const rows = (await listStudentLessons(db, player.id, new Date())).filter((l) => l.status === "booked").slice(0, 6);
  const lines = mine.map((m) => `${s.withCoach(m.coach.displayName)}: ${pkgText(s, m.activePackage)}`);
  const text = `${s.yourLessons}\n${lines.join("\n")}\n${rows.length ? rows.map((l) => `🎾 ${whenLabel(l.startsAt, l.coach.tz, locale)} ${s.withCoach(l.coach.displayName)}`).join("\n") : s.noLessons}`;
  const buttons = rows.map((l) => [{ text: `✕ ${whenLabel(l.startsAt, l.coach.tz, locale)}`, callback_data: `lc:${l.id}` }]);
  buttons.push(mine.map((m) => ({ text: `${s.book} · ${m.coach.displayName}`, url: `${baseUrl()}/c/${m.coach.handle}` })) as never);
  await sendMessage(chatId, esc(text), { silent: true, keyboard: kb(buttons) });
  return "student:lessons";
}

// ------------------------------------------------------------------ entry points

/** A private message that is not a command: the coach's book or the student's lessons answer it. Null when neither applies. */
export async function coachAssistantMessage(db: Db, msg: TgMessage, from: TgUser, player: Player): Promise<string | null> {
  if (msg.chat.type !== "private" || !msg.text) return null;
  const found = await getCoachForActor(db, player.id);
  if (found) {
    const coachPlayer = found.role === "coach" ? player : ((await getPlayerById(db, found.coach.playerId)) ?? player);
    return coachFlow(db, found.coach, { ...coachPlayer, locale: player.locale, telegramId: from.id }, msg.text, msg.chat.id);
  }
  return studentFlow(db, player, msg.text, msg.chat.id);
}

/** Buttons under the assistant's messages. Null when the data is not ours. */
export async function handleCoachCallback(db: Db, cb: Cb, player: Player): Promise<string | null> {
  const data = cb.data ?? "";
  const m = /^(cu|cp|cs|lc|lx|lb|ld|cb|lo|lw|rq):([0-9a-z-]{1,36})(?::([0-9a-z-]{1,10}))?$/i.exec(data);
  if (!m || !cb.message) return null;
  const [, action, id, extra] = m;
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const locale = coachBotLocale(player.locale);
  const s = coachStrings(locale);

  if (action === "rq") {
    const found = await getCoachForActor(db, player.id);
    if (!found) {
      await answerCallbackQuery(cb.id);
      return "coach:rq:not_coach";
    }
    try {
      const { request, lesson, package: pkg } = await decideRequest(db, found.coach, id, extra === "y");
      const student = await getPlayerById(db, request.studentPlayerId);
      if (student) await notifyRequestDecided(db, { coach: found.coach, student, request, lesson, pkg }).catch(() => undefined);
      await editMessageText(chatId, messageId, esc(s.requestAnswered(student?.displayName ?? "?", Boolean(lesson))), null).catch(() => undefined);
      await answerCallbackQuery(cb.id);
      return lesson ? "coach:request:yes" : "coach:request:no";
    } catch {
      await answerCallbackQuery(cb.id, s.requestGone);
      return "coach:request:gone";
    }
  }
  if (action === "lo" || action === "lw") {
    const hit = await getWaitlistEntry(db, id);
    if (!hit || hit.entry.studentPlayerId !== player.id) {
      await answerCallbackQuery(cb.id, s.offerGone);
      return "student:offer:none";
    }
    if (action === "lw") {
      await withdrawWaitlist(db, hit.coach.id, id, player.id);
      await editMessageText(chatId, messageId, esc(s.offerWithdrawn), null).catch(() => undefined);
      await answerCallbackQuery(cb.id);
      return "student:offer:withdrawn";
    }
    try {
      const { lesson, package: pkg } = await acceptOffer(db, hit.coach, id, player.id);
      await notifyLessonBooked(db, { lesson, coach: hit.coach, student: player, pkg, by: "student" });
      await editMessageText(chatId, messageId, esc(s.offerTaken(whenLabel(lesson.startsAt, hit.coach.tz, locale), pkgText(s, pkg))), kb([[{ text: s.cancel, callback_data: `lc:${lesson.id}` }]])).catch(() => undefined);
      await answerCallbackQuery(cb.id);
      return "student:offer:booked";
    } catch {
      await editMessageText(chatId, messageId, esc(s.offerGone), null).catch(() => undefined);
      await answerCallbackQuery(cb.id, s.offerGone);
      return "student:offer:gone";
    }
  }
  if (action === "cu" || action === "cp" || action === "cs" || action === "cb") {
    const found = await getCoachForActor(db, player.id);
    if (!found) {
      await answerCallbackQuery(cb.id);
      return "coach:cb:not_coach";
    }
    const coach = found.coach;
    if (action === "cu") {
      const lesson = await getLesson(db, id);
      if (!lesson || lesson.coachId !== coach.id || lesson.status !== "booked") {
        await answerCallbackQuery(cb.id, s.nothingToCancel);
        return "coach:undo:none";
      }
      await cancelByCoach(db, coach, id, s, locale, chatId, messageId);
      await answerCallbackQuery(cb.id, s.undone);
      return "coach:undo";
    }
    if (action === "cp") {
      const [pkg] = await db.select().from(lessonPackages).where(and(eq(lessonPackages.id, id), eq(lessonPackages.coachId, coach.id))).limit(1);
      if (!pkg) {
        await answerCallbackQuery(cb.id);
        return "coach:paid:none";
      }
      const paid = !pkg.paidAt;
      await setPackagePaid(db, coach.id, pkg.id, paid);
      await answerCallbackQuery(cb.id, paid ? s.markedPaid : s.markedUnpaid);
      const label = paid ? `${s.paid} ✓` : `${s.unpaid} → ${s.paid}`;
      const isPhoto = Boolean((cb.message as { photo?: unknown }).photo);
      if (!isPhoto) await editMessageText(chatId, messageId, esc(cb.message.text ?? ""), kb([[{ text: label, callback_data: `cp:${pkg.id}` }]])).catch(() => undefined);
      return "coach:paid";
    }
    if (action === "cs") {
      const student = await getPlayerById(db, id);
      if (!student) {
        await answerCallbackQuery(cb.id);
        return "coach:accept:none";
      }
      await setStudentStatus(db, coach.id, student.id, "accepted");
      await notifyStudentAccepted(coach, student);
      await editMessageText(chatId, messageId, esc(s.accepted(student.displayName)), null).catch(() => undefined);
      await answerCallbackQuery(cb.id);
      return "coach:accept";
    }
    // cb: book a candidate at a slot
    const student = await getPlayerById(db, id);
    if (!student || !extra) {
      await answerCallbackQuery(cb.id);
      return "coach:cb:none";
    }
    await answerCallbackQuery(cb.id);
    return bookForCoach(db, coach, player, { id: student.id, name: student.displayName }, fromEpochMin(extra), s, locale, chatId);
  }

  // Student side.
  if (action === "lc" || action === "lx") {
    await answerCallbackQuery(cb.id);
    return studentCancel(db, player, id, s, locale, chatId, action === "lx", messageId);
  }
  const mine = (await studentCoaches(db, player.id)).filter((x) => x.status === "accepted");
  const coach = mine.find((x) => x.coach.id === id)?.coach;
  if (!coach || (await studentStatus(db, coach.id, player.id)) !== "accepted") {
    await answerCallbackQuery(cb.id, s.notStudent);
    return "student:cb:not_student";
  }
  if (action === "ld") {
    await answerCallbackQuery(cb.id);
    return offerSlots(db, coach, extra ?? utcToZonedParts(new Date(), coach.tz).date, s, locale, chatId, messageId);
  }
  // lb: book the slot
  if (!extra) {
    await answerCallbackQuery(cb.id);
    return "student:lb:none";
  }
  const startsAt = fromEpochMin(extra);
  try {
    const { lesson, package: pkg } = await bookLesson(db, { coach, studentPlayerId: player.id, startsAt, byCoach: false, source: "telegram", createdByPlayerId: player.id });
    await notifyLessonBooked(db, { lesson, coach, student: player, pkg, by: "student" });
    await editMessageText(chatId, messageId, esc(s.youBooked(coach.displayName, whenLabel(lesson.startsAt, coach.tz, locale), pkgText(s, pkg))), kb([[{ text: s.cancel, callback_data: `lc:${lesson.id}` }]])).catch(() => undefined);
    await answerCallbackQuery(cb.id);
    return "student:booked";
  } catch (e) {
    if (isDomainError(e) && e.code === "slot_taken") {
      await answerCallbackQuery(cb.id, s.slotTaken);
      return offerSlots(db, coach, utcToZonedParts(startsAt, coach.tz).date, s, locale, chatId, messageId);
    }
    await answerCallbackQuery(cb.id, isDomainError(e) && e.code === "past" ? s.past : s.notStudent);
    return `student:lb:error`;
  }
}

export { activePackage };
