import type { Db } from "@/db";
import type { Coach, Player } from "@/db/schema";
import { acceptOffer as _unused, epochMin, fromEpochMin, joinWaitlist, requestOrBook, weekStartOf } from "@/lib/coach/chains";
import { notifyLessonBooked, notifyPackageTaken, notifyRequest } from "@/lib/coach/notify";
import { coachBotLocale, coachStrings, dayOnlyLabel, whenLabel, type CoachBotLocale, type CoachBotStrings } from "@/lib/coach/strings";
import { baseUrl } from "@/lib/config";
import { utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";
import {
  activePackage,
  addBlock,
  addStudentByName,
  availableSlots,
  blockTime,
  bookLesson,
  compLesson,
  createPackage,
  DAY_MS,
  getCoachForActor,
  getLesson,
  getPlayerById,
  LESSON_MINUTES,
  listCoachLessons,
  listOffers,
  listStudentLessons,
  listStudents,
  markNoShow,
  owedBy,
  owedToCoach,
  packageLine,
  presetHours,
  priceFor,
  studentCoaches,
  studentStatus,
  takeOffer,
  unmarkNoShow,
  updateCoach,
  type Hours,
  type LessonWithPeople,
} from "@/lib/domain/coaching";
import { isDomainError } from "@/lib/domain/errors";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { personalUrl } from "@/lib/personal";
import { answerCallbackQuery, deleteMessage, editMessageText, esc, sendMessage, sendPhoto, telegramBotId, type InlineKeyboard, type TgMessage, type TgUpdate } from "./api";
import { acceptedCoaches, bookForCoach, hoursSummary, kb, moveOne, pkgText, type ResolvedRole } from "./coach";

void _unused;

/**
 * The assistant as taps. Every step of the book is a button: who, which day, what time, how many;
 * cancel, move, no-show, on me; students, packages, money, settings; and on the student's side
 * book, move, cancel, pay, take a package, wait for a spot, ask for another time. The one-line
 * grammar in coach.ts still works for the coach who likes it, but nobody has to learn it — padel
 * players do not type "anna fri 15 90", and the owner said so.
 *
 * Stateless, like the setup walk: each button carries what has been chosen so far, packed into the
 * 64 bytes Telegram allows. Where a name, a time outside the grid or a price has to be typed, the
 * prompt forces a reply and carries its own context in a trailer, so the answer needs no memory.
 */

type Cb = NonNullable<TgUpdate["callback_query"]>;

// ------------------------------------------------------------------ packing

/** A uuid as 22 url-safe characters: three ids fit in one callback where one bare uuid would not. */
export const packId = (uuid: string): string => Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url");
export function unpackId(packed: string): string | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(packed)) return null;
  const hex = Buffer.from(packed, "base64url").toString("hex");
  return hex.length === 32 ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null;
}
/** "2026-09-18" ↔ "260918": a date in six characters. */
const ymd = (dateStr: string) => dateStr.slice(2).replace(/-/g, "");
const fromYmd = (six: string) => (/^\d{6}$/.test(six) ? `20${six.slice(0, 2)}-${six.slice(2, 4)}-${six.slice(4)}` : null);
const chunk = <T,>(xs: T[], n: number): T[][] => xs.reduce<T[][]>((rows, x, i) => ((i % n ? rows[rows.length - 1].push(x) : rows.push([x])), rows), []);
const money = (n: number, currency: string) => `${n} ${currency}`;
const timeOf = (at: Date, tz: string, locale: string) => whenLabel(at, tz, locale).split(" ").slice(-1)[0];

/** The lengths a coach sells: the usual one first. */
const lengthsOf = (coach: Coach): number[] => [coach.lessonMinutes, ...(coach.secondMinutes && coach.secondMinutes !== coach.lessonMinutes ? [coach.secondMinutes] : [])];
/** Whether the head count is worth a question: only when a pair pays something else than one. */
const asksHeads = (coach: Coach, minutes: number): boolean => priceFor(coach, 2, minutes) !== priceFor(coach, 1, minutes);

const TIME_RE = /^\s*(\d{1,2})(?:[:.hч](\d{2}))?\s*$/;
function parseTypedTime(text: string): string | null {
  const m = TIME_RE.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** Seven days from today in the coach's zone, two per row, plus the week after. */
function dayPicker(tz: string, locale: string, week: number, cbFor: (dateStr: string) => string, next: string | null, s: CoachBotStrings): InlineKeyboard {
  const today = utcToZonedParts(new Date(), tz).date;
  const start = new Date(`${today}T00:00:00Z`).getTime() + week * 7 * DAY_MS;
  const days = Array.from({ length: 7 }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10));
  const rows = chunk(days.map((d) => ({ text: dayOnlyLabel(d, locale), callback_data: cbFor(d) })), 2);
  if (next) rows.push([{ text: week === 0 ? "›" : s.tapBack, callback_data: next }]);
  return kb(rows);
}

/** The free times of one day, four per row, with a way to type a time the grid does not offer. */
async function timeRows(db: Db, coach: Coach, dateStr: string, minutes: number, cbFor: (at: Date) => string, o: { anyHour: boolean; locale: string }): Promise<{ text: string; callback_data: string }[][]> {
  const from = zonedTimeToUtc(dateStr, "00:00", coach.tz);
  const free = (await availableSlots(db, o.anyHour ? { ...coach, minNoticeHours: 0 } : coach, from, new Date(from.getTime() + DAY_MS), new Date(), minutes)).slice(0, 16);
  return chunk(free.map((d) => ({ text: timeOf(d, coach.tz, o.locale), callback_data: cbFor(d) })), 4);
}

const trailer = (code: string) => `\n↳ ${code}`;
/** A prompt whose answer comes back as a reply, with the flow's state in the last line. */
async function ask(chatId: number, text: string, code: string, placeholder: string): Promise<void> {
  await sendMessage(chatId, esc(`${text}${trailer(code)}`), { silent: true, keyboard: { force_reply: true, selective: true, input_field_placeholder: placeholder } });
}

const moneyLine = (s: CoachBotStrings, l: { amount: number | null; paidAt: Date | null; paidClaimedAt: Date | null; compedAt: Date | null }, currency: string): string => {
  if (l.compedAt) return s.tapOnMe;
  if (!l.amount) return "";
  const m = money(l.amount, currency);
  return l.paidAt ? s.tapMoneyPaid(m) : l.paidClaimedAt ? s.tapMoneySaysPaid(m) : s.tapMoneyNotPaid(m);
};

// ------------------------------------------------------------------ coach: book

/** "＋ Book": who is it for? Every student as a button, and one for somebody new. */
export async function tapBookWho(db: Db, coach: Coach, s: CoachBotStrings, chatId: number, editId?: number): Promise<string> {
  const students = (await listStudents(db, coach.id)).filter((x) => x.status !== "requested" && x.status !== "left").slice(0, 24);
  const rows = chunk(students.map((x) => ({ text: x.player.displayName, callback_data: `kb:${packId(x.player.id)}` })), 2);
  rows.push([{ text: s.tapNewStudent, callback_data: "kn:" }]);
  if (editId) await editMessageText(chatId, editId, esc(s.tapWho), kb(rows)).catch(() => undefined);
  else await sendMessage(chatId, esc(s.tapWho), { silent: true, keyboard: kb(rows) });
  return "coach:tap:who";
}

