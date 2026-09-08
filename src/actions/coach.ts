"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { coaches, lessons } from "@/db/schema";
import { isValidTimeZone, zonedTimeToUtc } from "@/lib/dates";
import {
  addStudentByName,
  bookLesson,
  cancelLesson,
  createCoach,
  createPackage,
  extendPackage,
  getCoachByHandle,
  getCoachForActor,
  getPlayerById,
  LESSON_MINUTES,
  listStudents,
  markNoShow,
  parseHoursLine,
  presetHours,
  removeCoachQr,
  requestStudent,
  setCoachQr,
  setPackagePaid,
  setStudentStatus,
  studentStatus,
  updateCoach,
  type CancelOutcome,
  type Hours,
  type HoursPreset,
  type StudentStatus,
} from "@/lib/domain/coaching";
import { DomainError } from "@/lib/domain/errors";
import { checkCalendarAccess, type CalendarAccess } from "@/lib/coach/gcal";
import { fetchSheet, importPackages, looksLikeLink, parsePackageSheet, sheetCsvUrl, type ImportOutcome, type ImportRow } from "@/lib/coach/import";
import { notifyLessonBooked, notifyLessonCancelled, notifyStudentAccepted, notifyStudentInvited, notifyStudentRequest } from "@/lib/coach/notify";
import { cleanCalendarSettings, setCoachCalendar, syncGoogleCalendar, syncIcal } from "@/lib/coach/sync";
import { acceptOffer, afterLessonFreed, claimManager, decideRequest, joinWaitlist, managerCode, removeManager, requestOrBook, withdrawWaitlist } from "@/lib/coach/chains";
import { notifyManagerJoined, notifyOffer, notifyRequest, notifyRequestDecided } from "@/lib/coach/notify";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, requirePlayer, runA, type ActionResult } from "./shared";

/** The coach's book: every action here is one tap on a coach screen or a student screen. */

async function requireCoach(db: Awaited<ReturnType<typeof getDb>>) {
  const me = await getSessionPlayer(db);
  if (!me) throw new ActionFailure("no_identity");
  const found = await getCoachForActor(db, me.id);
  if (!found) throw new ActionFailure("no_coach");
  return { me, coach: found.coach, role: found.role };
}

const revalidateCoach = (handle: string) => {
  revalidatePath("/coach");
  revalidatePath("/coach/students");
  revalidatePath("/coach/settings");
  revalidatePath(`/c/${handle}`);
  revalidatePath("/me");
};

export async function setupCoachAction(input: { name?: string | null; clubs: string; minutes: number; preset: HoursPreset | "custom"; tz?: string | null }): Promise<ActionResult<{ handle: string }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await requirePlayer(db, input.name);
    const locale = await getLocale();
    const tz = input.tz && isValidTimeZone(input.tz) ? input.tz : "Asia/Bangkok";
    const hours: Hours = input.preset === "custom" ? presetHours("both") : presetHours(input.preset);
    const coach = await createCoach(db, { playerId: me.id, displayName: me.displayName, clubNames: input.clubs, lessonMinutes: input.minutes, hours, tz, languages: [locale] });
    revalidateCoach(coach.handle);
    return { handle: coach.handle };
  });
}

export type SettingsInput = {
  displayName: string;
  clubs: string;
  lessonMinutes: number;
  /** Seven lines, index 0 = Sunday, in the coach's words ("07:00-12:00, 15:00-20:00" or "off"). */
  hoursLines: string[];
  cutoffHours: number;
  latePasses: number;
  minNoticeHours: number;
  promptpayId: string;
  payLink: string;
  whatsapp: string;
  isPublic: boolean;
  tz: string;
};

