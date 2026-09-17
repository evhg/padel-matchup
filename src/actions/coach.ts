"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { bumpMetric } from "@/lib/domain/metrics";
import { COACH_SOURCE_COOKIE, cleanSource } from "@/lib/source";
import { getLocale } from "next-intl/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { coaches, lessons } from "@/db/schema";
import { isValidTimeZone, zonedTimeToUtc } from "@/lib/dates";
import { acceptByInvite, addStudentByName, bookLesson, cancelLesson, createPackage, extendPackage, getCoachByHandle, getCoachForActor, getPlayerById, hoursFromLines, insertCoach, inviteMatches, isPayLink, LESSON_MINUTES, listStudents, markNoShow, presetHours, removeCoachQr, requestStudent, setCoachQr, setPackagePaid, setStudentStatus, studentStatus, type CancelOutcome, type Hours, type HoursPreset, type StudentStatus, updateCoach , type CoachPatch, blockTime, unblockTime, studentLink, inviteCode, moveLesson, claimLessonPaid, setLessonPaid, deleteCoachBook, type CoachBookContents, leaveCoach, compLesson, openHour, attachSlip} from "@/lib/domain/coaching";
import { DomainError } from "@/lib/domain/errors";
import { checkCalendarAccess, type CalendarAccess } from "@/lib/coach/gcal";
import { fetchSheet, importPackages, looksLikeLink, parsePackageSheet, sheetCsvUrl, type ImportOutcome, type ImportRow } from "@/lib/coach/import";
import { notifyPaidConfirmed, notifyPaidClaimed, notifyLessonMoved, notifyLessonBooked, notifyLessonCancelled, notifyStudentAccepted, notifyStudentInvited, notifyStudentJoined, notifyStudentRequest } from "@/lib/coach/notify";
import { cleanCalendarSettings, setCoachCalendar, syncGoogleCalendar, syncIcal } from "@/lib/coach/sync";
import { reachFor, type Reach } from "@/lib/coach/reach";
import { acceptOffer, afterLessonFreed, claimManager, decideRequest, joinWaitlist, managerCode, removeManager, requestOrBook, withdrawWaitlist } from "@/lib/coach/chains";
import { notifyManagerJoined, notifyOffer, notifyRequest, notifyRequestDecided } from "@/lib/coach/notify";
import { pingIndexNow } from "@/lib/indexnow";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, requirePlayer, runA, type ActionResult } from "./shared";


/** The coach's book: every action here is one tap on a coach screen or a student screen. */

/**
 * Has the assistant got a way to reach me yet? Asked by the "where should I tell you" screen when the
 * coach taps Done, so the answer comes from the database rather than from what the screen believes.
 * The email field and the push switch each save themselves; neither tells this screen that it did.
 */
export async function myReachAction(): Promise<ActionResult<Reach>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    return reachFor(db, me);
  });
}

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

/** The first three steps of the setup: where, how long, when. Seven hour lines (index 0 = Sunday); an empty list means the usual hours. */
/**
 * Close the book for good. The confirm the coach saw named what goes; this counts it again rather
 * than trusting a number that travelled through a browser, and refuses while a lesson is still to come.
 */
export async function deleteCoachBookAction(): Promise<ActionResult<CoachBookContents>> {
  return runA(async () => {
    const db = await getDb();
    const { me, coach, role } = await requireCoach(db);
    if (role !== "coach") throw new ActionFailure("forbidden");
    const gone = await deleteCoachBook(db, { coachId: coach.id, actorPlayerId: me.id });
    revalidateCoach(coach.handle);
    revalidatePath("/coaches");
    return gone;
  });
}