async function afterWho(db: Db, coach: Coach, sid: string, s: CoachBotStrings, locale: string, chatId: number, editId: number | null): Promise<string> {
  const lengths = lengthsOf(coach);
  const student = await getPlayerById(db, sid);
  if (!student) return "coach:tap:none";
  if (lengths.length > 1) {
    const rows = [lengths.map((m) => ({ text: s.minutesLabel(m), callback_data: `kd:${packId(sid)}:${m}:w0` }))];
    await put(chatId, editId, `${student.displayName} — ${s.tapHowLong}`, kb(rows));
    return "coach:tap:length";
  }
  return coachDays(db, coach, sid, coach.lessonMinutes, 0, s, locale, chatId, editId);
}

async function coachDays(db: Db, coach: Coach, sid: string, minutes: number, week: number, s: CoachBotStrings, locale: string, chatId: number, editId: number | null): Promise<string> {
  const student = await getPlayerById(db, sid);
  if (!student) return "coach:tap:none";
  const keyboard = dayPicker(coach.tz, locale, week, (d) => `kt:${packId(sid)}:${minutes}:${ymd(d)}`, `kd:${packId(sid)}:${minutes}:w${week === 0 ? 1 : 0}`, s);
  await put(chatId, editId, s.tapWhichDay(student.displayName), keyboard);
  return "coach:tap:day";
}

async function coachTimes(db: Db, coach: Coach, sid: string, minutes: number, dateStr: string, s: CoachBotStrings, locale: string, chatId: number, editId: number | null): Promise<string> {
  const rows = await timeRows(db, coach, dateStr, minutes, (d) => `kh:${packId(sid)}:${minutes}:${epochMin(d)}`, { anyHour: true, locale });
  rows.push([{ text: s.tapOtherTime, callback_data: `ko:${packId(sid)}:${minutes}:${ymd(dateStr)}` }, { text: s.tapBack, callback_data: `kd:${packId(sid)}:${minutes}:w0` }]);
  await put(chatId, editId, rows.length > 1 ? s.tapWhichTime(dayOnlyLabel(dateStr, locale)) : s.tapNoFree(dayOnlyLabel(dateStr, locale)), kb(rows));
  return "coach:tap:time";
}

/** After the time: how many, when the coach charges a pair differently; otherwise straight to the book. */
async function coachHeadsOrBook(db: Db, coach: Coach, coachPlayer: Player, sid: string, minutes: number, at: Date, s: CoachBotStrings, locale: string, chatId: number, editId: number | null): Promise<string> {
  if (asksHeads(coach, minutes)) {
    const rows = [[1, 2, 3, 4].map((n) => ({ text: String(n), callback_data: `ky:${packId(sid)}:${minutes}:${epochMin(at)}:${n}` }))];
    await put(chatId, editId, s.tapHowMany, kb(rows));
    return "coach:tap:heads";
  }
  return coachBook(db, coach, coachPlayer, sid, minutes, at, 1, s, locale, chatId, editId);
}

async function coachBook(db: Db, coach: Coach, coachPlayer: Player, sid: string, minutes: number, at: Date, heads: number, s: CoachBotStrings, locale: string, chatId: number, editId: number | null): Promise<string> {
  const student = await getPlayerById(db, sid);
  if (!student) return "coach:tap:none";
  if (editId) await deleteMessage(chatId, editId).catch(() => undefined);
  return bookForCoach(db, coach, coachPlayer, { id: student.id, name: student.displayName }, at, s, locale, chatId, undefined, { minutes: lengthsOf(coach).includes(minutes) ? minutes : undefined, heads });
}

async function put(chatId: number, editId: number | null, text: string, keyboard: InlineKeyboard): Promise<void> {
  if (editId) await editMessageText(chatId, editId, esc(text), keyboard).catch(() => undefined);
  else await sendMessage(chatId, esc(text), { silent: true, keyboard });
}

// ------------------------------------------------------------------ coach: lessons, cancel, move, card

const lessonLabel = (l: LessonWithPeople, coach: Coach, locale: string) => `${l.student?.displayName ?? "?"} · ${whenLabel(l.startsAt, coach.tz, locale)}`;

async function upcoming(db: Db, coach: Coach, days = 14): Promise<LessonWithPeople[]> {
  const now = new Date();
  return (await listCoachLessons(db, coach.id, now, new Date(now.getTime() + days * DAY_MS))).filter((l) => l.status === "booked").slice(0, 12);
}

/** "✕ Cancel": the next lessons as buttons; a tap asks once before it cancels. */
export async function tapCancelList(db: Db, coach: Coach, s: CoachBotStrings, locale: string, chatId: number): Promise<string> {
  const rows = await upcoming(db, coach);
  if (rows.length === 0) {
    await sendMessage(chatId, esc(s.tapNothingAhead), { silent: true });
    return "coach:tap:cancel_none";
  }
  await sendMessage(chatId, esc(s.tapWhichLesson), { silent: true, keyboard: kb(rows.map((l) => [{ text: `✕ ${lessonLabel(l, coach, locale)}`, callback_data: `kx:${packId(l.id)}` }])) });
  return "coach:tap:cancel_list";
}

/** "↔ Move": the next lessons as buttons, then a day, then a free time. */
export async function tapMoveList(db: Db, coach: Coach, s: CoachBotStrings, locale: string, chatId: number): Promise<string> {
  const rows = await upcoming(db, coach);
  if (rows.length === 0) {
    await sendMessage(chatId, esc(s.tapNothingAhead), { silent: true });
    return "coach:tap:move_none";
  }
  await sendMessage(chatId, esc(s.tapWhichLesson), { silent: true, keyboard: kb(rows.map((l) => [{ text: `↔ ${lessonLabel(l, coach, locale)}`, callback_data: `km:${packId(l.id)}` }])) });
  return "coach:tap:move_list";
}

/** One lesson, with everything the coach can do to it. Reached from the agenda and from the students screen. */
async function lessonCard(db: Db, coach: Coach, lessonId: string, s: CoachBotStrings, locale: string, chatId: number, editId: number | null): Promise<string> {
  const lesson = await getLesson(db, lessonId);
  if (!lesson || lesson.coachId !== coach.id) return "coach:tap:none";
  const student = lesson.studentPlayerId ? await getPlayerById(db, lesson.studentPlayerId) : null;
  const pkg = lesson.studentPlayerId ? await activePackage(db, coach.id, lesson.studentPlayerId, new Date()) : null;
  const name = student?.displayName ?? "?";
  const when = whenLabel(lesson.startsAt, coach.tz, locale);
  const text = s.tapLesson(name, when, lesson.status === "booked" || lesson.status === "done" ? pkgText(s, pkg) : `${pkgText(s, pkg)} · ${lesson.status}`, moneyLine(s, lesson, coach.currency));
  const id = packId(lesson.id);
  const rows: { text: string; callback_data: string }[][] = [];
  if (lesson.status === "booked") rows.push([{ text: s.tapMove, callback_data: `km:${id}` }, { text: s.tapCancelBtn, callback_data: `kx:${id}` }]);
  const past = lesson.startsAt.getTime() < Date.now();
  if (lesson.status === "done" || (lesson.status === "booked" && past)) rows.push([{ text: s.tapNoShow, callback_data: `kq:${id}` }]);
  if (lesson.status === "no_show") rows.push([{ text: s.tapCame, callback_data: `kq:${id}:u` }]);
  const actions: { text: string; callback_data: string }[] = [];
  if ((lesson.amount ?? 0) > 0 && !lesson.paidAt && !lesson.compedAt) actions.push({ text: `✓ ${s.paid}`, callback_data: `cq:${lesson.id}` });
  if (!lesson.compedAt && !lesson.paidAt && (lesson.status === "booked" || lesson.status === "done")) actions.push({ text: s.tapOnMe, callback_data: `kf:${id}` });
  if (actions.length) rows.push(actions);
  await put(chatId, editId, text, kb(rows));
  return "coach:tap:lesson";
}