export async function saveCoachSettingsAction(input: SettingsInput): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    const hours: Hours = {};
    for (let d = 0; d < 7; d++) {
      const ranges = parseHoursLine(input.hoursLines[d] ?? "");
      if (!ranges) throw new DomainError("invalid", String(d));
      hours[String(d)] = ranges;
    }
    if (!LESSON_MINUTES.includes(input.lessonMinutes as (typeof LESSON_MINUTES)[number])) throw new DomainError("invalid", "minutes");
    if (!isValidTimeZone(input.tz)) throw new DomainError("invalid", "tz");
    await updateCoach(db, coach.id, {
      displayName: input.displayName,
      clubNames: input.clubs.split(/[,;\n]+/),
      lessonMinutes: input.lessonMinutes,
      hours,
      cutoffHours: input.cutoffHours,
      latePasses: input.latePasses,
      minNoticeHours: input.minNoticeHours,
      promptpayId: input.promptpayId,
      payLink: input.payLink,
      whatsapp: input.whatsapp,
      isPublic: Boolean(input.isPublic),
      tz: input.tz,
    });
    revalidateCoach(coach.handle);
    return null;
  });
}

/** The coach's own bank QR as a data URL from the file input; stored small, served from /c/handle/qr. */
export async function uploadQrAction(dataUrl: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? "");
    if (!m) throw new DomainError("invalid", "mime");
    await setCoachQr(db, coach.id, m[1], m[2]);
    revalidateCoach(coach.handle);
    return null;
  });
}

export async function removeQrAction(): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    await removeCoachQr(db, coach.id);
    revalidateCoach(coach.handle);
    return null;
  });
}

/** Either an exact instant (a slot chip) or a day and a wall-clock time in the coach's zone (typed). */
export async function coachBookAction(input: { studentPlayerId?: string | null; newName?: string | null; startsAt?: string | null; day?: string | null; time?: string | null }): Promise<ActionResult<{ lessonId: string; studentPlayerId: string; startsAt: string }>> {
  return runA(async () => {
    const db = await getDb();
    const { me, coach } = await requireCoach(db);
    const locale = await getLocale();
    let startsAt: Date;
    if (input.startsAt) startsAt = new Date(input.startsAt);
    else if (input.day && input.time && /^\d{4}-\d{2}-\d{2}$/.test(input.day) && /^\d{2}:\d{2}$/.test(input.time)) startsAt = zonedTimeToUtc(input.day, input.time, coach.tz);
    else throw new DomainError("invalid", "time");
    if (Number.isNaN(startsAt.getTime())) throw new DomainError("invalid", "time");
    let studentPlayerId = input.studentPlayerId ?? null;
    if (!studentPlayerId) {
      const name = (input.newName ?? "").trim();
      if (!name) throw new ActionFailure("name_required");
      studentPlayerId = (await addStudentByName(db, coach.id, name, locale)).id;
    }
    const { lesson, package: pkg } = await bookLesson(db, { coach, studentPlayerId, startsAt, byCoach: true, source: "web", createdByPlayerId: me.id });
    const student = await getPlayerById(db, studentPlayerId);
    if (student) await notifyLessonBooked(db, { lesson, coach, student, pkg, by: "coach" }).catch(() => undefined);
    revalidateCoach(coach.handle);
    return { lessonId: lesson.id, studentPlayerId, startsAt: lesson.startsAt.toISOString() };
  });
}

export async function coachCancelAction(lessonId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { me, coach } = await requireCoach(db);
    const { lesson, outcome } = await cancelLesson(db, { lessonId, by: "coach", coach, actorPlayerId: me.id });
    const student = lesson.studentPlayerId ? await getPlayerById(db, lesson.studentPlayerId) : null;
    const freed = await afterLessonFreed(db, coach, lesson, "coach");
    if (student) await notifyLessonCancelled(db, { lesson, coach, student, pkg: null, by: "coach", outcome, alternatives: freed.alternatives }).catch(() => undefined);
    if (freed.offer) await notifyOffer(db, coach, freed.offer).catch(() => undefined);
    revalidateCoach(coach.handle);
    return null;
  });
}

export async function coachNoShowAction(lessonId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    await markNoShow(db, coach.id, lessonId);
    revalidateCoach(coach.handle);
    return null;
  });
}

export async function setStudentStatusAction(playerId: string, status: "accepted" | "paused"): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    const before = await studentStatus(db, coach.id, playerId);
    await setStudentStatus(db, coach.id, playerId, status);
    if (status === "accepted" && before !== "accepted") {
      const student = await getPlayerById(db, playerId);
      if (student) await notifyStudentAccepted(coach, student).catch(() => undefined);
    }
    revalidateCoach(coach.handle);
    return null;
  });
}

