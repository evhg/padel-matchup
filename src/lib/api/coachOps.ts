import { z } from "zod";
import type { Db } from "@/db";
import type { Coach } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { afterLessonFreed } from "@/lib/coach/chains";
import { notifyLessonBooked, notifyLessonCancelled, notifyOffer, notifyStudentRequest } from "@/lib/coach/notify";
import { cityOf } from "@/lib/domain/cities";
import { availableSlots, bookLesson, cancelLesson, DAY_MS, getCoachByHandle, getLesson, requestStudent, studentStatus, type CancelOutcome, type StudentStatus } from "@/lib/domain/coaching";
import { isDomainError } from "@/lib/domain/errors";
import { findPlayerByPersonalToken, getOrCreatePersonalToken } from "@/lib/domain/identity";
import { createPlayer } from "@/lib/domain/players";
import { personalUrl } from "@/lib/personal";
import { ApiError } from "./http";
import { coachToPublic, type PublicCoach } from "./serialize";

/**
 * Coaches for people's assistants: find one, see free times, ask to become a student,
 * book and cancel under the coach's own rules. The same code paths as the page and the
 * Telegram assistant; the coach hears exactly what they would hear otherwise.
 */

export const SLOT_DAYS_DEFAULT = 14;

export const coachHandleSchema = z.object({ handle: z.string().min(2).max(40).describe("The coach's handle from their page URL, e.g. 'olga' in kicksma.sh/c/olga.") });
export const coachSlotsSchema = coachHandleSchema.extend({ days: z.number().int().min(1).max(30).optional().describe("How many days ahead, default 14.") });
export const requestCoachSchema = coachHandleSchema.extend({
  name: z.string().min(1).max(40).optional().describe("The student's first name. Required unless token is given."),
  token: z.string().min(8).max(64).optional().describe("Personal token of an existing Kicksmash player."),
});
export const bookLessonSchema = coachHandleSchema.extend({
  token: z.string().min(8).max(64).describe("The student's personal token (from request_coach or any earlier call). The coach must have accepted them."),
  startsAt: z.string().min(10).describe("A start from coach_slots, ISO 8601."),
});
export const cancelLessonSchema = z.object({ lessonId: z.string().uuid().describe("The lesson id from book_lesson."), token: z.string().min(8).max(64).describe("The student's personal token.") });

const noCoach = (handle: string) => new ApiError(404, "not_found", `No listed coach with handle "${handle}".`, `Coaches list themselves; find them with GET ${baseUrl()}/api/v1/coaches?city=phuket.`);

export async function loadCoach(db: Db, handle: string): Promise<Coach> {
  const coach = await getCoachByHandle(db, handle.toLowerCase());
  if (!coach || coach.archivedAt) throw noCoach(handle);
  return coach;
}

const cityName = (coach: Coach) => cityOf(coach.tz, null)?.name ?? null;

export async function publicCoach(db: Db, coach: Coach, withSlots: boolean, now = new Date()): Promise<PublicCoach> {
  const slots = withSlots ? (await availableSlots(db, coach, now, new Date(now.getTime() + SLOT_DAYS_DEFAULT * DAY_MS), now)).slice(0, 40) : undefined;
  return coachToPublic(coach, baseUrl(), { city: cityName(coach), slots });
}

export async function coachSlots(db: Db, raw: unknown, now = new Date()): Promise<{ coach: PublicCoach; days: number; slots: string[]; rules: PublicCoach["rules"]; next: string }> {
  const { handle, days } = coachSlotsSchema.parse(raw);
  const coach = await loadCoach(db, handle);
  const span = days ?? SLOT_DAYS_DEFAULT;
  const slots = await availableSlots(db, coach, now, new Date(now.getTime() + span * DAY_MS), now);
  return { coach: coachToPublic(coach, baseUrl(), { city: cityName(coach) }), days: span, slots: slots.map((d) => d.toISOString()), rules: { cutoffHours: coach.cutoffHours, latePasses: coach.latePasses, minNoticeHours: coach.minNoticeHours }, next: "Only accepted students can book: ask first with request_coach (POST /requests), then book_lesson with the same token." };
}

async function resolveStudent(db: Db, input: { name?: string; token?: string }, locale = "en") {
  if (input.token) {
    const p = await findPlayerByPersonalToken(db, input.token);
    if (!p) throw new ApiError(404, "unknown_token", "No player has this personal token.", "Omit token and pass a name to create a new player, or use the token from an earlier response.");
    return p;
  }
  const name = input.name?.trim();
  if (!name) throw new ApiError(422, "invalid_request", "name is required when no token is given.", "A first name is enough. The response returns a personal token to reuse.");
  return createPlayer(db, { displayName: name, locale });
}

export type RequestCoachResult = { status: StudentStatus; coach: PublicCoach; student: { name: string; personalToken: string; personalUrl: string }; next: string };

/** "Ask to become a student": the coach gets one tap; an accepted student is told so at once. */
export async function requestCoach(db: Db, raw: unknown, locale = "en"): Promise<RequestCoachResult> {
  const input = requestCoachSchema.parse(raw);
  const coach = await loadCoach(db, input.handle);
  const player = await resolveStudent(db, input, locale);
  const before = await studentStatus(db, coach.id, player.id);
  const status = await requestStudent(db, coach.id, player.id);
  if (before === "none" && status === "requested") await notifyStudentRequest(db, coach, player).catch(() => undefined);
  const token = await getOrCreatePersonalToken(db, player.id);
  const base = baseUrl();
  return {
    status,
    coach: coachToPublic(coach, base, { city: cityName(coach) }),
    student: { name: player.displayName, personalToken: token, personalUrl: personalUrl(base, token) },
    next: status === "accepted" ? "Accepted: book_lesson works with this token." : status === "requested" ? "The coach decides with one tap; once accepted, book_lesson works with this token. The student can watch the coach's page meanwhile." : "This student is paused by the coach; the coach's page has a message button.",
  };
}