/** Buttons under an agenda: one per lesson, into its card. */
export const agendaButtons = (rows: LessonWithPeople[], coach: Coach, locale: string): InlineKeyboard | undefined => (rows.length ? kb(rows.slice(0, 8).map((l) => [{ text: `${lessonLabel(l, coach, locale)} ›`, callback_data: `kl:${packId(l.id)}` }])) : undefined);

// ------------------------------------------------------------------ coach: block time

/** "🚫 Block time": which day, then the whole day or one of its hours. What connecting a calendar stood in for. */
export async function tapBlockDays(coach: Coach, s: CoachBotStrings, locale: string, chatId: number, week: number, editId: number | null = null): Promise<string> {
  await put(chatId, editId, s.tapBlockDay, dayPicker(coach.tz, locale, week, (d) => `kk:${ymd(d)}`, `kk:w${week === 0 ? 1 : 0}`, s));
  return "coach:tap:block_day";
}

async function blockWhat(coach: Coach, dateStr: string, s: CoachBotStrings, locale: string, chatId: number, editId: number | null): Promise<string> {
  const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  const ranges = (coach.hours as Hours)[String(dow)] ?? [];
  const starts: string[] = [];
  for (const [from, to] of ranges) {
    let t = Number(from.slice(0, 2)) * 60 + Number(from.slice(3));
    const stop = Number(to.slice(0, 2)) * 60 + Number(to.slice(3));
    while (t + coach.lessonMinutes <= stop) {
      starts.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
      t += coach.lessonMinutes;
    }
  }
  const rows = [[{ text: s.tapAllDay, callback_data: `kk:${ymd(dateStr)}:all` }], ...chunk(starts.map((hhmm) => ({ text: hhmm, callback_data: `kk:${ymd(dateStr)}:${epochMin(zonedTimeToUtc(dateStr, hhmm, coach.tz))}` })), 4)];
  rows.push([{ text: s.tapBack, callback_data: "kk:" }]);
  await put(chatId, editId, s.tapBlockWhat(dayOnlyLabel(dateStr, locale)), kb(rows));
  return "coach:tap:block_what";
}

async function blockIt(db: Db, coach: Coach, dateStr: string, what: string, s: CoachBotStrings, locale: string, chatId: number, editId: number | null): Promise<string> {
  const from = what === "all" ? zonedTimeToUtc(dateStr, "00:00", coach.tz) : fromEpochMin(what);
  const to = what === "all" ? new Date(from.getTime() + DAY_MS) : new Date(from.getTime() + coach.lessonMinutes * 60_000);
  if (what === "all") await addBlock(db, coach.id, from, to, "telegram");
  else await blockTime(db, { coachId: coach.id, startsAt: from, minutes: coach.lessonMinutes });
  const inside = (await listCoachLessons(db, coach.id, from, to)).filter((l) => l.status === "booked");
  const label = what === "all" ? dayOnlyLabel(dateStr, locale) : whenLabel(from, coach.tz, locale);
  if (inside.length === 0) {
    await put(chatId, editId, s.blocked(label), kb([]));
    return "coach:block";
  }
  await put(chatId, editId, s.blockedWithLessons(label, inside.map((l) => lessonLabel(l, coach, locale)).join("\n")), kb(inside.map((l) => [{ text: `✕ ${lessonLabel(l, coach, locale)}`, callback_data: `kx:${packId(l.id)}` }])));
  return "coach:block";
}

// ------------------------------------------------------------------ coach: students, packages, money, settings

/** "👥 Students": everybody, with their package and what they owe, each a button into their card. */
export async function tapStudents(db: Db, coach: Coach, s: CoachBotStrings, chatId: number, editId: number | null = null): Promise<string> {
  const students = (await listStudents(db, coach.id)).filter((x) => x.status !== "left");
  if (students.length === 0) {
    await put(chatId, editId, s.tapStudentsNone, kb([]));
    return "coach:tap:students_none";
  }
  const owed = await owedToCoach(db, coach.id, 200);
  const owes = new Map<string, number>();
  for (const r of owed) owes.set(r.studentPlayerId, (owes.get(r.studentPlayerId) ?? 0) + r.amount);
  for (const x of students) if (x.activePackage && !x.activePackage.paidAt && x.activePackage.amount) owes.set(x.player.id, (owes.get(x.player.id) ?? 0) + x.activePackage.amount);
  const lines = students.map((x) => s.tapStudentLine(x.player.displayName, pkgText(s, x.activePackage), owes.get(x.player.id) ? s.tapOwes(money(owes.get(x.player.id)!, coach.currency)) : ""));
  const rows = chunk(students.filter((x) => x.status !== "requested").slice(0, 24).map((x) => ({ text: x.player.displayName, callback_data: `ks:${packId(x.player.id)}` })), 2);
  for (const x of students.filter((x) => x.status === "requested")) rows.push([{ text: `${s.accept}: ${x.player.displayName}`, callback_data: `cs:${x.player.id}` }]);
  await put(chatId, editId, `${s.tapStudents}\n${lines.join("\n")}`, kb(rows));
  return "coach:tap:students";
}

async function studentCard(db: Db, coach: Coach, sid: string, s: CoachBotStrings, locale: string, chatId: number, editId: number | null): Promise<string> {
  const row = (await listStudents(db, coach.id)).find((x) => x.player.id === sid);
  if (!row) return "coach:tap:none";
  const owed = await owedBy(db, coach, sid);
  const next = (await listStudentLessons(db, sid, new Date(), 20)).find((l) => l.coachId === coach.id && l.status === "booked");
  const text = s.tapStudentCard(row.player.displayName, pkgText(s, row.activePackage), owed.total > 0 ? s.tapOwes(money(owed.total, owed.currency)) : "", next ? s.tapNextLesson(whenLabel(next.startsAt, coach.tz, locale)) : s.tapNoNext);
  const id = packId(sid);
  const rows: { text: string; callback_data: string }[][] = [[{ text: s.tapBookFor, callback_data: `kb:${id}` }, { text: s.tapPackageFor, callback_data: `kp:${id}` }]];
  if (row.activePackage && !row.activePackage.paidAt && row.activePackage.amount) rows.push([{ text: `✓ ${s.paid}: ${money(row.activePackage.amount, row.activePackage.currency)}`, callback_data: `cp:${row.activePackage.id}` }]);
  for (const l of owed.lessons.slice(0, 4)) rows.push([{ text: `✓ ${s.paid}: ${money(l.amount, owed.currency)} · ${whenLabel(l.startsAt, coach.tz, locale)}`, callback_data: `cq:${l.id}` }]);
  if (next) rows.push([{ text: `${whenLabel(next.startsAt, coach.tz, locale)} ›`, callback_data: `kl:${packId(next.id)}` }]);
  rows.push([{ text: s.tapBack, callback_data: "ks:" }]);
  await put(chatId, editId, text, kb(rows));
  return "coach:tap:student";
}

