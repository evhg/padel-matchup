import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { coaches, coachManagers, lessonPackages, lessonRequests, lessons, lessonWaitlist, players, type Coach, type Lesson, type LessonPackage, type LessonRequest, type LessonWaitlistRow, type Player } from "@/db/schema";
import { utcToZonedParts } from "@/lib/dates";
import { availableSlots, bookLesson, busyBetween, DAY_MS, getPlayerById, HOUR_MS, isPackageOpen, packageLine, studentStatus, withinHours } from "@/lib/domain/coaching";
import { DomainError, isDomainError } from "@/lib/domain/errors";

/**
 * What happens between lessons without the coach lifting a finger:
 *  - a freed slot goes to the first student waiting for it (or for that week), theirs for thirty minutes, then the next;
 *  - a lesson the coach cancels comes with the nearest free times for the student to tap;
 *  - a time outside the coach's hours becomes a request the coach answers yes or no, once;
 *  - one reminder the evening before, one note when a package is nearly out;
 *  - a manager link so the person who runs the coach's bookings can, and a monthly count.
 */

export const OFFER_MINUTES = 30;
export const REMIND_HOURS_BEFORE = 20;
export const LOW_LEFT = 2;
export const LOW_DAYS = 7;

export const epochMin = (d: Date) => Math.floor(d.getTime() / 60_000).toString(36);
export const fromEpochMin = (s: string) => new Date(parseInt(s, 36) * 60_000);

const overlaps = (aStart: number, aEnd: number, b: { startsAt: Date; endsAt: Date }) => aStart < b.endsAt.getTime() && aEnd > b.startsAt.getTime();

/** Monday of the week that holds `at`, as YYYY-MM-DD in the coach's zone. */
export function weekStartOf(at: Date, tz: string): string {
  const day = utcToZonedParts(at, tz).date;
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * DAY_MS).toISOString().slice(0, 10);
}

async function slotIsFree(db: Db, coach: Coach, startsAt: Date, now: Date): Promise<boolean> {
  if (startsAt.getTime() <= now.getTime()) return false;
  const end = new Date(startsAt.getTime() + coach.lessonMinutes * 60_000);
  const busy = await busyBetween(db, coach.id, startsAt, end);
  return !busy.some((b) => overlaps(startsAt.getTime(), end.getTime(), b));
}

// ---------------------------------------------------------------- waitlist

export type WaitlistWant = { slotStartsAt?: Date | null; weekStart?: string | null };

/** A student asks to be told when a slot, or any slot in a week, frees up. One entry per want. */
export async function joinWaitlist(db: Db, coach: Coach, studentPlayerId: string, want: WaitlistWant, now = new Date()): Promise<LessonWaitlistRow> {
  if ((await studentStatus(db, coach.id, studentPlayerId)) !== "accepted") throw new DomainError("not_student");
  const slot = want.slotStartsAt ? new Date(Math.floor(want.slotStartsAt.getTime() / 60_000) * 60_000) : null;
  const week = !slot && want.weekStart && /^\d{4}-\d{2}-\d{2}$/.test(want.weekStart) ? want.weekStart : null;
  if (!slot && !week) throw new DomainError("invalid", "want");
  if (slot && slot.getTime() <= now.getTime()) throw new DomainError("past");
  if (week && new Date(`${week}T00:00:00Z`).getTime() + 7 * DAY_MS < now.getTime()) throw new DomainError("past");
  const [existing] = await db
    .select()
    .from(lessonWaitlist)
    .where(and(eq(lessonWaitlist.coachId, coach.id), eq(lessonWaitlist.studentPlayerId, studentPlayerId), inArray(lessonWaitlist.status, ["waiting", "offered"]), slot ? eq(lessonWaitlist.slotStartsAt, slot) : and(isNull(lessonWaitlist.slotStartsAt), eq(lessonWaitlist.weekStart, week!))))
    .limit(1);
  if (existing) return existing;
  const [row] = await db.insert(lessonWaitlist).values({ coachId: coach.id, studentPlayerId, slotStartsAt: slot, weekStart: week, status: "waiting", createdAt: now }).returning();
  return row;
}