export async function addStudentAction(name: string, email?: string | null): Promise<ActionResult<{ playerId: string }>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    const clean = (name ?? "").trim();
    if (!clean) throw new ActionFailure("name_required");
    const address = (email ?? "").trim().toLowerCase();
    const player = await addStudentByName(db, coach.id, clean, await getLocale(), /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null);
    if (player.email) await notifyStudentInvited(coach, player).catch(() => undefined);
    revalidateCoach(coach.handle);
    return { playerId: player.id };
  });
}

// ---------------------------------------------------------------- calendar

export type CalendarState = { gcal: CalendarAccess | null; ical: { ok: boolean; error: string | null; busy: number } | null };

async function checkAndSync(db: Awaited<ReturnType<typeof getDb>>, coachId: string): Promise<CalendarState> {
  const [coach] = await db.select().from(coaches).where(eq(coaches.id, coachId)).limit(1);
  const state: CalendarState = { gcal: null, ical: null };
  if (coach.gcalId) {
    state.gcal = await checkCalendarAccess(coach.gcalId);
    const status = state.gcal.ok ? "linked" : state.gcal.reason;
    await db.update(coaches).set({ gcalStatus: status, gcalCheckedAt: new Date(), calendarError: state.gcal.ok ? null : (state.gcal.detail ?? state.gcal.reason) }).where(eq(coaches.id, coach.id));
    if (state.gcal.ok) await syncGoogleCalendar(db, coach).catch(() => undefined);
  }
  if (coach.icalUrl) {
    const r = await syncIcal(db, coach);
    state.ical = { ok: !r.error, error: r.error, busy: r.busy };
  }
  return state;
}

/** The coach names a calendar (Google address shared with our service account, or a secret iCal link); we check at once. */
export async function saveCalendarAction(input: { gcalId?: string | null; icalUrl?: string | null }): Promise<ActionResult<CalendarState>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    const settings = cleanCalendarSettings(input);
    if ((input.gcalId ?? "").trim() && !settings.gcalId) throw new DomainError("invalid", "gcal");
    if ((input.icalUrl ?? "").trim() && !settings.icalUrl) throw new DomainError("invalid", "ical");
    await setCoachCalendar(db, coach.id, settings);
    const state = await checkAndSync(db, coach.id);
    revalidateCoach(coach.handle);
    return state;
  });
}

export async function checkCalendarAction(): Promise<ActionResult<CalendarState>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    const state = await checkAndSync(db, coach.id);
    revalidateCoach(coach.handle);
    return state;
  });
}

// ---------------------------------------------------------------- sheet import

export type ImportPreview = { rows: ImportRow[]; skipped: number; known: string[] };

/** Pasted rows or a Google Sheet link, read into a preview. Nothing is written yet. */
export async function previewImportAction(text: string): Promise<ActionResult<ImportPreview>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    let body = (text ?? "").slice(0, 200_000);
    if (looksLikeLink(body)) {
      const url = sheetCsvUrl(body);
      if (!url) throw new DomainError("invalid", "link");
      try {
        body = await fetchSheet(url);
      } catch (e) {
        throw new DomainError("invalid", e instanceof Error && e.message === "not shared" ? "not_shared" : "unreachable");
      }
    }
    const parsed = parsePackageSheet(body);
    const existing = new Set((await listStudents(db, coach.id)).map((s) => s.player.displayName.trim().toLowerCase()));
    return { ...parsed, known: parsed.rows.filter((r) => existing.has(r.name.trim().toLowerCase())).map((r) => r.name) };
  });
}

export async function confirmImportAction(rows: ImportRow[]): Promise<ActionResult<ImportOutcome>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    const clean = (rows ?? []).slice(0, 200).map((r) => ({
      name: String(r.name ?? "").trim().slice(0, 40),
      email: r.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(r.email)) ? String(r.email).toLowerCase() : null,
      size: Number(r.size),
      used: Number(r.used ?? 0),
      expires: r.expires && /^\d{4}-\d{2}-\d{2}$/.test(String(r.expires)) ? String(r.expires) : null,
      amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
      paid: Boolean(r.paid),
    })).filter((r) => r.name && Number.isFinite(r.size) && r.size >= 1 && r.size <= 200);
    if (clean.length === 0) throw new DomainError("invalid", "empty");
    const out = await importPackages(db, coach, clean, await getLocale());
    revalidateCoach(coach.handle);
    return out;
  });
}