/** "＋ Package" on a student: the coach's own offers as buttons, or a typed line for anything else. */
async function packagePicker(db: Db, coach: Coach, sid: string, s: CoachBotStrings, chatId: number, editId: number | null): Promise<string> {
  const student = await getPlayerById(db, sid);
  if (!student) return "coach:tap:none";
  const offers = await listOffers(db, coach.id);
  const rows = offers.map((o) => [{ text: s.tapPackageLabel(o.size, o.minutes, o.heads, money(o.price, coach.currency)), callback_data: `kp:${packId(sid)}:${packId(o.id)}` }]);
  rows.push([{ text: s.tapPackageCustom, callback_data: `kp:${packId(sid)}:c` }]);
  await put(chatId, editId, s.tapWhichPackage(student.displayName), kb(rows));
  return "coach:tap:package_pick";
}

async function packageMade(db: Db, coach: Coach, sid: string, input: { size: number; validDays: number | null; amount: number | null; minutes?: number | null; heads?: number | null; offerId?: string | null }, s: CoachBotStrings, locale: string, chatId: number): Promise<string> {
  const student = await getPlayerById(db, sid);
  if (!student) return "coach:tap:none";
  const pkg = await createPackage(db, { coachId: coach.id, studentPlayerId: sid, size: input.size, validDays: input.validDays, amount: input.amount, currency: coach.currency, minutes: input.minutes ?? null, heads: input.heads ?? 1, offerId: input.offerId ?? null });
  const until = pkg.expiresAt ? `, ${locale === "ru" ? "до" : locale === "es" ? "hasta" : "until"} ${dayOnlyLabel(utcToZonedParts(pkg.expiresAt, coach.tz).date, locale)}` : "";
  const amount = pkg.amount ? `, ${money(pkg.amount, pkg.currency)}` : "";
  const caption = s.packageMade(student.displayName, pkg.size, until, amount);
  const keyboard = kb([[{ text: `${s.unpaid} → ${s.paid}`, callback_data: `cp:${pkg.id}` }]]);
  if (coach.promptpayId || coach.qrAssetId) {
    const photo = await sendPhoto(chatId, `${baseUrl()}/c/${coach.handle}/pay/${pkg.id}`, esc(caption), { keyboard, silent: true });
    if (!photo.ok) await sendMessage(chatId, esc(caption), { keyboard, silent: true });
  } else await sendMessage(chatId, esc(caption), { keyboard, silent: true });
  return "coach:package";
}

/** "💰 Money": every unpaid lesson and package, a button to mark each one paid. */
export async function tapMoney(db: Db, coach: Coach, s: CoachBotStrings, locale: string, chatId: number): Promise<string> {
  const rows = await owedToCoach(db, coach.id, 30);
  const pkgs = (await listStudents(db, coach.id)).filter((x) => x.activePackage && !x.activePackage.paidAt && x.activePackage.amount);
  if (rows.length === 0 && pkgs.length === 0) {
    await sendMessage(chatId, esc(s.tapMoneyNone), { silent: true });
    return "coach:tap:money_none";
  }
  const lines = [
    ...pkgs.map((x) => s.tapMoneyPackage(x.player.displayName, x.activePackage!.size, money(x.activePackage!.amount!, coach.currency))),
    ...rows.map((r) => s.owesLine(r.name, money(r.amount, coach.currency), whenLabel(r.startsAt, coach.tz, locale), r.claimedAt !== null)),
  ];
  const buttons = [
    ...pkgs.slice(0, 6).map((x) => [{ text: `✓ ${s.paid}: ${x.player.displayName} · ${money(x.activePackage!.amount!, coach.currency)}`, callback_data: `cp:${x.activePackage!.id}` }]),
    ...rows.slice(0, 8).map((r) => [{ text: `✓ ${s.paid}: ${r.name} · ${whenLabel(r.startsAt, coach.tz, locale)}`, callback_data: `cq:${r.lessonId}` }]),
  ];
  await sendMessage(chatId, esc(s.owes(lines.join("\n"))), { silent: true, keyboard: kb(buttons) });
  return "coach:tap:money";
}

/** "⚙️ Settings": the book's rules with a button per value; the figures stay one typed line. */
export async function tapSettings(db: Db, coach: Coach, player: Player, s: CoachBotStrings, locale: string, chatId: number, editId: number | null = null): Promise<string> {
  const lines = [
    `${s.labLesson}: ${s.minutesLabel(coach.lessonMinutes)}${coach.secondMinutes ? ` · ${s.minutesLabel(coach.secondMinutes)}` : ""}`,
    `${s.labHours}: ${hoursSummary(coach.hours as Hours, s, locale)}`,
    `${s.labPrice}: ${coach.priceSingle ? money(coach.priceSingle, coach.currency) : s.labNotSet}${coach.priceTwo ? ` · ${s.tapEach(money(coach.priceTwo, coach.currency))}` : ""}`,
    `${s.labCutoff}: ${coach.cutoffHours} h`,
    `${s.labPasses}: ${coach.latePasses}`,
    `${s.labClubs}: ${coach.clubNames?.length ? coach.clubNames.join(", ") : s.labNotSet}`,
    `${s.labPromptpay}: ${coach.promptpayId || s.labNotSet}`,
    `${s.labZone}: ${coach.tz}`,
  ];
  const mark = (on: boolean, text: string) => (on ? `✓ ${text}` : text);
  const preset = (["mornings", "afternoons", "both"] as const).find((p) => JSON.stringify(presetHours(p)) === JSON.stringify(coach.hours)) ?? null;
  const rows: { text: string; callback_data?: string; url?: string }[][] = [
    LESSON_MINUTES.map((m) => ({ text: mark(coach.lessonMinutes === m, s.minutesLabel(m)), callback_data: `ke:lesson:${m}` })),
    [
      { text: mark(preset === "mornings", s.hoursMornings), callback_data: "ke:hours:mornings" },
      { text: mark(preset === "afternoons", s.hoursAfternoons), callback_data: "ke:hours:afternoons" },
      { text: mark(preset === "both", s.hoursBoth), callback_data: "ke:hours:both" },
    ],
    [6, 12, 24].map((h) => ({ text: mark(coach.cutoffHours === h, `${s.labCutoff} ${h} h`), callback_data: `ke:cutoff:${h}` })),
    [0, 1, 2].map((n) => ({ text: mark(coach.latePasses === n, `${s.labPasses}: ${n}`), callback_data: `ke:passes:${n}` })),
  ];
  const token = await getOrCreatePersonalToken(db, player.id);
  rows.push([{ text: s.tapSettingsWeb, url: `${personalUrl(baseUrl(), token)}?next=/coach/settings` }]);
  await put(chatId, editId, `${s.settings(lines.join("\n")).split("\n").slice(0, -1).join("\n")}\n${s.tapSettingsHow}`, kb(rows));
  return "coach:tap:settings";
}

// ------------------------------------------------------------------ student: book, move, pay

/** "＋ Book" for a student: which coach when there are two, how long when the coach sells two, then a day. */
export async function tapStudentBook(db: Db, player: Player, s: CoachBotStrings, locale: string, chatId: number, editId: number | null = null): Promise<string> {
  const mine = await acceptedCoaches(db, player.id);
  if (mine.length === 0) {
    await sendMessage(chatId, esc(s.notStudent), { silent: true });
    return "student:none";
  }
  if (mine.length > 1) {
    await put(chatId, editId, s.tapStudentWhichCoach, kb(mine.map((m) => [{ text: m.coach.displayName, callback_data: `sb:${packId(m.coach.id)}` }])));
    return "student:tap:coach";
  }
  return studentAfterCoach(db, player, mine[0].coach, s, locale, chatId, editId);
}