export async function getWaitlistEntry(db: Db, entryId: string): Promise<{ entry: LessonWaitlistRow; coach: Coach } | null> {
  const [row] = await db.select({ entry: lessonWaitlist, coach: coaches }).from(lessonWaitlist).innerJoin(coaches, eq(coaches.id, lessonWaitlist.coachId)).where(eq(lessonWaitlist.id, entryId)).limit(1);
  return row ?? null;
}

export async function withdrawWaitlist(db: Db, coachId: string, entryId: string, studentPlayerId?: string | null, now = new Date()): Promise<LessonWaitlistRow | null> {
  const [row] = await db
    .update(lessonWaitlist)
    .set({ status: "withdrawn", resolvedAt: now })
    .where(and(eq(lessonWaitlist.id, entryId), eq(lessonWaitlist.coachId, coachId), inArray(lessonWaitlist.status, ["waiting", "offered"]), ...(studentPlayerId ? [eq(lessonWaitlist.studentPlayerId, studentPlayerId)] : [])))
    .returning();
  return row ?? null;
}

export type WaitlistEntry = LessonWaitlistRow & { player: Player };

/** Everyone waiting on a coach, soonest want first: what the coach sees under "waiting". */
export async function listWaitlist(db: Db, coachId: string, now = new Date()): Promise<WaitlistEntry[]> {
  const rows = await db
    .select({ entry: lessonWaitlist, player: players })
    .from(lessonWaitlist)
    .innerJoin(players, eq(players.id, lessonWaitlist.studentPlayerId))
    .where(and(eq(lessonWaitlist.coachId, coachId), inArray(lessonWaitlist.status, ["waiting", "offered"]), or(gt(lessonWaitlist.slotStartsAt, now), and(isNull(lessonWaitlist.slotStartsAt), gte(lessonWaitlist.weekStart, new Date(now.getTime() - 7 * DAY_MS).toISOString().slice(0, 10))))))
    .orderBy(asc(lessonWaitlist.createdAt));
  return rows.map((r) => ({ ...r.entry, player: r.player }));
}

export async function studentWaitlist(db: Db, coachId: string, studentPlayerId: string, now = new Date()): Promise<LessonWaitlistRow[]> {
  return (await listWaitlist(db, coachId, now)).filter((e) => e.studentPlayerId === studentPlayerId);
}

export type Offer = { entry: LessonWaitlistRow; player: Player; startsAt: Date; expiresAt: Date };

/**
 * A slot is free: the first student waiting for exactly it, then the first waiting for that week,
 * gets it for thirty minutes. Nobody is offered a time they already have a lesson at.
 */
export async function offerFreedSlot(db: Db, coach: Coach, startsAt: Date, now = new Date()): Promise<Offer | null> {
  if (!(await slotIsFree(db, coach, startsAt, now))) return null;
  const week = weekStartOf(startsAt, coach.tz);
  const candidates = await db
    .select()
    .from(lessonWaitlist)
    .where(and(eq(lessonWaitlist.coachId, coach.id), eq(lessonWaitlist.status, "waiting"), or(eq(lessonWaitlist.slotStartsAt, startsAt), and(isNull(lessonWaitlist.slotStartsAt), eq(lessonWaitlist.weekStart, week)))))
    .orderBy(asc(lessonWaitlist.createdAt));
  const exact = candidates.filter((c) => c.slotStartsAt);
  const weekly = candidates.filter((c) => !c.slotStartsAt);
  if (weekly.length && !withinHours(coach, startsAt, coach.lessonMinutes)) weekly.length = 0;
  const end = new Date(startsAt.getTime() + coach.lessonMinutes * 60_000);
  for (const entry of [...exact, ...weekly]) {
    if ((await studentStatus(db, coach.id, entry.studentPlayerId)) !== "accepted") continue;
    const clash = await db
      .select({ id: lessons.id })
      .from(lessons)
      .where(and(eq(lessons.studentPlayerId, entry.studentPlayerId), eq(lessons.status, "booked"), lt(lessons.startsAt, end), gt(sql`${lessons.startsAt} + make_interval(mins => ${lessons.minutes})`, startsAt)))
      .limit(1);
    if (clash.length) continue;
    const player = await getPlayerById(db, entry.studentPlayerId);
    if (!player) continue;
    const expiresAt = new Date(now.getTime() + OFFER_MINUTES * 60_000);
    const [updated] = await db
      .update(lessonWaitlist)
      .set({ status: "offered", offeredAt: now, offerExpiresAt: expiresAt, slotStartsAt: startsAt })
      .where(and(eq(lessonWaitlist.id, entry.id), eq(lessonWaitlist.status, "waiting")))
      .returning();
    if (!updated) continue;
    return { entry: updated, player, startsAt, expiresAt };
  }
  return null;
}