export async function setupCoachAction(input: { name?: string | null; clubs: string; clubSlugs?: string[]; minutes: number; hoursLines?: string[]; preset?: HoursPreset | "custom"; tz?: string | null; minNoticeHours?: number | null }): Promise<ActionResult<{ handle: string; studentUrl: string }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await requirePlayer(db, input.name);
    const locale = await getLocale();
    const tz = input.tz && isValidTimeZone(input.tz) ? input.tz : "Asia/Bangkok";
    let hours: Hours = input.preset && input.preset !== "custom" ? presetHours(input.preset) : presetHours("both");
    if (input.hoursLines && input.hoursLines.length === 7) {
      const parsed = hoursFromLines(input.hoursLines);
      if (parsed.invalidDay !== null) throw new DomainError("invalid", String(parsed.invalidDay));
      hours = parsed.hours;
    }
    const { coach, created } = await insertCoach(db, { playerId: me.id, displayName: me.displayName, clubNames: input.clubs, lessonMinutes: input.minutes, hours, tz, languages: [locale] });
    // Which door this coach came through (a coach page, a club page, the city list, an invite, the landing page): the Sunday digest counts them, once per book.
    if (created) {
      const source = cleanSource((await cookies()).get(COACH_SOURCE_COOKIE)?.value);
      await bumpMetric(db, "coaches_created").catch(() => undefined);
      if (source) await bumpMetric(db, `coach_src_${source}`).catch(() => undefined);
    }
    // Neither a revalidation nor a cookie here, on purpose: either would refresh /coach and swap the setup walk for the book
    // mid-way. The walk moves itself to /coach?setup=1 and ends through /coach/done.
    const patch: CoachPatch = {};
    if (input.clubSlugs?.length) patch.clubSlugs = input.clubSlugs;
    if (created && input.minNoticeHours != null && Number.isFinite(input.minNoticeHours)) patch.minNoticeHours = input.minNoticeHours;
    if (Object.keys(patch).length) await updateCoach(db, coach.id, patch).catch(() => undefined);
    // The walk ends on this link, so it is minted here rather than left on a screen the coach has not seen.
    const studentUrl = studentLink(baseUrl(), coach.handle, await inviteCode(db, coach));
    return { handle: coach.handle, studentUrl };
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
  priceSingle: number | null;
  priceTwo: number | null;
  priceThree: number | null;
  priceFour: number | null;
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
    const parsed = hoursFromLines(input.hoursLines);
    if (parsed.invalidDay !== null) throw new DomainError("invalid", String(parsed.invalidDay));
    const hours: Hours = parsed.hours;
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
      // Per head, or nothing; updateCoach turns zero and blanks into null.
      priceSingle: input.priceSingle,
      priceTwo: input.priceTwo,
      priceThree: input.priceThree,
      priceFour: input.priceFour,
      promptpayId: input.promptpayId,
      payLink: input.payLink,
      whatsapp: input.whatsapp,
      isPublic: Boolean(input.isPublic),
      tz: input.tz,
    });
    revalidateCoach(coach.handle);
    // Search engines hear about a listed page the moment it changes (or is unlisted: they drop it).
    if (Boolean(input.isPublic) || coach.isPublic) void pingIndexNow([`/c/${coach.handle}`, `/ru/c/${coach.handle}`, `/es/c/${coach.handle}`], { db }).catch(() => undefined);
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
export async function coachBookAction(input: { studentPlayerId?: string | null; newName?: string | null; startsAt?: string | null; day?: string | null; time?: string | null; heads?: number }): Promise<ActionResult<{ lessonId: string; studentPlayerId: string; startsAt: string }>> {
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
    const { lesson, package: pkg } = await bookLesson(db, { coach, studentPlayerId, startsAt, byCoach: true, source: "web", createdByPlayerId: me.id, heads: input.heads });
    const student = await getPlayerById(db, studentPlayerId);
    if (student) await notifyLessonBooked(db, { lesson, coach, student, pkg, by: "coach" }).catch(() => undefined);
    revalidateCoach(coach.handle);
    return { lessonId: lesson.id, studentPlayerId, startsAt: lesson.startsAt.toISOString() };
  });
}

/**
 * The coach takes an hour back: lunch, a match, the school run. This is what connecting Google
 * Calendar was standing in for, and it needs no connection — one tap on the grid they are already
 * looking at, which is the only surface a coach on a phone actually reaches.
 */
export async function coachBlockAction(input: { startsAt?: string | null; day?: string | null; time?: string | null; minutes?: number | null; reason?: string | null }): Promise<ActionResult<{ blockId: string }>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    let startsAt: Date;
    if (input.startsAt) startsAt = new Date(input.startsAt);
    else if (input.day && input.time && /^\d{4}-\d{2}-\d{2}$/.test(input.day) && /^\d{2}:\d{2}$/.test(input.time)) startsAt = zonedTimeToUtc(input.day, input.time, coach.tz);
    else throw new DomainError("invalid", "time");
    if (Number.isNaN(startsAt.getTime())) throw new DomainError("invalid", "time");
    const block = await blockTime(db, { coachId: coach.id, startsAt, minutes: input.minutes ?? coach.lessonMinutes, reason: input.reason ?? null });
    revalidateCoach(coach.handle);
    return { blockId: block.id };
  });
}

/**
 * "I can also do this hour." The opposite of blocking: one date opened on top of the weekly template,
 * so a coach can say yes to a Sunday evening without moving everybody else's Sundays.
 */
export async function coachOpenAction(input: { startsAt?: string | null; day?: string | null; time?: string | null; minutes?: number | null }): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    let startsAt: Date;
    if (input.startsAt) startsAt = new Date(input.startsAt);
    else if (input.day && input.time && /^\d{4}-\d{2}-\d{2}$/.test(input.day) && /^\d{2}:\d{2}$/.test(input.time)) startsAt = zonedTimeToUtc(input.day, input.time, coach.tz);
    else throw new DomainError("invalid", "time");
    if (Number.isNaN(startsAt.getTime())) throw new DomainError("invalid", "time");
    await openHour(db, coach.id, startsAt, input.minutes ?? coach.lessonMinutes);
    revalidateCoach(coach.handle);
    return null;
  });
}