async function studentAfterCoach(db: Db, player: Player, coach: Coach, s: CoachBotStrings, locale: string, chatId: number, editId: number | null): Promise<string> {
  const lengths = lengthsOf(coach);
  const pkg = await activePackage(db, coach.id, player.id);
  if (lengths.length > 1 && !pkg) {
    const rows = [lengths.map((m) => {
      const each = priceFor(coach, 1, m);
      return { text: `${s.minutesLabel(m)}${each ? ` · ${money(each, coach.currency)}` : ""}`, callback_data: `sd:${packId(coach.id)}:${m}:w0` };
    })];
    await put(chatId, editId, s.tapHowLong, kb(rows));
    return "student:tap:length";
  }
  return studentDays(db, player, coach, pkg?.minutes ?? coach.lessonMinutes, 0, s, locale, chatId, editId);
}

async function studentDays(db: Db, player: Player, coach: Coach, minutes: number, week: number, s: CoachBotStrings, locale: string, chatId: number, editId: number | null): Promise<string> {
  void player;
  const keyboard = dayPicker(coach.tz, locale, week, (d) => `st:${packId(coach.id)}:${minutes}:${ymd(d)}`, `sd:${packId(coach.id)}:${minutes}:w${week === 0 ? 1 : 0}`, s);
  await put(chatId, editId, s.tapWhichDayStudent(coach.displayName), keyboard);
  return "student:tap:day";
}

async function studentTimes(db: Db, coach: Coach, minutes: number, dateStr: string, s: CoachBotStrings, locale: string, chatId: number, editId: number | null): Promise<string> {
  const rows = await timeRows(db, coach, dateStr, minutes, (d) => `sh:${packId(coach.id)}:${minutes}:${epochMin(d)}`, { anyHour: false, locale });
  const label = dayOnlyLabel(dateStr, locale);
  const none = rows.length === 0;
  // Nothing free: wait for the week, or ask the coach for an hour outside the grid.
  if (none) rows.push([{ text: s.tapWaitWeek, callback_data: `sw:${packId(coach.id)}:${ymd(dateStr)}` }]);
  rows.push([{ text: s.tapAskAnother, callback_data: `sa:${packId(coach.id)}:${ymd(dateStr)}` }, { text: s.tapBack, callback_data: `sd:${packId(coach.id)}:${minutes}:w0` }]);
  await put(chatId, editId, none ? s.tapNoFree(label) : s.tapWhichTime(label), kb(rows));
  return none ? "student:tap:no_free" : "student:tap:time";
}

async function studentHeadsOrBook(db: Db, player: Player, coach: Coach, minutes: number, at: Date, s: CoachBotStrings, locale: string, chatId: number, editId: number | null): Promise<string> {
  const pkg = await activePackage(db, coach.id, player.id);
  if (!pkg && asksHeads(coach, minutes)) {
    const rows = [[1, 2, 3, 4].map((n) => {
      const each = priceFor(coach, n, minutes);
      return { text: `${n}${each ? ` · ${money(each, coach.currency)}` : ""}`, callback_data: `sy:${packId(coach.id)}:${minutes}:${epochMin(at)}:${n}` };
    })];
    await put(chatId, editId, s.tapHowMany, kb(rows));
    return "student:tap:heads";
  }
  return studentBook(db, player, coach, minutes, at, pkg?.heads ?? 1, s, locale, chatId, editId);
}

async function studentBook(db: Db, player: Player, coach: Coach, minutes: number, at: Date, heads: number, s: CoachBotStrings, locale: string, chatId: number, editId: number | null): Promise<string> {
  try {
    const { lesson, package: pkg } = await bookLesson(db, { coach, studentPlayerId: player.id, startsAt: at, byCoach: false, source: "telegram", createdByPlayerId: player.id, minutes: lengthsOf(coach).includes(minutes) ? minutes : undefined, heads });
    await notifyLessonBooked(db, { lesson, coach, student: player, pkg, by: "student" });
    const extra = lesson.amount ? `\n${s.tapMoneyNotPaid(money(lesson.amount, coach.currency))}` : "";
    await put(chatId, editId, `${s.youBooked(coach.displayName, whenLabel(lesson.startsAt, coach.tz, locale), pkgText(s, pkg))}${extra}`, kb([[{ text: s.cancel, callback_data: `lc:${lesson.id}` }]]));
    return "student:booked";
  } catch (e) {
    if (isDomainError(e) && e.code === "slot_taken") return studentTimes(db, coach, minutes, utcToZonedParts(at, coach.tz).date, s, locale, chatId, editId);
    if (isDomainError(e)) {
      await put(chatId, editId, e.code === "past" ? s.past : e.code === "outside_hours" ? s.moveOutside : e.code === "too_soon" ? s.moveTooSoon : s.notStudent, kb([]));
      return `student:tap:${e.code}`;
    }
    throw e;
  }
}

/** "↔ Move" for a student: which lesson, which day, which free time. */
export async function tapStudentMove(db: Db, player: Player, s: CoachBotStrings, locale: string, chatId: number): Promise<string> {
  const rows = (await listStudentLessons(db, player.id, new Date())).filter((l) => l.status === "booked").slice(0, 8);
  if (rows.length === 0) {
    await sendMessage(chatId, esc(s.nothingToMove), { silent: true });
    return "student:move:none";
  }
  await sendMessage(chatId, esc(s.tapWhichLesson), { silent: true, keyboard: kb(rows.map((l) => [{ text: `↔ ${whenLabel(l.startsAt, l.coach.tz, locale)} ${s.withCoach(l.coach.displayName)}`, callback_data: `sm:${packId(l.id)}` }])) });
  return "student:tap:move_list";
}

/** "💳 Pay & package": what is owed with "I paid" per lesson, the package line, and a way to take one. */
export async function tapStudentPay(db: Db, player: Player, s: CoachBotStrings, locale: string, chatId: number): Promise<string> {
  const mine = await acceptedCoaches(db, player.id);
  if (mine.length === 0) {
    await sendMessage(chatId, esc(s.notStudent), { silent: true });
    return "student:none";
  }
  const lines: string[] = [];
  const rows: { text: string; callback_data: string }[][] = [];
  for (const m of mine) {
    const owed = await owedBy(db, m.coach, player.id);
    lines.push(s.left(m.coach.displayName, pkgText(s, m.activePackage)));
    for (const p of owed.packages) lines.push(s.youOweLine(money(p.amount, owed.currency), `${s.tapPay} · ${p.size}`, false));
    for (const l of owed.lessons) {
      lines.push(s.youOweLine(money(l.amount, owed.currency), whenLabel(l.startsAt, m.coach.tz, locale), l.claimedAt !== null));
      if (!l.claimedAt) rows.push([{ text: `${s.iPaid} · ${whenLabel(l.startsAt, m.coach.tz, locale)}`, callback_data: `lp:${l.id}` }]);
    }
    if (!m.activePackage && (await listOffers(db, m.coach.id)).length) rows.push([{ text: `${s.tapTakePackage} · ${m.coach.displayName}`, callback_data: `sk:${packId(m.coach.id)}` }]);
  }
  await sendMessage(chatId, esc(lines.join("\n")), { silent: true, keyboard: rows.length ? kb(rows) : null });
  return "student:tap:pay";
}