/** The student taps "book it" on an offer, in the chat or on the page. */
export async function acceptOffer(db: Db, coach: Coach, entryId: string, studentPlayerId: string, now = new Date()): Promise<{ lesson: Lesson; package: LessonPackage | null }> {
  const [entry] = await db.select().from(lessonWaitlist).where(and(eq(lessonWaitlist.id, entryId), eq(lessonWaitlist.coachId, coach.id), eq(lessonWaitlist.studentPlayerId, studentPlayerId))).limit(1);
  if (!entry || !entry.slotStartsAt) throw new DomainError("not_found");
  if (entry.status !== "offered" || !entry.offerExpiresAt || entry.offerExpiresAt.getTime() < now.getTime()) throw new DomainError("cancelled");
  try {
    const booked = await bookLesson(db, { coach, studentPlayerId, startsAt: entry.slotStartsAt, byCoach: true, source: "waitlist", createdByPlayerId: studentPlayerId }, now);
    await db.update(lessonWaitlist).set({ status: "booked", offeredLessonId: booked.lesson.id, resolvedAt: now }).where(eq(lessonWaitlist.id, entry.id));
    return booked;
  } catch (e) {
    if (isDomainError(e) && e.code === "slot_taken") await db.update(lessonWaitlist).set({ status: "expired", resolvedAt: now }).where(eq(lessonWaitlist.id, entry.id));
    throw e;
  }
}

export type Lapsed = { entry: LessonWaitlistRow; player: Player | null; coach: Coach; startsAt: Date };

/** Offers past their thirty minutes lapse; each freed slot is offered to the next in line. */
export async function tickWaitlist(db: Db, now = new Date()): Promise<{ lapsed: Lapsed[]; offers: (Offer & { coach: Coach })[] }> {
  const stale = await db.select().from(lessonWaitlist).where(and(eq(lessonWaitlist.status, "offered"), lt(lessonWaitlist.offerExpiresAt, now)));
  const lapsed: Lapsed[] = [];
  const offers: (Offer & { coach: Coach })[] = [];
  const coachCache = new Map<string, Coach>();
  for (const entry of stale) {
    const [updated] = await db
      .update(lessonWaitlist)
      .set({ status: "expired", resolvedAt: now, slotStartsAt: entry.weekStart ? null : entry.slotStartsAt })
      .where(and(eq(lessonWaitlist.id, entry.id), eq(lessonWaitlist.status, "offered")))
      .returning();
    if (!updated || !entry.slotStartsAt) continue;
    let coach = coachCache.get(entry.coachId);
    if (!coach) {
      [coach] = await db.select().from(coaches).where(eq(coaches.id, entry.coachId)).limit(1);
      if (!coach) continue;
      coachCache.set(coach.id, coach);
    }
    lapsed.push({ entry: updated, player: await getPlayerById(db, entry.studentPlayerId), coach, startsAt: entry.slotStartsAt });
    const next = await offerFreedSlot(db, coach, entry.slotStartsAt, now);
    if (next) offers.push({ ...next, coach });
  }
  return { lapsed, offers };
}

// ---------------------------------------------------------------- the chain after a cancellation