export async function addPackageAction(input: { studentPlayerId: string; size: number; validDays: number | null; amount: number | null; paid: boolean }): Promise<ActionResult<{ packageId: string }>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    const pkg = await createPackage(db, { coachId: coach.id, studentPlayerId: input.studentPlayerId, size: input.size, validDays: input.validDays, amount: input.amount, paid: input.paid });
    revalidateCoach(coach.handle);
    return { packageId: pkg.id };
  });
}

export async function setPackagePaidAction(packageId: string, paid: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    await setPackagePaid(db, coach.id, packageId, paid);
    revalidateCoach(coach.handle);
    return null;
  });
}

export async function extendPackageAction(packageId: string, days = 30): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    await extendPackage(db, coach.id, packageId, days);
    revalidateCoach(coach.handle);
    return null;
  });
}

// ------------------------------------------------------------------ students

export async function requestCoachAction(handle: string, name?: string | null): Promise<ActionResult<{ status: StudentStatus }>> {
  return runA(async () => {
    const db = await getDb();
    const coach = await getCoachByHandle(db, handle);
    if (!coach) throw new ActionFailure("no_coach");
    const me = await requirePlayer(db, name);
    const before = await studentStatus(db, coach.id, me.id);
    const status = await requestStudent(db, coach.id, me.id);
    if (before === "none") await notifyStudentRequest(db, coach, me).catch(() => undefined);
    revalidateCoach(coach.handle);
    return { status };
  });
}

export async function studentBookAction(handle: string, startsAt: string): Promise<ActionResult<{ lessonId: string; startsAt: string }>> {
  return runA(async () => {
    const db = await getDb();
    const coach = await getCoachByHandle(db, handle);
    if (!coach) throw new ActionFailure("no_coach");
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const at = new Date(startsAt);
    if (Number.isNaN(at.getTime())) throw new DomainError("invalid", "time");
    if ((await studentStatus(db, coach.id, me.id)) !== "accepted") throw new ActionFailure("not_student");
    const { lesson, package: pkg } = await bookLesson(db, { coach, studentPlayerId: me.id, startsAt: at, byCoach: false, source: "web", createdByPlayerId: me.id });
    await notifyLessonBooked(db, { lesson, coach, student: me, pkg, by: "student" }).catch(() => undefined);
    revalidateCoach(coach.handle);
    return { lessonId: lesson.id, startsAt: lesson.startsAt.toISOString() };
  });
}

export async function studentCancelAction(lessonId: string): Promise<ActionResult<{ outcome: CancelOutcome }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const [row] = await db
      .select({ coach: coaches })
      .from(lessons)
      .innerJoin(coaches, eq(coaches.id, lessons.coachId))
      .where(and(eq(lessons.id, lessonId), eq(lessons.studentPlayerId, me.id)))
      .limit(1);
    if (!row) throw new ActionFailure("not_found");
    const { lesson, outcome } = await cancelLesson(db, { lessonId, by: "student", coach: row.coach, actorPlayerId: me.id });
    await notifyLessonCancelled(db, { lesson, coach: row.coach, student: me, pkg: null, by: "student", outcome }).catch(() => undefined);
    const freed = await afterLessonFreed(db, row.coach, lesson, "student");
    if (freed.offer) await notifyOffer(db, row.coach, freed.offer).catch(() => undefined);
    revalidateCoach(row.coach.handle);
    return { outcome };
  });
}

// ---------------------------------------------------------------- chains: waitlist, offers, requests

async function studentOf(db: Awaited<ReturnType<typeof getDb>>, handle: string) {
  const coach = await getCoachByHandle(db, handle);
  if (!coach) throw new ActionFailure("no_coach");
  const me = await getSessionPlayer(db);
  if (!me) throw new ActionFailure("no_identity");
  return { coach, me };
}