async function packagesFor(db: Db, coach: Coach, s: CoachBotStrings, chatId: number, editId: number | null): Promise<string> {
  const offers = await listOffers(db, coach.id);
  if (offers.length === 0) {
    await put(chatId, editId, s.tapPackagesNone(coach.displayName), kb([]));
    return "student:tap:packages_none";
  }
  await put(chatId, editId, s.tapPackages(coach.displayName), kb(offers.map((o) => [{ text: `${s.tapPackageLabel(o.size, o.minutes, o.heads, money(o.price, coach.currency))}${o.validDays ? ` · ${o.validDays} d` : ""}`, callback_data: `sk:${packId(coach.id)}:${packId(o.id)}` }])));
  return "student:tap:packages";
}

const payLines = (coach: Coach, s: CoachBotStrings): string[] => {
  const lines: string[] = [];
  if (coach.payAtClub) lines.push(s.tapPayAtClub);
  if (coach.promptpayId || coach.qrAssetId) lines.push(s.tapPayPromptpay);
  if (coach.payLink) lines.push(`${s.tapPayLink}: ${coach.payLink}`);
  return lines.length ? lines : [s.tapPayAsk(coach.displayName)];
};

async function takePackage(db: Db, player: Player, coach: Coach, offerId: string, s: CoachBotStrings, chatId: number, editId: number | null): Promise<string> {
  try {
    const { pkg } = await takeOffer(db, coach, player.id, offerId);
    await notifyPackageTaken(db, { coach, student: player, pkg }).catch(() => undefined);
    const text = `${s.tapPackageTaken(pkg.size, money(pkg.amount ?? 0, pkg.currency), coach.displayName)}\n${s.tapPayHow(payLines(coach, s).join("\n"))}`;
    if (editId) await deleteMessage(chatId, editId).catch(() => undefined);
    if (coach.promptpayId || coach.qrAssetId) {
      const photo = await sendPhoto(chatId, `${baseUrl()}/c/${coach.handle}/pay/${pkg.id}`, esc(text), { silent: true });
      if (!photo.ok) await sendMessage(chatId, esc(text), { silent: true });
    } else await sendMessage(chatId, esc(text), { silent: true });
    return "student:tap:package_taken";
  } catch (e) {
    if (isDomainError(e)) {
      await put(chatId, editId, e.code === "has_package" ? s.tapHasPackage : e.code === "not_student" ? s.notStudent : s.offerGone, kb([]));
      return `student:tap:${e.code}`;
    }
    throw e;
  }
}

// ------------------------------------------------------------------ callbacks

/** Every tap this module answers. Free-form after the prefix; each branch reads its own segments. */
export const TAP_CALLBACK = /^(kb|kd|kt|kh|ky|kn|ko|kx|kz|km|kl|kq|kf|ks|kp|ke|kk|sb|sd|st|sh|sy|sw|sa|sm|sk):/;