/** Undo one. Only a block made here comes back this way; a calendar's blocks belong to the calendar. */
export async function coachUnblockAction(blockId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    if (!(await unblockTime(db, coach.id, blockId))) throw new DomainError("not_found");
    revalidateCoach(coach.handle);
    return null;
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
      if (student) await notifyStudentAccepted(db, coach, student).catch(() => undefined);
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
    if (player.email) await notifyStudentInvited(db, coach, player).catch(() => undefined);
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

/** Ask to join from the public page; with the coach's own invite code, the student is on the list at once. */
export async function requestCoachAction(handle: string, name?: string | null, invite?: string | null): Promise<ActionResult<{ status: StudentStatus }>> {
  return runA(async () => {
    const db = await getDb();
    const coach = await getCoachByHandle(db, handle);
    if (!coach) throw new ActionFailure("no_coach");
    const me = await requirePlayer(db, name);
    if (inviteMatches(coach, invite)) {
      const before = await studentStatus(db, coach.id, me.id);
      const status = await acceptByInvite(db, coach.id, me.id);
      if (status === "accepted" && before !== "accepted") await notifyStudentJoined(db, coach, me).catch(() => undefined);
      revalidateCoach(coach.handle);
      return { status };
    }
    const before = await studentStatus(db, coach.id, me.id);
    const status = await requestStudent(db, coach.id, me.id);
    // Somebody coming back after leaving is as much news to the coach as somebody new.
    if (before === "none" || before === "left") await notifyStudentRequest(db, coach, me).catch(() => undefined);
    revalidateCoach(coach.handle);
    return { status };
  });
}

/**
 * The student's own way off a coach's list. The coach's "Book more" door on My matches comes from
 * that list, so until now only the coach could take it away — a player who took one lesson and moved
 * on carried the door on their screen for good.
 */
export async function leaveCoachAction(handle: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const coach = await getCoachByHandle(db, handle);
    if (!coach) throw new ActionFailure("no_coach");
    const me = await requirePlayer(db);
    await leaveCoach(db, coach.id, me.id);
    revalidateCoach(coach.handle);
    revalidatePath("/me");
    return null;
  });
}

/**
 * Setup step: what a lesson costs and how students pay for it. A field left out stays as it is; an
 * empty one clears; a link that is not a link is refused, not dropped. Nothing is charged here and
 * nothing passes through Kicksmash — this is what the student is shown so they can pay the coach.
 */
/**
 * "This one is on me." The coach's own tap: a package lesson goes back to the package, a priced one
 * is zeroed, and the reason reaches the student, because a gift nobody is told about is just a number
 * that changed.
 */
export async function compLessonAction(lessonId: string, reason?: string | null): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    await compLesson(db, { lessonId, coach, reason });
    revalidateCoach(coach.handle);
    return null;
  });
}

export async function savePaymentAction(input: { promptpayId?: string | null; payLink?: string | null; priceSingle?: number | null; priceTwo?: number | null; priceThree?: number | null; priceFour?: number | null; latePasses?: number | null; currency?: string | null; payAtClub?: boolean }): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    const patch: CoachPatch = {};
    if (typeof input.promptpayId === "string") patch.promptpayId = input.promptpayId.trim();
    if (typeof input.payLink === "string") {
      const link = input.payLink.trim();
      if (link && !isPayLink(link)) throw new DomainError("invalid", "payLink");
      patch.payLink = link;
    }
    // Every price is per head, and an empty one means "I do not sell that", which updateCoach turns to null.
    if (input.priceSingle !== undefined) patch.priceSingle = input.priceSingle;
    if (input.priceTwo !== undefined) patch.priceTwo = input.priceTwo;
    if (input.priceThree !== undefined) patch.priceThree = input.priceThree;
    if (input.priceFour !== undefined) patch.priceFour = input.priceFour;
    if (input.latePasses != null && Number.isFinite(input.latePasses)) patch.latePasses = input.latePasses;
    if (typeof input.currency === "string") patch.currency = input.currency;
    if (typeof input.payAtClub === "boolean") patch.payAtClub = input.payAtClub;
    if (Object.keys(patch).length) await updateCoach(db, coach.id, patch);
    revalidateCoach(coach.handle);
    return null;
  });
}