/** "Tell me if this frees up": a slot, or any slot in a week. */
export async function joinWaitlistAction(handle: string, want: { slot?: string | null; weekStart?: string | null }): Promise<ActionResult<{ id: string }>> {
  return runA(async () => {
    const db = await getDb();
    const { coach, me } = await studentOf(db, handle);
    const slot = want.slot ? new Date(want.slot) : null;
    if (slot && Number.isNaN(slot.getTime())) throw new DomainError("invalid", "time");
    const row = await joinWaitlist(db, coach, me.id, { slotStartsAt: slot, weekStart: want.weekStart ?? null });
    revalidateCoach(coach.handle);
    return { id: row.id };
  });
}

export async function leaveWaitlistAction(handle: string, entryId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { coach, me } = await studentOf(db, handle);
    await withdrawWaitlist(db, coach.id, entryId, me.id);
    revalidateCoach(coach.handle);
    return null;
  });
}

/** The student takes the spot they were offered. */
export async function acceptOfferAction(handle: string, entryId: string): Promise<ActionResult<{ lessonId: string; startsAt: string }>> {
  return runA(async () => {
    const db = await getDb();
    const { coach, me } = await studentOf(db, handle);
    const { lesson, package: pkg } = await acceptOffer(db, coach, entryId, me.id);
    await notifyLessonBooked(db, { lesson, coach, student: me, pkg, by: "student" }).catch(() => undefined);
    revalidateCoach(coach.handle);
    return { lessonId: lesson.id, startsAt: lesson.startsAt.toISOString() };
  });
}

/** A time of the student's own: booked when the rules allow, otherwise a request to the coach. */
export async function requestTimeAction(handle: string, local: string, note?: string | null): Promise<ActionResult<{ kind: "booked" | "requested"; startsAt: string }>> {
  return runA(async () => {
    const db = await getDb();
    const { coach, me } = await studentOf(db, handle);
    // "2026-09-12T23:00" as the student typed it, read in the coach's zone.
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(local ?? "");
    if (!m) throw new DomainError("invalid", "time");
    const at = zonedTimeToUtc(m[1], m[2], coach.tz);
    if (Number.isNaN(at.getTime())) throw new DomainError("invalid", "time");
    const r = await requestOrBook(db, coach, me.id, at, note ?? null);
    if (r.kind === "booked") await notifyLessonBooked(db, { lesson: r.lesson, coach, student: me, pkg: r.package, by: "student" }).catch(() => undefined);
    else await notifyRequest(db, coach, me, r.request).catch(() => undefined);
    revalidateCoach(coach.handle);
    return { kind: r.kind, startsAt: (r.kind === "booked" ? r.lesson.startsAt : r.request.startsAt).toISOString() };
  });
}

/** The coach's yes or no, from the web. */
export async function decideRequestAction(requestId: string, accept: boolean): Promise<ActionResult<{ booked: boolean }>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    const { request, lesson, package: pkg } = await decideRequest(db, coach, requestId, Boolean(accept));
    const student = await getPlayerById(db, request.studentPlayerId);
    if (student) await notifyRequestDecided(db, { coach, student, request, lesson, pkg }).catch(() => undefined);
    revalidateCoach(coach.handle);
    return { booked: Boolean(lesson) };
  });
}

// ---------------------------------------------------------------- managers

export async function managerLinkAction(renew = false): Promise<ActionResult<{ url: string }>> {
  return runA(async () => {
    const db = await getDb();
    const { coach, role } = await requireCoach(db);
    if (role !== "coach") throw new ActionFailure("forbidden");
    const code = await managerCode(db, coach.id, Boolean(renew));
    return { url: `${baseUrl()}/coach/join/${code}` };
  });
}

export async function removeManagerAction(playerId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { coach, role } = await requireCoach(db);
    if (role !== "coach") throw new ActionFailure("forbidden");
    await removeManager(db, coach.id, playerId);
    revalidateCoach(coach.handle);
    return null;
  });
}

/** Opening the manager link: a name is enough for a newcomer. */
export async function claimManagerAction(code: string, name?: string | null): Promise<ActionResult<{ handle: string }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await requirePlayer(db, name);
    const coach = await claimManager(db, code, me.id);
    if (coach.playerId !== me.id) await notifyManagerJoined(db, coach, me).catch(() => undefined);
    revalidateCoach(coach.handle);
    return { handle: coach.handle };
  });
}