/** The nearest free times to a lost lesson, same day first, within a week. */
export async function alternativesFor(db: Db, coach: Coach, lostAt: Date, now = new Date(), count = 3): Promise<Date[]> {
  const from = now;
  const to = new Date(Math.max(lostAt.getTime(), now.getTime()) + 7 * DAY_MS);
  const free = await availableSlots(db, coach, from, to, now);
  const lostDay = utcToZonedParts(lostAt, coach.tz).date;
  return free
    .map((d) => ({ d, score: Math.abs(d.getTime() - lostAt.getTime()) + (utcToZonedParts(d, coach.tz).date === lostDay ? 0 : 6 * HOUR_MS) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, count)
    .map((x) => x.d)
    .sort((a, b) => a.getTime() - b.getTime());
}

export type Freed = { alternatives: Date[]; offer: Offer | null };

/** Every cancellation path ends here: alternatives for the student when the coach cancelled, the slot to the waitlist. */
export async function afterLessonFreed(db: Db, coach: Coach, lesson: Lesson, by: "coach" | "student", now = new Date()): Promise<Freed> {
  const alternatives = by === "coach" && lesson.studentPlayerId ? await alternativesFor(db, coach, lesson.startsAt, now) : [];
  const offer = await offerFreedSlot(db, coach, lesson.startsAt, now).catch(() => null);
  return { alternatives, offer };
}

// ---------------------------------------------------------------- requests outside the hours

/** Books when the rules allow; otherwise a request the coach answers. Never both. */
export async function requestOrBook(db: Db, coach: Coach, studentPlayerId: string, startsAt: Date, note: string | null, now = new Date()): Promise<{ kind: "booked"; lesson: Lesson; package: LessonPackage | null } | { kind: "requested"; request: LessonRequest }> {
  try {
    const booked = await bookLesson(db, { coach, studentPlayerId, startsAt, byCoach: false, source: "web", createdByPlayerId: studentPlayerId, note }, now);
    return { kind: "booked", ...booked };
  } catch (e) {
    if (!isDomainError(e) || !["outside_hours", "too_soon"].includes(e.code)) throw e;
  }
  if ((await studentStatus(db, coach.id, studentPlayerId)) !== "accepted") throw new DomainError("not_student");
  const at = new Date(Math.floor(startsAt.getTime() / 60_000) * 60_000);
  if (at.getTime() <= now.getTime()) throw new DomainError("past");
  if (!(await slotIsFree(db, coach, at, now))) throw new DomainError("slot_taken");
  const [existing] = await db.select().from(lessonRequests).where(and(eq(lessonRequests.coachId, coach.id), eq(lessonRequests.studentPlayerId, studentPlayerId), eq(lessonRequests.startsAt, at), eq(lessonRequests.status, "open"))).limit(1);
  if (existing) return { kind: "requested", request: existing };
  const [request] = await db.insert(lessonRequests).values({ coachId: coach.id, studentPlayerId, startsAt: at, minutes: coach.lessonMinutes, note: note?.trim().slice(0, 200) || null, status: "open", createdAt: now }).returning();
  return { kind: "requested", request };
}

export type RequestRow = LessonRequest & { player: Player };

export async function listOpenRequests(db: Db, coachId: string, now = new Date()): Promise<RequestRow[]> {
  const rows = await db
    .select({ request: lessonRequests, player: players })
    .from(lessonRequests)
    .innerJoin(players, eq(players.id, lessonRequests.studentPlayerId))
    .where(and(eq(lessonRequests.coachId, coachId), eq(lessonRequests.status, "open"), gt(lessonRequests.startsAt, now)))
    .orderBy(asc(lessonRequests.startsAt));
  return rows.map((r) => ({ ...r.request, player: r.player }));
}

export async function studentRequests(db: Db, coachId: string, studentPlayerId: string, now = new Date()): Promise<LessonRequest[]> {
  return db
    .select()
    .from(lessonRequests)
    .where(and(eq(lessonRequests.coachId, coachId), eq(lessonRequests.studentPlayerId, studentPlayerId), eq(lessonRequests.status, "open"), gt(lessonRequests.startsAt, now)))
    .orderBy(asc(lessonRequests.startsAt));
}

/** The coach's one tap. Yes books it as the coach would; no closes it. A time taken meanwhile is a no. */
export async function decideRequest(db: Db, coach: Coach, requestId: string, accept: boolean, now = new Date()): Promise<{ request: LessonRequest; lesson: Lesson | null; package: LessonPackage | null }> {
  const [request] = await db.select().from(lessonRequests).where(and(eq(lessonRequests.id, requestId), eq(lessonRequests.coachId, coach.id))).limit(1);
  if (!request) throw new DomainError("not_found");
  if (request.status !== "open") throw new DomainError("cancelled");
  let lesson: Lesson | null = null;
  let pkg: LessonPackage | null = null;
  let status: "accepted" | "declined" = accept ? "accepted" : "declined";
  if (accept) {
    try {
      const booked = await bookLesson(db, { coach, studentPlayerId: request.studentPlayerId, startsAt: request.startsAt, byCoach: true, source: "request", createdByPlayerId: coach.playerId, minutes: request.minutes, note: request.note }, now);
      lesson = booked.lesson;
      pkg = booked.package;
    } catch (e) {
      if (!isDomainError(e) || !["slot_taken", "past"].includes(e.code)) throw e;
      status = "declined";
    }
  }
  const [updated] = await db.update(lessonRequests).set({ status, lessonId: lesson?.id ?? null, resolvedAt: now }).where(eq(lessonRequests.id, request.id)).returning();
  return { request: updated, lesson, package: pkg };
}

export async function expireRequests(db: Db, now = new Date()): Promise<number> {
  const rows = await db.update(lessonRequests).set({ status: "expired", resolvedAt: now }).where(and(eq(lessonRequests.status, "open"), lte(lessonRequests.startsAt, now))).returning({ id: lessonRequests.id });
  return rows.length;
}

// ---------------------------------------------------------------- reminders

export type LessonReminder = { lesson: Lesson; coach: Coach; student: Player };

/**
 * One reminder per lesson, about twenty hours before. A lesson booked inside that window
 * is marked as reminded without a message: the booking itself was the reminder.
 */
export async function lessonRemindersDue(db: Db, now = new Date()): Promise<LessonReminder[]> {
  const horizon = new Date(now.getTime() + REMIND_HOURS_BEFORE * HOUR_MS);
  const rows = await db
    .select({ lesson: lessons, coach: coaches })
    .from(lessons)
    .innerJoin(coaches, eq(coaches.id, lessons.coachId))
    .where(and(eq(lessons.status, "booked"), isNull(lessons.remindedAt), gt(lessons.startsAt, now), lte(lessons.startsAt, horizon)))
    .orderBy(asc(lessons.startsAt))
    .limit(200);
  const out: LessonReminder[] = [];
  for (const r of rows) {
    const [claimed] = await db.update(lessons).set({ remindedAt: now }).where(and(eq(lessons.id, r.lesson.id), isNull(lessons.remindedAt))).returning();
    if (!claimed) continue;
    const bookedInsideWindow = r.lesson.createdAt.getTime() > r.lesson.startsAt.getTime() - (REMIND_HOURS_BEFORE + 2) * HOUR_MS;
    const soon = r.lesson.startsAt.getTime() - now.getTime() < HOUR_MS;
    if (bookedInsideWindow || soon || !r.lesson.studentPlayerId) continue;
    const student = await getPlayerById(db, r.lesson.studentPlayerId);
    if (student) out.push({ lesson: claimed, coach: r.coach, student });
  }
  return out;
}

export type LowPackageNotice = { pkg: LessonPackage; coach: Coach; student: Player; left: number; daysLeft: number | null };

/** One note per package when it is nearly out or nearly expired, to the student. */
export async function lowPackageNoticesDue(db: Db, now = new Date()): Promise<LowPackageNotice[]> {
  const rows = await db
    .select({ pkg: lessonPackages, coach: coaches, student: players })
    .from(lessonPackages)
    .innerJoin(coaches, eq(coaches.id, lessonPackages.coachId))
    .innerJoin(players, eq(players.id, lessonPackages.studentPlayerId))
    .where(and(isNull(lessonPackages.closedAt), isNull(lessonPackages.lowRemindedAt), gt(lessonPackages.used, 0)))
    .limit(500);
  const out: LowPackageNotice[] = [];
  for (const r of rows) {
    if (!isPackageOpen(r.pkg, now)) continue;
    const line = packageLine(r.pkg, now);
    const low = line.left <= LOW_LEFT || (line.daysLeft !== null && line.daysLeft <= LOW_DAYS);
    if (!low) continue;
    const [claimed] = await db.update(lessonPackages).set({ lowRemindedAt: now }).where(and(eq(lessonPackages.id, r.pkg.id), isNull(lessonPackages.lowRemindedAt))).returning();
    if (!claimed) continue;
    out.push({ pkg: claimed, coach: r.coach, student: r.student, left: line.left, daysLeft: line.daysLeft });
  }
  return out;
}

// ---------------------------------------------------------------- managers

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");

/** The link a coach hands the person who runs their bookings. Made once, kept until renewed. */
export async function managerCode(db: Db, coachId: string, renew = false): Promise<string> {
  const [row] = await db.select({ code: coaches.managerCode }).from(coaches).where(eq(coaches.id, coachId)).limit(1);
  if (row?.code && !renew) return row.code;
  const code = newCode();
  await db.update(coaches).set({ managerCode: code, updatedAt: new Date() }).where(eq(coaches.id, coachId));
  return code;
}

/** Opening the link as a signed-in player makes them a manager. The coach is told. */
export async function claimManager(db: Db, code: string, playerId: string): Promise<Coach> {
  const clean = code.trim().toLowerCase();
  if (!/^[a-z0-9]{6,12}$/.test(clean)) throw new DomainError("not_found");
  const [coach] = await db.select().from(coaches).where(and(eq(coaches.managerCode, clean), isNull(coaches.archivedAt))).limit(1);
  if (!coach) throw new DomainError("not_found");
  if (coach.playerId === playerId) return coach;
  await db.insert(coachManagers).values({ coachId: coach.id, playerId }).onConflictDoNothing();
  return coach;
}

export async function listManagers(db: Db, coachId: string): Promise<Player[]> {
  const rows = await db.select({ player: players }).from(coachManagers).innerJoin(players, eq(players.id, coachManagers.playerId)).where(eq(coachManagers.coachId, coachId)).orderBy(asc(coachManagers.createdAt));
  return rows.map((r) => r.player);
}

export async function removeManager(db: Db, coachId: string, playerId: string): Promise<void> {
  await db.delete(coachManagers).where(and(eq(coachManagers.coachId, coachId), eq(coachManagers.playerId, playerId)));
}

// ---------------------------------------------------------------- the month

export type MonthCount = { done: number; noShows: number; cancelledByCoach: number; lateCancelled: number; students: number; perStudent: { playerId: string; done: number; noShows: number }[] };

/** Lessons in a month, the way a coach counts them at the end of it. */
export async function monthCounts(db: Db, coachId: string, from: Date, to: Date): Promise<MonthCount> {
  const rows = await db
    .select({ studentPlayerId: lessons.studentPlayerId, status: lessons.status, n: sql<number>`count(*)::int` })
    .from(lessons)
    .where(and(eq(lessons.coachId, coachId), gte(lessons.startsAt, from), lt(lessons.startsAt, to), ne(lessons.status, "booked")))
    .groupBy(lessons.studentPlayerId, lessons.status);
  const out: MonthCount = { done: 0, noShows: 0, cancelledByCoach: 0, lateCancelled: 0, students: 0, perStudent: [] };
  const per = new Map<string, { done: number; noShows: number }>();
  for (const r of rows) {
    const n = Number(r.n);
    if (r.status === "done") out.done += n;
    else if (r.status === "no_show") out.noShows += n;
    else if (r.status === "cancelled") out.cancelledByCoach += n;
    else if (r.status === "late_cancelled") out.lateCancelled += n;
    if (r.studentPlayerId && (r.status === "done" || r.status === "no_show")) {
      const cur = per.get(r.studentPlayerId) ?? { done: 0, noShows: 0 };
      if (r.status === "done") cur.done += n;
      else cur.noShows += n;
      per.set(r.studentPlayerId, cur);
    }
  }
  out.perStudent = [...per.entries()].map(([playerId, v]) => ({ playerId, ...v })).sort((a, b) => b.done - a.done);
  out.students = out.perStudent.filter((p) => p.done > 0).length;
  return out;
}

/** [first of this month, first of next month) in the coach's zone. */
export function monthRange(tz: string, now = new Date()): { from: Date; to: Date; label: string } {
  const { date } = utcToZonedParts(now, tz);
  const [y, m] = date.split("-").map(Number);
  const first = `${y}-${String(m).padStart(2, "0")}-01`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const next = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
  const off = (d: string) => new Date(new Date(`${d}T00:00:00Z`).getTime() - (new Date(`${d}T00:00:00Z`).getTime() - zonedMidnight(d, tz)));
  return { from: off(first), to: off(next), label: first.slice(0, 7) };
}

function zonedMidnight(dateStr: string, tz: string): number {
  const naive = new Date(`${dateStr}T00:00:00Z`).getTime();
  const wall = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(naive));
  const p = Object.fromEntries(wall.map((x) => [x.type, x.value]));
  const seen = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
  return naive - (seen - naive);
}