export async function handleTapCallback(db: Db, cb: Cb, player: Player): Promise<string | null> {
  const data = cb.data ?? "";
  const m = /^([a-z]{2}):(.*)$/.exec(data);
  if (!m || !cb.message || !TAP_CALLBACK.test(data)) return null;
  const [, action, rest] = m;
  const seg = rest.split(":");
  const chatId = cb.message.chat.id;
  const editId = cb.message.message_id;
  const locale: CoachBotLocale = coachBotLocale(player.locale);
  const s = coachStrings(locale);
  const ok = () => answerCallbackQuery(cb.id).catch(() => undefined);

  if (action === "kz") {
    await ok();
    await deleteMessage(chatId, editId).catch(() => undefined);
    return "coach:tap:dismissed";
  }

  if (action[0] === "k") {
    const found = await getCoachForActor(db, player.id);
    if (!found) {
      await ok();
      return "coach:tap:not_coach";
    }
    const coach = found.coach;
    const coachPlayer = found.role === "coach" ? player : ((await getPlayerById(db, coach.playerId)) ?? player);
    await ok();
    switch (action) {
      case "kb": {
        const sid = unpackId(seg[0]);
        return sid ? afterWho(db, coach, sid, s, locale, chatId, editId) : "coach:tap:none";
      }
      case "kd": {
        const sid = unpackId(seg[0]);
        const minutes = Number(seg[1]) || coach.lessonMinutes;
        const week = seg[2] === "w1" ? 1 : 0;
        return sid ? coachDays(db, coach, sid, minutes, week, s, locale, chatId, editId) : "coach:tap:none";
      }
      case "kt": {
        const sid = unpackId(seg[0]);
        const day = fromYmd(seg[2] ?? "");
        return sid && day ? coachTimes(db, coach, sid, Number(seg[1]) || coach.lessonMinutes, day, s, locale, chatId, editId) : "coach:tap:none";
      }
      case "kh": {
        const sid = unpackId(seg[0]);
        return sid && seg[2] ? coachHeadsOrBook(db, coach, coachPlayer, sid, Number(seg[1]) || coach.lessonMinutes, fromEpochMin(seg[2]), s, locale, chatId, editId) : "coach:tap:none";
      }
      case "ky": {
        const sid = unpackId(seg[0]);
        return sid && seg[2] ? coachBook(db, coach, coachPlayer, sid, Number(seg[1]) || coach.lessonMinutes, fromEpochMin(seg[2]), Number(seg[3]) || 1, s, locale, chatId, editId) : "coach:tap:none";
      }
      case "kn": {
        await deleteMessage(chatId, editId).catch(() => undefined);
        await ask(chatId, s.tapAskName, "kn", "Anna");
        return "coach:tap:ask_name";
      }
      case "ko": {
        const sid = unpackId(seg[0]);
        const day = fromYmd(seg[2] ?? "");
        if (!sid || !day) return "coach:tap:none";
        await deleteMessage(chatId, editId).catch(() => undefined);
        await ask(chatId, s.tapAskTime(dayOnlyLabel(day, locale)), `ko:${seg[0]}:${seg[1]}:${seg[2]}`, "15:30");
        return "coach:tap:ask_time";
      }
      case "kx": {
        const lid = unpackId(seg[0]);
        const lesson = lid ? await getLesson(db, lid) : null;
        if (!lesson || lesson.coachId !== coach.id || lesson.status !== "booked") {
          await put(chatId, editId, s.nothingToCancel, kb([]));
          return "coach:tap:cancel_none";
        }
        const student = lesson.studentPlayerId ? await getPlayerById(db, lesson.studentPlayerId) : null;
        await put(chatId, editId, s.tapCancelAsk(student?.displayName ?? "?", whenLabel(lesson.startsAt, coach.tz, locale)), kb([[{ text: s.tapCancelYes, callback_data: `cu:${lesson.id}` }, { text: s.tapKeep, callback_data: "kz:" }]]));
        return "coach:tap:cancel_ask";
      }
      case "km": {
        const lid = unpackId(seg[0]);
        const lesson = lid ? await getLesson(db, lid) : null;
        if (!lesson || lesson.coachId !== coach.id || lesson.status !== "booked") {
          await put(chatId, editId, s.nothingToMove, kb([]));
          return "coach:tap:move_none";
        }
        const student = lesson.studentPlayerId ? await getPlayerById(db, lesson.studentPlayerId) : null;
        if (seg.length >= 3 && seg[2]) return moveOne(db, coach, { lessonId: lesson.id, startsAt: fromEpochMin(seg[2]), by: "coach" }, s, locale, chatId, editId);
        const day = seg[1] && !seg[1].startsWith("w") ? fromYmd(seg[1]) : null;
        if (day) {
          const rows = await timeRows(db, coach, day, lesson.minutes, (d) => `km:${seg[0]}:${seg[1]}:${epochMin(d)}`, { anyHour: true, locale });
          rows.push([{ text: s.tapBack, callback_data: `km:${seg[0]}` }]);
          await put(chatId, editId, rows.length > 1 ? s.tapWhichTime(dayOnlyLabel(day, locale)) : s.tapNoFree(dayOnlyLabel(day, locale)), kb(rows));
          return "coach:tap:move_time";
        }
        const week = seg[1] === "w1" ? 1 : 0;
        await put(chatId, editId, s.tapMoveWhere(student?.displayName ?? "?", whenLabel(lesson.startsAt, coach.tz, locale)), dayPicker(coach.tz, locale, week, (d) => `km:${seg[0]}:${ymd(d)}`, `km:${seg[0]}:w${week === 0 ? 1 : 0}`, s));
        return "coach:tap:move_day";
      }
      case "kl": {
        const lid = unpackId(seg[0]);
        return lid ? lessonCard(db, coach, lid, s, locale, chatId, editId) : "coach:tap:none";
      }
      case "kq": {
        const lid = unpackId(seg[0]);
        const lesson = lid ? await getLesson(db, lid) : null;
        if (!lesson || lesson.coachId !== coach.id) return "coach:tap:none";
        const student = lesson.studentPlayerId ? await getPlayerById(db, lesson.studentPlayerId) : null;
        const when = whenLabel(lesson.startsAt, coach.tz, locale);
        if (seg[1] === "u") {
          await unmarkNoShow(db, coach.id, lesson.id);
          await put(chatId, editId, s.tapCameDone(student?.displayName ?? "?", when), kb([]));
          return "coach:tap:came";
        }
        await markNoShow(db, coach.id, lesson.id);
        await put(chatId, editId, s.tapNoShowDone(student?.displayName ?? "?", when), kb([[{ text: s.tapCame, callback_data: `kq:${seg[0]}:u` }]]));
        return "coach:tap:no_show";
      }
      case "kf": {
        const lid = unpackId(seg[0]);
        const lesson = lid ? await getLesson(db, lid) : null;
        if (!lesson || lesson.coachId !== coach.id) return "coach:tap:none";
        try {
          await compLesson(db, { lessonId: lesson.id, coach });
        } catch (e) {
          if (!isDomainError(e)) throw e;
          await answerCallbackQuery(cb.id, s.markedPaid).catch(() => undefined);
          return "coach:tap:comp_refused";
        }
        const student = lesson.studentPlayerId ? await getPlayerById(db, lesson.studentPlayerId) : null;
        await put(chatId, editId, s.tapOnMeDone(student?.displayName ?? "?", whenLabel(lesson.startsAt, coach.tz, locale)), kb([]));
        return "coach:tap:comped";
      }
      case "ks": {
        if (!seg[0]) return tapStudents(db, coach, s, chatId, editId);
        const sid = unpackId(seg[0]);
        return sid ? studentCard(db, coach, sid, s, locale, chatId, editId) : "coach:tap:none";
      }
      case "kp": {
        const sid = unpackId(seg[0]);
        if (!sid) return "coach:tap:none";
        if (!seg[1]) return packagePicker(db, coach, sid, s, chatId, editId);
        if (seg[1] === "c") {
          const student = await getPlayerById(db, sid);
          await deleteMessage(chatId, editId).catch(() => undefined);
          await ask(chatId, s.tapAskPackage(student?.displayName ?? "?"), `kp:${seg[0]}`, "10 90d 6000");
          return "coach:tap:ask_package";
        }
        const offerId = unpackId(seg[1]);
        const offer = offerId ? (await listOffers(db, coach.id)).find((o) => o.id === offerId) : null;
        if (!offer) return "coach:tap:none";
        await deleteMessage(chatId, editId).catch(() => undefined);
        return packageMade(db, coach, sid, { size: offer.size, validDays: offer.validDays, amount: offer.price, minutes: offer.minutes, heads: offer.heads, offerId: offer.id }, s, locale, chatId);
      }
      case "kk": {
        if (!seg[0] || seg[0].startsWith("w")) return tapBlockDays(coach, s, locale, chatId, seg[0] === "w1" ? 1 : 0, editId);
        const day = fromYmd(seg[0]);
        if (!day) return "coach:tap:none";
        return seg[1] ? blockIt(db, coach, day, seg[1], s, locale, chatId, editId) : blockWhat(coach, day, s, locale, chatId, editId);
      }
      case "ke": {
        const [key, val] = seg;
        if (key === "lesson" && LESSON_MINUTES.includes(Number(val) as (typeof LESSON_MINUTES)[number])) await updateCoach(db, coach.id, { lessonMinutes: Number(val) });
        else if (key === "hours" && (val === "mornings" || val === "afternoons" || val === "both")) await updateCoach(db, coach.id, { hours: presetHours(val) });
        else if (key === "cutoff" && Number.isFinite(Number(val))) await updateCoach(db, coach.id, { cutoffHours: Number(val) });
        else if (key === "passes" && Number.isFinite(Number(val))) await updateCoach(db, coach.id, { latePasses: Number(val) });
        else return "coach:tap:none";
        const fresh = (await getCoachForActor(db, player.id))?.coach ?? coach;
        await tapSettings(db, fresh, player, s, locale, chatId, editId);
        return `coach:set:${key}`;
      }
    }
    return null;
  }

  // The student's side. The coach is read from the callback and checked against the list.
  if (action === "sm") {
    const lid = unpackId(seg[0]);
    const lesson = lid ? await getLesson(db, lid) : null;
    const owner = lesson ? (await studentCoaches(db, player.id)).find((x) => x.coach.id === lesson.coachId)?.coach : null;
    if (!lesson || !owner || lesson.studentPlayerId !== player.id || lesson.status !== "booked") {
      await ok();
      await put(chatId, editId, s.nothingToMove, kb([]));
      return "student:move:none";
    }
    await ok();
    if (seg.length >= 3 && seg[2]) return moveOne(db, owner, { lessonId: lesson.id, startsAt: fromEpochMin(seg[2]), by: "student", actorPlayerId: player.id }, s, locale, chatId, editId);
    const day = seg[1] && !seg[1].startsWith("w") ? fromYmd(seg[1]) : null;
    if (day) {
      const rows = await timeRows(db, owner, day, lesson.minutes, (d) => `sm:${seg[0]}:${seg[1]}:${epochMin(d)}`, { anyHour: false, locale });
      rows.push([{ text: s.tapBack, callback_data: `sm:${seg[0]}` }]);
      await put(chatId, editId, rows.length > 1 ? s.tapWhichTime(dayOnlyLabel(day, locale)) : s.tapNoFree(dayOnlyLabel(day, locale)), kb(rows));
      return "student:tap:move_time";
    }
    const week = seg[1] === "w1" ? 1 : 0;
    await put(chatId, editId, s.tapMoveWhere(s.withCoach(owner.displayName), whenLabel(lesson.startsAt, owner.tz, locale)), dayPicker(owner.tz, locale, week, (d) => `sm:${seg[0]}:${ymd(d)}`, `sm:${seg[0]}:w${week === 0 ? 1 : 0}`, s));
    return "student:tap:move_day";
  }
  const cid = unpackId(seg[0]);
  const mine = (await studentCoaches(db, player.id)).filter((x) => x.status === "accepted");
  const coach = mine.find((x) => x.coach.id === cid)?.coach;
  if (!coach || (await studentStatus(db, coach.id, player.id)) !== "accepted") {
    await answerCallbackQuery(cb.id, s.notStudent).catch(() => undefined);
    return "student:cb:not_student";
  }
  await ok();
  switch (action) {
    case "sb":
      return studentAfterCoach(db, player, coach, s, locale, chatId, editId);
    case "sd":
      return studentDays(db, player, coach, Number(seg[1]) || coach.lessonMinutes, seg[2] === "w1" ? 1 : 0, s, locale, chatId, editId);
    case "st": {
      const day = fromYmd(seg[2] ?? "");
      return day ? studentTimes(db, coach, Number(seg[1]) || coach.lessonMinutes, day, s, locale, chatId, editId) : "student:tap:none";
    }
    case "sh":
      return seg[2] ? studentHeadsOrBook(db, player, coach, Number(seg[1]) || coach.lessonMinutes, fromEpochMin(seg[2]), s, locale, chatId, editId) : "student:tap:none";
    case "sy":
      return seg[2] ? studentBook(db, player, coach, Number(seg[1]) || coach.lessonMinutes, fromEpochMin(seg[2]), Number(seg[3]) || 1, s, locale, chatId, editId) : "student:tap:none";
    case "sw": {
      const day = fromYmd(seg[1] ?? "");
      if (!day) return "student:tap:none";
      const week = weekStartOf(new Date(`${day}T12:00:00Z`), "UTC");
      try {
        await joinWaitlist(db, coach, player.id, { slotStartsAt: null, weekStart: week });
        await put(chatId, editId, s.waitlistedWeek(dayOnlyLabel(week, locale)), kb([]));
        return "student:tap:waitlisted";
      } catch (e) {
        if (!isDomainError(e)) throw e;
        await put(chatId, editId, s.past, kb([]));
        return "student:tap:wait_refused";
      }
    }
    case "sa": {
      const day = fromYmd(seg[1] ?? "");
      if (!day) return "student:tap:none";
      await deleteMessage(chatId, editId).catch(() => undefined);
      await ask(chatId, s.tapAskAnotherTime(dayOnlyLabel(day, locale)), `sa:${seg[0]}:${seg[1]}`, "19:30");
      return "student:tap:ask_time";
    }
    case "sk":
      if (!seg[1]) return packagesFor(db, coach, s, chatId, editId);
      return unpackId(seg[1]) ? takePackage(db, player, coach, unpackId(seg[1])!, s, chatId, editId) : "student:tap:none";
  }
  return null;
}

