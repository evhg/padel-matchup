"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
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
  LESSON_MINUTES,
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
    const { lesson } = await bookLesson(db, { coach, studentPlayerId, startsAt, byCoach: true, source: "web", createdByPlayerId: me.id });
    revalidateCoach(coach.handle);
    return { lessonId: lesson.id, studentPlayerId, startsAt: lesson.startsAt.toISOString() };
  });
}

export async function coachCancelAction(lessonId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { me, coach } = await requireCoach(db);
    await cancelLesson(db, { lessonId, by: "coach", coach, actorPlayerId: me.id });
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
    await setStudentStatus(db, coach.id, playerId, status);
    revalidateCoach(coach.handle);
    return null;
  });
}

export async function addStudentAction(name: string): Promise<ActionResult<{ playerId: string }>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    const clean = (name ?? "").trim();
    if (!clean) throw new ActionFailure("name_required");
    const player = await addStudentByName(db, coach.id, clean, await getLocale());
    revalidateCoach(coach.handle);
    return { playerId: player.id };
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
    const status = await requestStudent(db, coach.id, me.id);
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
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: me.id, startsAt: at, byCoach: false, source: "web", createdByPlayerId: me.id });
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
    const { outcome } = await cancelLesson(db, { lessonId, by: "student", coach: row.coach, actorPlayerId: me.id });
    revalidateCoach(row.coach.handle);
    return { outcome };
  });
}