export type BookLessonResult = { lesson: { id: string; startsAt: string; minutes: number; coach: string; url: string }; package: { left: number; size: number; expiresAt: string | null } | null; rules: PublicCoach["rules"]; next: string };

const mapCoachError = (e: unknown, coach: Coach): never => {
  if (isDomainError(e)) {
    if (e.code === "not_student") throw new ApiError(403, "not_student", "The coach has not accepted this player yet.", "Call request_coach first; the coach answers with one tap.");
    if (e.code === "slot_taken") throw new ApiError(409, "slot_taken", "That time is no longer free.", "Ask coach_slots again and pick another.");
    if (e.code === "outside_hours") throw new ApiError(422, "outside_hours", "That time is outside the coach's hours.", `Pick a start from coach_slots; the student can ask for another time on ${baseUrl()}/c/${coach.handle}.`);
    if (e.code === "too_soon") throw new ApiError(422, "too_soon", `Less than ${coach.minNoticeHours} hours' notice.`, "Pick a later start from coach_slots.");
    if (e.code === "past") throw new ApiError(422, "past", "That time has passed.", "Pick a start from coach_slots.");
    if (e.code === "cancelled") throw new ApiError(409, "already_cancelled", "This lesson is not booked any more.");
    if (e.code === "forbidden" || e.code === "not_found") throw new ApiError(404, "not_found", "No such lesson for this student.");
  }
  throw e;
};

export async function bookLessonApi(db: Db, raw: unknown, now = new Date()): Promise<BookLessonResult> {
  const input = bookLessonSchema.parse(raw);
  const coach = await loadCoach(db, input.handle);
  const player = await findPlayerByPersonalToken(db, input.token);
  if (!player) throw new ApiError(404, "unknown_token", "No player has this personal token.", "Use the token from request_coach.");
  const at = new Date(input.startsAt);
  if (Number.isNaN(at.getTime())) throw new ApiError(422, "invalid_request", "startsAt is not a date.", "Use an ISO 8601 start from coach_slots.");
  try {
    const { lesson, package: pkg } = await bookLesson(db, { coach, studentPlayerId: player.id, startsAt: at, byCoach: false, source: "api", createdByPlayerId: player.id }, now);
    await notifyLessonBooked(db, { lesson, coach, student: player, pkg, by: "student" }).catch(() => undefined);
    const left = pkg ? Math.max(0, pkg.size - pkg.used) : null;
    return {
      lesson: { id: lesson.id, startsAt: lesson.startsAt.toISOString(), minutes: lesson.minutes, coach: coach.displayName, url: `${baseUrl()}/c/${coach.handle}` },
      package: pkg ? { left: left ?? 0, size: pkg.size, expiresAt: pkg.expiresAt?.toISOString() ?? null } : null,
      rules: { cutoffHours: coach.cutoffHours, latePasses: coach.latePasses, minNoticeHours: coach.minNoticeHours },
      next: `Booked. Cancelling more than ${coach.cutoffHours} hours before is free; later it uses a free pass if the package has one, otherwise the lesson counts.`,
    };
  } catch (e) {
    return mapCoachError(e, coach);
  }
}

export type CancelLessonResult = { lessonId: string; outcome: CancelOutcome; next: string };

export async function cancelLessonApi(db: Db, raw: unknown, now = new Date()): Promise<CancelLessonResult> {
  const input = cancelLessonSchema.parse(raw);
  const player = await findPlayerByPersonalToken(db, input.token);
  if (!player) throw new ApiError(404, "unknown_token", "No player has this personal token.", "Use the token from request_coach or book_lesson.");
  const lesson = await getLesson(db, input.lessonId);
  if (!lesson || lesson.studentPlayerId !== player.id) throw new ApiError(404, "not_found", "No such lesson for this student.");
  const coach = await getCoachByHandle(db, (await loadCoachById(db, lesson.coachId)).handle);
  if (!coach) throw new ApiError(404, "not_found", "The coach's page is gone.");
  try {
    const { lesson: updated, outcome } = await cancelLesson(db, { lessonId: lesson.id, by: "student", coach, actorPlayerId: player.id }, now);
    await notifyLessonCancelled(db, { lesson: updated, coach, student: player, pkg: null, by: "student", outcome }).catch(() => undefined);
    const freed = await afterLessonFreed(db, coach, updated, "student", now);
    if (freed.offer) await notifyOffer(db, coach, freed.offer).catch(() => undefined);
    return { lessonId: updated.id, outcome, next: outcome === "refunded" ? "Cancelled in time: the lesson is back on the package." : outcome === "free_pass" ? "Cancelled late: the package's free pass covered it." : outcome === "counted" ? "Cancelled late: the lesson counts." : "Cancelled." };
  } catch (e) {
    return mapCoachError(e, coach);
  }
}

async function loadCoachById(db: Db, coachId: string): Promise<Coach> {
  const { coaches } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(coaches).where(eq(coaches.id, coachId)).limit(1);
  if (!row) throw new ApiError(404, "not_found", "The coach's page is gone.");
  return row;
}