// ------------------------------------------------------------------ the typed step, as a reply

const PKG_RE = /^\+?\s*(\d{1,3})(?:\s+(\d{1,3})\s*[dд])?(?:\s+(\d{2,7}))?\s*$/;

/**
 * A reply to one of the prompts above: a name, a time or a package line. The prompt's last line says
 * which flow it belongs to and where it was, so nothing is remembered between messages. Null when the
 * message is not such a reply, so the one-line grammar reads it instead.
 */
export async function continueTap(db: Db, msg: TgMessage, player: Player, resolved: ResolvedRole): Promise<string | null> {
  const parent = msg.reply_to_message;
  const botId = telegramBotId();
  if (!parent?.text || !msg.text || !botId || String(parent.from?.id) !== botId) return null;
  const t = /↳ (kn|ko|kp|sa)(?::(\S+))?\s*$/.exec(parent.text);
  if (!t) return null;
  const [, code, restRaw] = t;
  const seg = (restRaw ?? "").split(":");
  const chatId = msg.chat.id;
  const locale: CoachBotLocale = coachBotLocale(player.locale);
  const s = coachStrings(locale);
  const text = msg.text.trim();

  if (code === "sa") {
    if (resolved?.kind !== "student") return null;
    const cid = unpackId(seg[0]);
    const day = fromYmd(seg[1] ?? "");
    const coach = resolved.coaches.find((c) => c.coach.id === cid && c.status === "accepted")?.coach;
    if (!coach || !day) return null;
    const time = parseTypedTime(text);
    if (!time) {
      await ask(chatId, s.tapBadTime, `sa:${seg[0]}:${seg[1]}`, "19:30");
      return "student:tap:bad_time";
    }
    await deleteMessage(chatId, parent.message_id).catch(() => undefined);
    const at = zonedTimeToUtc(day, time, coach.tz);
    try {
      const r = await requestOrBook(db, coach, player.id, at, null);
      if (r.kind === "booked") {
        await notifyLessonBooked(db, { lesson: r.lesson, coach, student: player, pkg: r.package, by: "student" });
        await sendMessage(chatId, esc(s.youBooked(coach.displayName, whenLabel(r.lesson.startsAt, coach.tz, locale), pkgText(s, r.package))), { silent: true, keyboard: kb([[{ text: s.cancel, callback_data: `lc:${r.lesson.id}` }]]) });
        return "student:booked";
      }
      await notifyRequest(db, coach, player, r.request).catch(() => undefined);
      await sendMessage(chatId, esc(s.tapAskedCoach(coach.displayName, whenLabel(at, coach.tz, locale))), { silent: true });
      return "student:tap:requested";
    } catch (e) {
      if (!isDomainError(e)) throw e;
      await sendMessage(chatId, esc(e.code === "past" ? s.past : e.code === "slot_taken" ? s.moveTaken : s.notStudent), { silent: true });
      return `student:tap:${e.code}`;
    }
  }

  if (resolved?.kind !== "coach") return null;
  const coach = resolved.coach;
  const coachPlayer = resolved.role === "coach" ? player : ((await getPlayerById(db, coach.playerId)) ?? player);
  if (code === "kn") {
    const name = text.replace(/\s+/g, " ").slice(0, 40);
    if (!name) return null;
    await deleteMessage(chatId, parent.message_id).catch(() => undefined);
    const p = await addStudentByName(db, coach.id, name, locale);
    await sendMessage(chatId, esc(s.bookedNew(p.displayName)), { silent: true });
    return afterWho(db, coach, p.id, s, locale, chatId, null);
  }
  if (code === "ko") {
    const sid = unpackId(seg[0]);
    const day = fromYmd(seg[2] ?? "");
    if (!sid || !day) return null;
    const time = parseTypedTime(text);
    if (!time) {
      await ask(chatId, s.tapBadTime, `ko:${seg[0]}:${seg[1]}:${seg[2]}`, "15:30");
      return "coach:tap:bad_time";
    }
    await deleteMessage(chatId, parent.message_id).catch(() => undefined);
    return coachHeadsOrBook(db, coach, coachPlayer, sid, Number(seg[1]) || coach.lessonMinutes, zonedTimeToUtc(day, time, coach.tz), s, locale, chatId, null);
  }
  if (code === "kp") {
    const sid = unpackId(seg[0]);
    if (!sid) return null;
    const m = PKG_RE.exec(text);
    if (!m) {
      await ask(chatId, s.tapBadPackage, `kp:${seg[0]}`, "10 90d 6000");
      return "coach:tap:bad_package";
    }
    await deleteMessage(chatId, parent.message_id).catch(() => undefined);
    return packageMade(db, coach, sid, { size: Number(m[1]), validDays: m[2] ? Number(m[2]) : 90, amount: m[3] ? Number(m[3]) : null }, s, locale, chatId);
  }
  return null;
}

export { packageLine };