export async function studentBookAction(handle: string, startsAt: string, heads?: number): Promise<ActionResult<{ lessonId: string; startsAt: string }>> {
  return runA(async () => {
    const db = await getDb();
    const coach = await getCoachByHandle(db, handle);
    if (!coach) throw new ActionFailure("no_coach");
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const at = new Date(startsAt);
    if (Number.isNaN(at.getTime())) throw new DomainError("invalid", "time");
    if ((await studentStatus(db, coach.id, me.id)) !== "accepted") throw new ActionFailure("not_student");
    const { lesson, package: pkg } = await bookLesson(db, { coach, studentPlayerId: me.id, startsAt: at, byCoach: false, source: "web", createdByPlayerId: me.id, heads });
    await notifyLessonBooked(db, { lesson, coach, student: me, pkg, by: "student" }).catch(() => undefined);
    revalidateCoach(coach.handle);
    return { lessonId: lesson.id, startsAt: lesson.startsAt.toISOString() };
  });
}

/**
 * "Can we do Friday instead?" — answered without a message. The lesson keeps its package and its
 * place in the book; only the hour changes, so there is no moment where the student holds neither
 * the old slot nor the new one, and no free pass is spent on a lesson that is still happening.
 */
export async function studentMoveAction(lessonId: string, startsAt: string): Promise<ActionResult<{ startsAt: string }>> {
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
    const when = new Date(startsAt);
    if (Number.isNaN(when.getTime())) throw new DomainError("invalid", "time");
    const { from, to } = await moveLesson(db, { lessonId, coach: row.coach, startsAt: when, by: "student", actorPlayerId: me.id, source: "web" });
    await notifyLessonMoved(db, { from, to, coach: row.coach, student: me, by: "student" }).catch(() => undefined);
    revalidateCoach(row.coach.handle);
    return { startsAt: to.startsAt.toISOString() };
  });
}

/** The coach moves one from their own book; their students hear about it rather than discover it. */
export async function coachMoveAction(lessonId: string, input: { startsAt?: string | null; day?: string | null; time?: string | null }): Promise<ActionResult<{ startsAt: string }>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    let when: Date;
    if (input.startsAt) when = new Date(input.startsAt);
    else if (input.day && input.time && /^\d{4}-\d{2}-\d{2}$/.test(input.day) && /^\d{2}:\d{2}$/.test(input.time)) when = zonedTimeToUtc(input.day, input.time, coach.tz);
    else throw new DomainError("invalid", "time");
    if (Number.isNaN(when.getTime())) throw new DomainError("invalid", "time");
    const { from, to } = await moveLesson(db, { lessonId, coach, startsAt: when, by: "coach", source: "web" });
    const student = to.studentPlayerId ? await getPlayerById(db, to.studentPlayerId) : null;
    if (student) await notifyLessonMoved(db, { from, to, coach, student, by: "coach" }).catch(() => undefined);
    revalidateCoach(coach.handle);
    return { startsAt: to.startsAt.toISOString() };
  });
}

/** "I've sent it." A claim, not a status: it asks the coach, and only their tap answers. */
export async function studentClaimPaidAction(lessonId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const lesson = await claimLessonPaid(db, lessonId, me.id);
    if (!lesson) throw new ActionFailure("not_found");
    const [coach] = await db.select().from(coaches).where(eq(coaches.id, lesson.coachId)).limit(1);
    if (coach) {
      await notifyPaidClaimed(db, { coach, student: me, lesson }).catch(() => undefined);
      revalidateCoach(coach.handle);
    }
    return null;
  });
}

/**
 * The bank slip, attached by the student. Attaching one is saying "I've paid", so the coach hears it
 * the same way, with the picture a tap away on their students screen.
 */
export async function studentAttachSlipAction(lessonId: string, dataUrl: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? "");
    if (!m) throw new DomainError("invalid", "mime");
    const lesson = await attachSlip(db, lessonId, me.id, m[1], m[2]);
    if (!lesson) throw new ActionFailure("not_found");
    const [coach] = await db.select().from(coaches).where(eq(coaches.id, lesson.coachId)).limit(1);
    if (coach) {
      await notifyPaidClaimed(db, { coach, student: me, lesson }).catch(() => undefined);
      revalidateCoach(coach.handle);
    }
    return null;
  });
}

/** The coach's tap is the only thing that marks a lesson paid. */
export async function coachSetLessonPaidAction(lessonId: string, paid: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const { coach } = await requireCoach(db);
    const lesson = await setLessonPaid(db, coach.id, lessonId, paid);
    if (!lesson) throw new ActionFailure("not_found");
    // Only the confirmation is worth a message. Un-marking is a correction the coach makes to their
    // own book, and telling a student their payment was un-confirmed would read as an accusation.
    if (paid && lesson.studentPlayerId) {
      const student = await getPlayerById(db, lesson.studentPlayerId);
      if (student) await notifyPaidConfirmed(db, { coach, student, lesson }).catch(() => undefined);
    }
    revalidateCoach(coach.handle);
    return null;
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
