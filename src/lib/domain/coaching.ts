import { transliterate } from "@/lib/translit";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { newCoachCode } from "@/lib/codes";
import { coachAssets, coachBlocks, coachManagers, coachStudents, coaches, lessonPackages, lessons, players, type Coach, type CoachBlock, type CoachStudent, type Lesson, type LessonPackage, type Player } from "@/db/schema";
import { isValidTimeZone, utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";
import { DomainError } from "./errors";
import { cityOf } from "./cities";
import { channelOf, recordFact } from "./facts";
import { createPlayer } from "./players";

/**
 * A coach's book: students, packages with expiry, lessons, blocks. The rules are the
 * ones coaches already run by hand: a student books alone once accepted; a cancellation
 * before the cutoff is free; a late one uses a free pass, then counts; a lesson the
 * coach cancels never counts. No money moves here.
 */

export const HOUR_MS = 3600_000;
export const DAY_MS = 24 * HOUR_MS;
export const LESSON_MINUTES = [45, 60, 90, 120] as const;
export const STUDENT_HORIZON_DAYS = 14;
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

export type Hours = Record<string, [string, string][]>;
export type HoursPreset = "mornings" | "afternoons" | "both";
export type StudentStatus = "none" | "requested" | "accepted" | "paused";
export type LessonStatus = "booked" | "done" | "cancelled" | "cancelled_by_student" | "late_cancelled" | "no_show";
export type CancelOutcome = "refunded" | "free_pass" | "counted" | "none";
export type Busy = { startsAt: Date; endsAt: Date };

export type LessonWithPeople = Lesson & { student: Player | null; package: LessonPackage | null };
export type StudentRow = CoachStudent & { player: Player; activePackage: LessonPackage | null; lessonsDone: number };
export type StudentCoach = { coach: Coach; status: StudentStatus; activePackage: LessonPackage | null };

const PRESETS: Record<HoursPreset, [string, string][]> = {
  mornings: [["07:00", "12:00"]],
  afternoons: [["15:00", "20:00"]],
  both: [
    ["07:00", "12:00"],
    ["15:00", "20:00"],
  ],
};

/** The same ranges every day; the coach trims days in settings. */
export function presetHours(preset: HoursPreset): Hours {
  const out: Hours = {};
  for (let d = 0; d < 7; d++) out[String(d)] = PRESETS[preset].map((r) => [r[0], r[1]]);
  return out;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (t: string) => {
  const m = TIME_RE.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

/** "07:00-12:00, 15:00-20:00" → ranges; "off", "-" or "" → none; anything else → null (invalid). */
export function parseHoursLine(line: string): [string, string][] | null {
  const raw = (line ?? "").trim().toLowerCase();
  if (raw === "" || raw === "off" || raw === "-" || raw === "—") return [];
  const out: [string, string][] = [];
  for (const part of raw.split(/[,;]+/)) {
    const m = part.trim().match(/^(\d{1,2}(?::\d{2})?)\s*(?:-|–|to)\s*(\d{1,2}(?::\d{2})?)$/);
    if (!m) return null;
    const norm = (v: string) => (v.includes(":") ? v.padStart(5, "0") : `${v.padStart(2, "0")}:00`);
    const a = norm(m[1]);
    const b = norm(m[2]);
    if (!TIME_RE.test(a) || !TIME_RE.test(b) || minutesOf(a) >= minutesOf(b)) return null;
    out.push([a, b]);
  }
  out.sort((x, y) => minutesOf(x[0]) - minutesOf(y[0]));
  for (let i = 1; i < out.length; i++) if (minutesOf(out[i][0]) < minutesOf(out[i - 1][1])) return null;
  return out;
}

export const formatHoursLine = (ranges: [string, string][] | undefined): string => (ranges && ranges.length ? ranges.map((r) => `${r[0]}-${r[1]}`).join(", ") : "");

/** Seven lines (index 0 = Sunday) into hours; the first day that does not parse is reported instead. */
export function hoursFromLines(lines: readonly string[]): { hours: Hours; invalidDay: null } | { hours: null; invalidDay: number } {
  const hours: Hours = {};
  for (let d = 0; d < 7; d++) {
    const ranges = parseHoursLine(lines[d] ?? "");
    if (!ranges) return { hours: null, invalidDay: d };
    hours[String(d)] = ranges;
  }
  return { hours, invalidDay: null };
}

/** A URL handle from a name: transliterated, lowercase, dashes. "Benji Å" → "benji-a", "Даниил" → "daniil". */
export function handleFromName(name: string): string {
  const out = transliterate(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return out.length >= 2 ? out : "coach";
}

export async function uniqueHandle(db: Db, base: string): Promise<string> {
  const root = handleFromName(base);
  for (let i = 1; i < 200; i++) {
    const candidate = i === 1 ? root : `${root}-${i}`;
    const [hit] = await db.select({ id: coaches.id }).from(coaches).where(eq(coaches.handle, candidate)).limit(1);
    if (!hit) return candidate;
  }
  throw new DomainError("invalid", "handle");
}

export const cleanClubNames = (names: string[] | string | null | undefined): string[] => {
  const list = Array.isArray(names) ? names : (names ?? "").split(/[,;\n]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const n = raw.replace(/\s+/g, " ").trim().slice(0, 60);
    if (n && !seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      out.push(n);
    }
  }
  return out.slice(0, 5);
};

export type CreateCoachInput = { playerId: string; displayName: string; clubNames?: string[] | string | null; lessonMinutes?: number; hours?: Hours; tz: string; languages?: string[] };

export async function createCoach(db: Db, input: CreateCoachInput): Promise<Coach> {
  return (await insertCoach(db, input)).coach;
}

/** The same, saying whether a book was made or an existing one found; the unique player index decides, so two submits at once make one book. */
export async function insertCoach(db: Db, input: CreateCoachInput): Promise<{ coach: Coach; created: boolean }> {
  if (!isValidTimeZone(input.tz)) throw new DomainError("invalid", "tz");
  const existing = await getCoachByPlayerId(db, input.playerId);
  if (existing) return { coach: existing, created: false };
  const minutes = LESSON_MINUTES.includes((input.lessonMinutes ?? 60) as (typeof LESSON_MINUTES)[number]) ? (input.lessonMinutes ?? 60) : 60;
  const displayName = input.displayName.replace(/\s+/g, " ").trim().slice(0, 40) || "Coach";
  // A new book is listed from the start: while the city has founding places left, it takes one, for good.
  const founding = (await foundingPlaces(db, input.tz)) < FOUNDING_COACHES;
  const [row] = await db
    .insert(coaches)
    .values({
      playerId: input.playerId,
      foundingAt: founding ? new Date() : null,
      foundingTz: founding ? input.tz : null,
      handle: await uniqueHandle(db, displayName),
      displayName,
      clubNames: cleanClubNames(input.clubNames),
      languages: (input.languages ?? ["en"]).filter((l) => ["en", "ru", "es"].includes(l)).slice(0, 3),
      lessonMinutes: minutes,
      hours: input.hours ?? presetHours("both"),
      tz: input.tz,
    })
    .onConflictDoNothing({ target: coaches.playerId })
    .returning();
  if (row) return { coach: row, created: true };
  const raced = await getCoachByPlayerId(db, input.playerId);
  if (!raced) throw new DomainError("not_found");
  return { coach: raced, created: false };
}

/** What closing a book would take with it. Shown before the confirm, and counted again inside it. */
export type CoachBookContents = { students: number; lessons: number; packages: number; upcoming: number };

export async function coachBookContents(db: Db, coachId: string, now = new Date()): Promise<CoachBookContents> {
  const [totals] = await db
    .select({
      students: sql<number>`(select count(*)::int from ${coachStudents} where ${coachStudents.coachId} = ${coachId})`,
      lessons: sql<number>`(select count(*)::int from ${lessons} where ${lessons.coachId} = ${coachId})`,
      packages: sql<number>`(select count(*)::int from ${lessonPackages} where ${lessonPackages.coachId} = ${coachId})`,
    })
    .from(coaches)
    .where(eq(coaches.id, coachId));
  if (!totals) return { students: 0, lessons: 0, packages: 0, upcoming: 0 };
  // The time goes through gt(), not into the template above. A Date interpolated into raw sql is
  // rule 1: PGlite takes it and production does not, so the local gate passes and CI goes red.
  // Its own query, on lessons_coach_time_idx.
  const [ahead] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(lessons)
    .where(and(eq(lessons.coachId, coachId), eq(lessons.status, "booked"), gt(lessons.startsAt, now)));
  return { ...totals, upcoming: ahead?.n ?? 0 };
}

/**
 * The coach closes their own book, and it is gone: the row, and by cascade the students, lessons,
 * packages, blocks, waitlist, requests, managers and any uploaded QR. The public page at /c/{handle}
 * stops existing and the handle is free again.
 *
 * Why delete rather than archive. `coaches.archived_at` exists and every lookup already filters on it,
 * but `coaches_player_idx` is unique on `player_id` with no partial clause, so an archived row still
 * holds that player's one slot: `insertCoach` would then find nothing (archived), hit the conflict,
 * and throw not_found. Archiving a book would quietly end that person's ability to ever coach again.
 * Until that index is partial, archiving is not a way back and this is.
 *
 * A lesson somebody is waiting for is not deleted from under them: a booked lesson still to come
 * refuses the whole thing, and the coach cancels it through the path that tells the student.
 * Only the coach may do this, never a manager — a manager runs a book, they do not own it.
 */
export async function deleteCoachBook(db: Db, input: { coachId: string; actorPlayerId: string }, now = new Date()): Promise<CoachBookContents> {
  const [coach] = await db.select().from(coaches).where(eq(coaches.id, input.coachId));
  if (!coach) throw new DomainError("not_found");
  if (coach.playerId !== input.actorPlayerId) throw new DomainError("forbidden");
  const contents = await coachBookContents(db, coach.id, now);
  if (contents.upcoming > 0) throw new DomainError("has_lessons");
  await db.delete(coaches).where(eq(coaches.id, coach.id));
  return contents;
}

export async function getCoachByHandle(db: Db, handle: string): Promise<Coach | null> {
  if (!HANDLE_RE.test(handle)) return null;
  const [row] = await db.select().from(coaches).where(and(eq(coaches.handle, handle), isNull(coaches.archivedAt))).limit(1);
  return row ?? null;
}

export async function getCoachByPlayerId(db: Db, playerId: string): Promise<Coach | null> {
  const [row] = await db.select().from(coaches).where(and(eq(coaches.playerId, playerId), isNull(coaches.archivedAt))).limit(1);
  return row ?? null;
}

/** The book a person may operate: their own, or one they manage. */
export async function getCoachForActor(db: Db, playerId: string): Promise<{ coach: Coach; role: "coach" | "manager" } | null> {
  const own = await getCoachByPlayerId(db, playerId);
  if (own) return { coach: own, role: "coach" };
  const [m] = await db
    .select({ coach: coaches })
    .from(coachManagers)
    .innerJoin(coaches, eq(coaches.id, coachManagers.coachId))
    .where(and(eq(coachManagers.playerId, playerId), isNull(coaches.archivedAt)))
    .limit(1);
  return m ? { coach: m.coach, role: "manager" } : null;
}

export const isCoachActor = async (db: Db, playerId: string): Promise<boolean> => (await getCoachForActor(db, playerId)) !== null;

/** A payment link a student can open: http(s), at least a few characters, no spaces. */
export const isPayLink = (s: string): boolean => /^https?:\/\/\S{4,200}$/.test(s);

export type CoachPatch = Partial<Pick<Coach, "displayName" | "bio" | "clubNames" | "clubSlugs" | "languages" | "lessonMinutes" | "hours" | "tz" | "cutoffHours" | "latePasses" | "minNoticeHours" | "priceSingle" | "currency" | "payAtClub" | "promptpayId" | "payLink" | "qrAssetId" | "whatsapp" | "isPublic">>;

export async function updateCoach(db: Db, coachId: string, patch: CoachPatch): Promise<Coach> {
  const clean: CoachPatch = { ...patch };
  if (clean.tz !== undefined && !isValidTimeZone(clean.tz)) throw new DomainError("invalid", "tz");
  if (clean.lessonMinutes !== undefined && !LESSON_MINUTES.includes(clean.lessonMinutes as (typeof LESSON_MINUTES)[number])) throw new DomainError("invalid", "minutes");
  if (clean.cutoffHours !== undefined) clean.cutoffHours = Math.min(72, Math.max(0, Math.round(clean.cutoffHours)));
  if (clean.latePasses !== undefined) clean.latePasses = Math.min(5, Math.max(0, Math.round(clean.latePasses)));
  if (clean.minNoticeHours !== undefined) clean.minNoticeHours = Math.min(48, Math.max(0, Math.round(clean.minNoticeHours)));
  if (clean.displayName !== undefined) clean.displayName = clean.displayName.replace(/\s+/g, " ").trim().slice(0, 40) || undefined;
  if (clean.whatsapp !== undefined) clean.whatsapp = (clean.whatsapp ?? "").replace(/\D/g, "").slice(0, 15) || null;
  // A price is whole currency units and never negative; zero or blank means this coach sells packages only.
  if (clean.priceSingle !== undefined) clean.priceSingle = clean.priceSingle === null ? null : Math.min(1_000_000, Math.max(0, Math.round(clean.priceSingle))) || null;
  if (clean.currency !== undefined) clean.currency = (clean.currency || "THB").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || "THB";
  if (clean.clubSlugs !== undefined) clean.clubSlugs = [...new Set(clean.clubSlugs)].filter(Boolean).slice(0, 8);
  // Founding places: listing the book for the first time takes one while the city has any; moving city takes one there when
  // that city has any (a Bangkok founder does not walk into a full Singapore with a badge) and gives the old one back.
  const extra: Partial<typeof coaches.$inferInsert> = {};
  if (clean.isPublic === true || clean.tz !== undefined) {
    const [cur] = await db.select({ isPublic: coaches.isPublic, foundingAt: coaches.foundingAt, foundingTz: coaches.foundingTz, tz: coaches.tz }).from(coaches).where(eq(coaches.id, coachId)).limit(1);
    if (cur) {
      const tz = clean.tz ?? cur.tz;
      const listed = clean.isPublic ?? cur.isPublic;
      const moving = clean.tz !== undefined && clean.tz !== cur.tz;
      const holdsHere = Boolean(cur.foundingAt) && cur.foundingTz === tz;
      if (!holdsHere && listed && (moving || (!cur.isPublic && !cur.foundingAt))) {
        if ((await foundingPlaces(db, tz)) < FOUNDING_COACHES) Object.assign(extra, { foundingAt: new Date(), foundingTz: tz });
        else if (moving) Object.assign(extra, { foundingAt: null, foundingTz: null });
      }
    }
  }
  if (clean.promptpayId !== undefined) clean.promptpayId = (clean.promptpayId ?? "").replace(/[^\d+]/g, "").slice(0, 20) || null;
  if (clean.payLink !== undefined) clean.payLink = isPayLink((clean.payLink ?? "").trim()) ? (clean.payLink ?? "").trim() : null;
  if (clean.bio !== undefined) clean.bio = (clean.bio ?? "").replace(/\s+/g, " ").trim().slice(0, 240) || null;
  if (clean.clubNames !== undefined) clean.clubNames = cleanClubNames(clean.clubNames);
  const [row] = await db
    .update(coaches)
    .set({ ...clean, ...extra, updatedAt: new Date() })
    .where(eq(coaches.id, coachId))
    .returning();
  if (!row) throw new DomainError("not_found");
  return row;
}

// ---------------------------------------------------------------- students

export async function studentStatus(db: Db, coachId: string, playerId: string): Promise<StudentStatus> {
  const [row] = await db.select({ status: coachStudents.status }).from(coachStudents).where(and(eq(coachStudents.coachId, coachId), eq(coachStudents.playerId, playerId))).limit(1);
  return (row?.status as StudentStatus | undefined) ?? "none";
}

/** A player asks to become a student. Idempotent; a paused or accepted student keeps their status. */
export async function requestStudent(db: Db, coachId: string, playerId: string): Promise<StudentStatus> {
  const current = await studentStatus(db, coachId, playerId);
  if (current !== "none") return current;
  await db.insert(coachStudents).values({ coachId, playerId, status: "requested" }).onConflictDoNothing();
  return "requested";
}

export async function setStudentStatus(db: Db, coachId: string, playerId: string, status: Exclude<StudentStatus, "none">): Promise<void> {
  const now = new Date();
  await db
    .insert(coachStudents)
    .values({ coachId, playerId, status, acceptedAt: status === "accepted" ? now : null })
    .onConflictDoUpdate({ target: [coachStudents.coachId, coachStudents.playerId], set: { status, ...(status === "accepted" ? { acceptedAt: now } : {}) } });
}

/** The code in the coach's student link, minted once. A student who opens the link is on the list without asking. */
/** The coach's invite code: the one on the row, or minted once (an atomic claim, so two renders at the same moment agree). */
export async function inviteCode(db: Db, coach: Pick<Coach, "id" | "inviteCode">): Promise<string> {
  if (coach.inviteCode) return coach.inviteCode;
  const [minted] = await db
    .update(coaches)
    .set({ inviteCode: newCoachCode(), updatedAt: new Date() })
    .where(and(eq(coaches.id, coach.id), isNull(coaches.inviteCode)))
    .returning({ code: coaches.inviteCode });
  if (minted?.code) return minted.code;
  const [row] = await db.select({ code: coaches.inviteCode }).from(coaches).where(eq(coaches.id, coach.id)).limit(1);
  if (!row?.code) throw new DomainError("not_found", "coach");
  return row.code;
}

/** The link the coach forwards: their page with the invite code, so the student lands on the list. */
export const studentLink = (base: string, handle: string, code: string): string => `${base}/c/${handle}?i=${code}`;

/** True when this code is the coach's live invite code (case-sensitive, eight characters). A repeated query key arrives as an array and is not a code. */
export const inviteMatches = (coach: Pick<Coach, "inviteCode">, code: unknown): boolean => typeof code === "string" && Boolean(coach.inviteCode) && code.trim() === coach.inviteCode;

/**
 * Opening the coach's link: the player becomes an accepted student (a paused one
 * stays paused, an accepted one stays). The coach and their managers are not
 * their own students: opening their own link changes nothing.
 */
export async function acceptByInvite(db: Db, coachId: string, playerId: string): Promise<StudentStatus> {
  const current = await studentStatus(db, coachId, playerId);
  if (current === "accepted" || current === "paused") return current;
  const mine = await getCoachForActor(db, playerId);
  if (mine?.coach.id === coachId) return current;
  await setStudentStatus(db, coachId, playerId, "accepted");
  return "accepted";
}

/** The invitation to pass the assistant on waits until the book has earned it: three students on the list, or five lessons done, ever. */
export const earnedInvite = (students: Pick<StudentRow, "status" | "lessonsDone">[]): boolean => students.filter((s) => s.status !== "requested").length >= 3 || students.reduce((n, s) => n + s.lessonsDone, 0) >= 5;

/** The coach adds a student by name (courtside, no phone needed): a player is created and accepted at once. */
/**
 * A name arrives here as the coach typed it into a chat — "pat +10" makes a student called "pat",
 * lower case, in their list, in every notice they ever get, and on that person's own profile. It is
 * a name, so it is capitalised; a name typed with any capital of its own is left exactly as typed,
 * because "María José" and "McDonald" know better than this function does.
 */
const asName = (raw: string) =>
  raw === raw.toLocaleLowerCase()
    ? raw.replace(/(^|[\s'’-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toLocaleUpperCase())
    : raw;

export async function addStudentByName(db: Db, coachId: string, name: string, locale: string, email?: string | null): Promise<Player> {
  const player = await createPlayer(db, { displayName: asName(name), locale, email: email ?? null });
  await setStudentStatus(db, coachId, player.id, "accepted");
  return player;
}

export async function listStudents(db: Db, coachId: string, now = new Date()): Promise<StudentRow[]> {
  const rows = await db
    .select({ student: coachStudents, player: players })
    .from(coachStudents)
    .innerJoin(players, eq(players.id, coachStudents.playerId))
    .where(eq(coachStudents.coachId, coachId))
    .orderBy(asc(players.displayName));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.player.id);
  const [packs, done] = await Promise.all([
    db
      .select()
      .from(lessonPackages)
      .where(and(eq(lessonPackages.coachId, coachId), inArray(lessonPackages.studentPlayerId, ids), isNull(lessonPackages.closedAt)))
      .orderBy(asc(lessonPackages.expiresAt), asc(lessonPackages.createdAt)),
    db
      .select({ studentPlayerId: lessons.studentPlayerId, n: sql<number>`count(*)` })
      .from(lessons)
      .where(and(eq(lessons.coachId, coachId), inArray(lessons.studentPlayerId, ids), eq(lessons.status, "done")))
      .groupBy(lessons.studentPlayerId),
  ]);
  const doneBy = new Map(done.map((d) => [d.studentPlayerId, Number(d.n)]));
  return rows.map(({ student, player }) => ({
    ...student,
    player,
    activePackage: packs.find((p) => p.studentPlayerId === player.id && isPackageOpen(p, now)) ?? null,
    lessonsDone: doneBy.get(player.id) ?? 0,
  }));
}

// ---------------------------------------------------------------- packages

export const isPackageOpen = (p: LessonPackage, now = new Date()): boolean => !p.closedAt && p.used < p.size && (!p.expiresAt || p.expiresAt.getTime() > now.getTime());

/** "6 of 10 left, 23 days": the numbers shown under every lesson. */
export function packageLine(p: LessonPackage, now = new Date()): { left: number; daysLeft: number | null; expired: boolean } {
  const left = Math.max(0, p.size - p.used);
  const daysLeft = p.expiresAt ? Math.ceil((p.expiresAt.getTime() - now.getTime()) / DAY_MS) : null;
  return { left, daysLeft, expired: daysLeft !== null && daysLeft <= 0 };
}

export type CreatePackageInput = { coachId: string; studentPlayerId: string; size: number; validDays?: number | null; expiresAt?: Date | null; amount?: number | null; currency?: string | null; note?: string | null; paid?: boolean; /** Lessons already taken before the package came here (a sheet import). */ used?: number | null };

export async function createPackage(db: Db, input: CreatePackageInput, now = new Date()): Promise<LessonPackage> {
  const size = Math.round(input.size);
  if (!Number.isFinite(size) || size < 1 || size > 200) throw new DomainError("invalid", "size");
  const expiresAt = input.expiresAt ?? (input.validDays ? new Date(now.getTime() + Math.min(730, Math.max(1, Math.round(input.validDays))) * DAY_MS) : null);
  const amount = typeof input.amount === "number" && Number.isFinite(input.amount) && input.amount > 0 ? Math.round(input.amount) : null;
  const [row] = await db
    .insert(lessonPackages)
    .values({
      coachId: input.coachId,
      studentPlayerId: input.studentPlayerId,
      size,
      used: Math.min(size, Math.max(0, Math.round(input.used ?? 0))),
      expiresAt,
      amount,
      currency: (input.currency ?? "THB").toUpperCase().slice(0, 3),
      note: input.note?.trim().slice(0, 120) || null,
      paidAt: input.paid ? now : null,
      createdAt: now,
    })
    .returning();
  await setStudentStatus(db, input.coachId, input.studentPlayerId, "accepted");
  return row;
}

/** The package a new lesson draws from: open, with lessons left, the one expiring soonest first. */
export async function activePackage(db: Db, coachId: string, studentPlayerId: string, now = new Date()): Promise<LessonPackage | null> {
  const rows = await db
    .select()
    .from(lessonPackages)
    .where(and(eq(lessonPackages.coachId, coachId), eq(lessonPackages.studentPlayerId, studentPlayerId), isNull(lessonPackages.closedAt)))
    .orderBy(asc(lessonPackages.expiresAt), asc(lessonPackages.createdAt));
  return rows.find((p) => isPackageOpen(p, now)) ?? null;
}

export async function setPackagePaid(db: Db, coachId: string, packageId: string, paid: boolean): Promise<void> {
  await db
    .update(lessonPackages)
    .set({ paidAt: paid ? new Date() : null })
    .where(and(eq(lessonPackages.id, packageId), eq(lessonPackages.coachId, coachId)));
}

export async function extendPackage(db: Db, coachId: string, packageId: string, days: number): Promise<LessonPackage> {
  const [p] = await db.select().from(lessonPackages).where(and(eq(lessonPackages.id, packageId), eq(lessonPackages.coachId, coachId))).limit(1);
  if (!p) throw new DomainError("not_found");
  const base = p.expiresAt && p.expiresAt.getTime() > Date.now() ? p.expiresAt : new Date();
  const [row] = await db
    .update(lessonPackages)
    .set({ expiresAt: new Date(base.getTime() + Math.max(1, Math.round(days)) * DAY_MS) })
    .where(eq(lessonPackages.id, packageId))
    .returning();
  return row;
}

export async function closePackage(db: Db, coachId: string, packageId: string): Promise<void> {
  await db
    .update(lessonPackages)
    .set({ closedAt: new Date() })
    .where(and(eq(lessonPackages.id, packageId), eq(lessonPackages.coachId, coachId)));
}

// ---------------------------------------------------------------- availability

const overlaps = (aStart: number, aEnd: number, b: Busy) => aStart < b.endsAt.getTime() && aEnd > b.startsAt.getTime();

/** Pure: the slot starts (UTC) the template offers between `from` and `to`, minus busy time, minus anything sooner than the notice. */
export function openSlots(opts: { coach: Pick<Coach, "hours" | "tz" | "lessonMinutes" | "minNoticeHours">; from: Date; to: Date; busy: Busy[]; now: Date; minutes?: number }): Date[] {
  const { coach, from, to, busy, now } = opts;
  const minutes = opts.minutes ?? coach.lessonMinutes;
  const earliest = Math.max(from.getTime(), now.getTime() + coach.minNoticeHours * HOUR_MS);
  const out: Date[] = [];
  const first = utcToZonedParts(from, coach.tz).date;
  const last = utcToZonedParts(to, coach.tz).date;
  let cursor = Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1, Number(first.slice(8, 10)));
  const end = Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)) - 1, Number(last.slice(8, 10)));
  while (cursor <= end) {
    const day = new Date(cursor);
    const dateStr = day.toISOString().slice(0, 10);
    const ranges = coach.hours[String(day.getUTCDay())] ?? [];
    for (const [start, stop] of ranges) {
      let t = minutesOf(start);
      const stopMin = minutesOf(stop);
      while (Number.isFinite(t) && t + minutes <= stopMin) {
        const hh = String(Math.floor(t / 60)).padStart(2, "0");
        const mm = String(t % 60).padStart(2, "0");
        const slot = zonedTimeToUtc(dateStr, `${hh}:${mm}`, coach.tz);
        const s = slot.getTime();
        const e = s + minutes * 60_000;
        if (s >= earliest && s <= to.getTime() && !busy.some((b) => overlaps(s, e, b))) out.push(slot);
        t += minutes;
      }
    }
    cursor += DAY_MS;
  }
  return out;
}

/** Everything that occupies the coach between two instants: booked lessons and blocks. */
export async function busyBetween(db: Db, coachId: string, from: Date, to: Date): Promise<Busy[]> {
  const [ls, bs] = await Promise.all([
    db
      .select({ startsAt: lessons.startsAt, minutes: lessons.minutes })
      .from(lessons)
      .where(and(eq(lessons.coachId, coachId), eq(lessons.status, "booked"), gte(lessons.startsAt, new Date(from.getTime() - 4 * HOUR_MS)), lte(lessons.startsAt, to))),
    db
      .select({ startsAt: coachBlocks.startsAt, endsAt: coachBlocks.endsAt })
      .from(coachBlocks)
      .where(and(eq(coachBlocks.coachId, coachId), lt(coachBlocks.startsAt, to), gt(coachBlocks.endsAt, from))),
  ]);
  return [...ls.map((l) => ({ startsAt: l.startsAt, endsAt: new Date(l.startsAt.getTime() + l.minutes * 60_000) })), ...bs];
}

/**
 * The coach takes an hour back for themselves: lunch, a match, the school run. This is what the
 * Google Calendar connection was standing in for, and it needs no connection at all — a coach on a
 * phone can do it from their own grid, which is where they already are.
 *
 * A slot a student has booked is not blockable: cancelling that lesson is a different act, with a
 * notice attached, and quietly burying it under a block would leave the student expecting a lesson.
 */
export async function blockTime(db: Db, input: { coachId: string; startsAt: Date; minutes: number; reason?: string | null }, now = new Date()): Promise<CoachBlock> {
  const startsAt = new Date(Math.floor(input.startsAt.getTime() / 60_000) * 60_000);
  const minutes = Math.min(24 * 60, Math.max(15, Math.round(input.minutes)));
  const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
  if (endsAt.getTime() <= now.getTime()) throw new DomainError("past");
  // A lesson that ends exactly when the block starts does not clash, so the lesson's own length has
  // to come into it: comparing start times alone refused blocks that were perfectly free.
  const near = await db
    .select({ startsAt: lessons.startsAt, minutes: lessons.minutes })
    .from(lessons)
    .where(and(eq(lessons.coachId, input.coachId), eq(lessons.status, "booked"), lt(lessons.startsAt, endsAt), gte(lessons.startsAt, new Date(startsAt.getTime() - 4 * HOUR_MS))));
  if (near.some((l) => overlaps(startsAt.getTime(), endsAt.getTime(), { startsAt: l.startsAt, endsAt: new Date(l.startsAt.getTime() + l.minutes * 60_000) }))) throw new DomainError("slot_taken");
  const [block] = await db
    .insert(coachBlocks)
    .values({ coachId: input.coachId, startsAt, endsAt, reason: input.reason?.trim().slice(0, 120) || null, source: "web" })
    .returning();
  return block;
}

/** Only a block the coach made here comes back this way; a calendar's blocks belong to the calendar. */
export async function unblockTime(db: Db, coachId: string, blockId: string): Promise<boolean> {
  const done = await db.delete(coachBlocks).where(and(eq(coachBlocks.id, blockId), eq(coachBlocks.coachId, coachId), eq(coachBlocks.source, "web"))).returning({ id: coachBlocks.id });
  return done.length > 0;
}

export type Owed = { lessons: { id: string; startsAt: Date; amount: number; claimedAt: Date | null }[]; packages: { id: string; size: number; amount: number; claimedAt: Date | null }[]; total: number; currency: string };

/**
 * What this student owes this coach, and whether they have already said they paid.
 *
 * No money moves through Kicksmash and none is meant to. This exists so the student can see a number
 * and a way to pay it, instead of asking on WhatsApp — which was the second of the three messages a
 * coach still got. The coach confirms; a student's claim asks, it does not answer.
 */
export async function owedBy(db: Db, coach: Pick<Coach, "id" | "currency">, studentPlayerId: string): Promise<Owed> {
  const ls = await db
    .select({ id: lessons.id, startsAt: lessons.startsAt, amount: lessons.amount, claimedAt: lessons.paidClaimedAt })
    .from(lessons)
    .where(and(eq(lessons.coachId, coach.id), eq(lessons.studentPlayerId, studentPlayerId), isNull(lessons.paidAt), inArray(lessons.status, ["booked", "done", "late_cancelled", "no_show"])))
    .orderBy(asc(lessons.startsAt))
    .limit(50);
  const ps = await db
    .select({ id: lessonPackages.id, size: lessonPackages.size, amount: lessonPackages.amount, claimedAt: lessonPackages.paidAt })
    .from(lessonPackages)
    .where(and(eq(lessonPackages.coachId, coach.id), eq(lessonPackages.studentPlayerId, studentPlayerId), isNull(lessonPackages.paidAt), isNull(lessonPackages.closedAt)))
    .orderBy(asc(lessonPackages.createdAt))
    .limit(20);
  const openLessons = ls.filter((l) => (l.amount ?? 0) > 0).map((l) => ({ id: l.id, startsAt: l.startsAt, amount: l.amount as number, claimedAt: l.claimedAt }));
  const openPackages = ps.filter((p) => (p.amount ?? 0) > 0).map((p) => ({ id: p.id, size: p.size, amount: p.amount as number, claimedAt: null }));
  return {
    lessons: openLessons,
    packages: openPackages,
    total: openLessons.reduce((n, l) => n + l.amount, 0) + openPackages.reduce((n, p) => n + p.amount, 0),
    currency: coach.currency,
  };
}

export type OwedRow = { lessonId: string; startsAt: Date; amount: number; claimedAt: Date | null; studentPlayerId: string; name: string };

/**
 * Everyone who still owes this coach, newest lesson last. One query with a join rather than
 * `owedBy` per student: the coach's assistant asks this from a chat message, so it has to stay one
 * round trip however many students there are (rule 12). Bounded at 20 because a list longer than
 * that is a spreadsheet, not a chat message.
 */
export async function owedToCoach(db: Db, coachId: string, limit = 20): Promise<OwedRow[]> {
  const rows = await db
    .select({ lessonId: lessons.id, startsAt: lessons.startsAt, amount: lessons.amount, claimedAt: lessons.paidClaimedAt, studentPlayerId: lessons.studentPlayerId, name: players.displayName })
    .from(lessons)
    .innerJoin(players, eq(players.id, lessons.studentPlayerId))
    .where(and(eq(lessons.coachId, coachId), isNull(lessons.paidAt), gt(lessons.amount, 0), inArray(lessons.status, ["booked", "done", "late_cancelled", "no_show"])))
    .orderBy(asc(lessons.startsAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, amount: r.amount as number, studentPlayerId: r.studentPlayerId as string }));
}

/** The student says the money is sent. It asks the coach; only the coach's tap marks it paid. */
export async function claimLessonPaid(db: Db, lessonId: string, studentPlayerId: string, now = new Date()): Promise<Lesson | null> {
  const [row] = await db
    .update(lessons)
    .set({ paidClaimedAt: now })
    .where(and(eq(lessons.id, lessonId), eq(lessons.studentPlayerId, studentPlayerId), isNull(lessons.paidAt)))
    .returning();
  return row ?? null;
}

/** The coach confirms it landed. This is the only thing that marks a lesson paid. */
export async function setLessonPaid(db: Db, coachId: string, lessonId: string, paid: boolean, now = new Date()): Promise<Lesson | null> {
  const [row] = await db
    .update(lessons)
    .set({ paidAt: paid ? now : null })
    .where(and(eq(lessons.id, lessonId), eq(lessons.coachId, coachId)))
    .returning();
  return row ?? null;
}

export async function availableSlots(db: Db, coach: Coach, from: Date, to: Date, now = new Date()): Promise<Date[]> {
  const busy = await busyBetween(db, coach.id, from, to);
  return openSlots({ coach, from, to, busy, now });
}

/** True when `at` starts inside the weekly template (used to tell a student's booking from a coach's exception). */
export function withinHours(coach: Pick<Coach, "hours" | "tz">, at: Date, minutes: number): boolean {
  const { date, time } = utcToZonedParts(at, coach.tz);
  const dow = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))).getUTCDay();
  const t = minutesOf(time);
  return (coach.hours[String(dow)] ?? []).some(([a, b]) => t >= minutesOf(a) && t + minutes <= minutesOf(b));
}

// ---------------------------------------------------------------- lessons

export type BookLessonInput = { coach: Coach; studentPlayerId: string; startsAt: Date; byCoach: boolean; source?: string; createdByPlayerId?: string | null; minutes?: number; note?: string | null };

/**
 * Books one lesson. A student needs to be accepted, inside the hours, after the notice.
 * The coach may book anyone, any time, as long as the slot is free. An open package is
 * drawn from at booking time and refunded on a timely cancellation.
 */
export async function bookLesson(db: Db, input: BookLessonInput, now = new Date()): Promise<{ lesson: Lesson; package: LessonPackage | null }> {
  const { coach } = input;
  const minutes = input.minutes ?? coach.lessonMinutes;
  const startsAt = new Date(Math.floor(input.startsAt.getTime() / 60_000) * 60_000);
  if (startsAt.getTime() <= now.getTime()) throw new DomainError("past");
  if (!input.byCoach) {
    if ((await studentStatus(db, coach.id, input.studentPlayerId)) !== "accepted") throw new DomainError("not_student");
    if (startsAt.getTime() < now.getTime() + coach.minNoticeHours * HOUR_MS) throw new DomainError("too_soon");
    if (!withinHours(coach, startsAt, minutes)) throw new DomainError("outside_hours");
  }
  const end = new Date(startsAt.getTime() + minutes * 60_000);
  const busy = await busyBetween(db, coach.id, startsAt, end);
  if (busy.some((b) => overlaps(startsAt.getTime(), end.getTime(), b))) throw new DomainError("slot_taken");
  const pkg = await activePackage(db, coach.id, input.studentPlayerId, now);
  const [lesson] = await db
    .insert(lessons)
    .values({
      coachId: coach.id,
      studentPlayerId: input.studentPlayerId,
      packageId: pkg?.id ?? null,
      startsAt,
      minutes,
      status: "booked",
      source: input.source ?? "web",
      consumed: Boolean(pkg),
      // No package paying for it: the lesson carries the coach's price as it stood when it was booked,
      // so raising the price next month never rewrites what last month's lessons cost.
      amount: pkg ? null : (coach.priceSingle ?? null),
      note: input.note?.trim().slice(0, 200) || null,
      createdByPlayerId: input.createdByPlayerId ?? null,
      createdAt: now,
    })
    .returning();
  let fresh = pkg;
  if (pkg) {
    const [p] = await db
      .update(lessonPackages)
      .set({ used: sql`${lessonPackages.used} + 1` })
      .where(eq(lessonPackages.id, pkg.id))
      .returning();
    fresh = p;
  }
  if (input.byCoach) await setStudentStatus(db, coach.id, input.studentPlayerId, "accepted");
  await recordFact(db, {
    kind: "lesson.booked",
    channel: channelOf(input.source),
    actorPlayerId: input.createdByPlayerId ?? input.studentPlayerId,
    subject: { type: "lesson", id: lesson.id },
    code: coach.handle,
    city: cityOf(coach.tz, null)?.slug ?? null,
    data: { byCoach: input.byCoach, minutes, packaged: Boolean(pkg) },
  });
  return { lesson, package: fresh };
}

async function refund(db: Db, lesson: Lesson): Promise<void> {
  if (!lesson.consumed || !lesson.packageId) return;
  await db
    .update(lessonPackages)
    .set({ used: sql`greatest(${lessonPackages.used} - 1, 0)` })
    .where(eq(lessonPackages.id, lesson.packageId));
}

/**
 * The cancellation policy. By the coach: never counts. By the student before the cutoff:
 * refunded. After the cutoff: a free pass if the package has one left, otherwise it counts.
 */
export type MoveLessonInput = { lessonId: string; coach: Coach; startsAt: Date; by: "coach" | "student"; actorPlayerId?: string | null; source?: string | null };

/**
 * Move a lesson. "Can we do Friday instead?" is the most common message a coach gets, and until now
 * the only answer was cancel and book again — which burned the student's free late pass, and handed
 * their slot to the waitlist before they had chosen a new one, so they could end up with neither.
 *
 * This moves the row. The package is not touched at all, because a move is not a cancellation
 * followed by a purchase: the same lesson happens at a different hour. That also removes the window
 * a book-then-cancel would have left, where the old slot is gone and the new one is not yet taken.
 *
 * A student may move while the lesson is still outside the cutoff. Inside it they cancel under the
 * usual policy, which is not meanness: without that line a student could move an hour beforehand to
 * next month for free and cancel that for free, and the late-cancel rule would mean nothing.
 */
export async function moveLesson(db: Db, input: MoveLessonInput, now = new Date()): Promise<{ from: Lesson; to: Lesson }> {
  const { coach } = input;
  const [lesson] = await db.select().from(lessons).where(and(eq(lessons.id, input.lessonId), eq(lessons.coachId, coach.id))).limit(1);
  if (!lesson) throw new DomainError("not_found");
  if (lesson.status !== "booked") throw new DomainError("cancelled");
  if (input.by === "student" && input.actorPlayerId && lesson.studentPlayerId !== input.actorPlayerId) throw new DomainError("forbidden");

  const startsAt = new Date(Math.floor(input.startsAt.getTime() / 60_000) * 60_000);
  if (startsAt.getTime() === lesson.startsAt.getTime()) return { from: lesson, to: lesson };
  if (startsAt.getTime() <= now.getTime()) throw new DomainError("past");
  if (input.by === "student") {
    if (lesson.startsAt.getTime() - now.getTime() < coach.cutoffHours * HOUR_MS) throw new DomainError("too_late");
    if (startsAt.getTime() < now.getTime() + coach.minNoticeHours * HOUR_MS) throw new DomainError("too_soon");
    if (!withinHours(coach, startsAt, lesson.minutes)) throw new DomainError("outside_hours");
  }

  const end = new Date(startsAt.getTime() + lesson.minutes * 60_000);
  // Everything busy at the new hour except this lesson, which is about to stop being there.
  const busy = (await busyBetween(db, coach.id, startsAt, end)).filter((b) => !(b.startsAt.getTime() === lesson.startsAt.getTime() && b.endsAt.getTime() === lesson.startsAt.getTime() + lesson.minutes * 60_000));
  if (busy.some((b) => overlaps(startsAt.getTime(), end.getTime(), b))) throw new DomainError("slot_taken");

  const [moved] = await db.update(lessons).set({ startsAt }).where(eq(lessons.id, lesson.id)).returning();
  await recordFact(db, {
    kind: "lesson.moved",
    channel: channelOf(input.source),
    actorPlayerId: input.actorPlayerId ?? null,
    subject: { type: "lesson", id: lesson.id },
    code: coach.handle,
    city: cityOf(coach.tz, null)?.slug ?? null,
    data: { by: input.by, from: lesson.startsAt.toISOString(), to: startsAt.toISOString() },
  });
  return { from: lesson, to: moved };
}

export async function cancelLesson(db: Db, input: { lessonId: string; by: "coach" | "student"; coach: Coach; actorPlayerId?: string | null; source?: string | null }, now = new Date()): Promise<{ lesson: Lesson; outcome: CancelOutcome }> {
  const [lesson] = await db.select().from(lessons).where(and(eq(lessons.id, input.lessonId), eq(lessons.coachId, input.coach.id))).limit(1);
  if (!lesson) throw new DomainError("not_found");
  if (lesson.status !== "booked") throw new DomainError("cancelled");
  if (input.by === "student" && input.actorPlayerId && lesson.studentPlayerId !== input.actorPlayerId) throw new DomainError("forbidden");
  let outcome: CancelOutcome = lesson.consumed ? "refunded" : "none";
  let status: LessonStatus = input.by === "coach" ? "cancelled" : "cancelled_by_student";
  let freePass = false;
  if (input.by === "student" && lesson.startsAt.getTime() - now.getTime() < input.coach.cutoffHours * HOUR_MS) {
    status = "late_cancelled";
    if (lesson.consumed && lesson.packageId) {
      const [pkg] = await db.select().from(lessonPackages).where(eq(lessonPackages.id, lesson.packageId)).limit(1);
      if (pkg && pkg.latePassesUsed < input.coach.latePasses) {
        freePass = true;
        outcome = "free_pass";
        await db
          .update(lessonPackages)
          .set({ latePassesUsed: sql`${lessonPackages.latePassesUsed} + 1` })
          .where(eq(lessonPackages.id, pkg.id));
      } else outcome = "counted";
    } else outcome = "none";
  }
  if (outcome === "refunded" || outcome === "free_pass") await refund(db, lesson);
  const [updated] = await db
    .update(lessons)
    .set({ status, freePass, cancelledAt: now, consumed: outcome === "counted" })
    .where(eq(lessons.id, lesson.id))
    .returning();
  await recordFact(db, {
    kind: "lesson.cancelled",
    channel: channelOf(input.source),
    actorPlayerId: input.actorPlayerId ?? null,
    subject: { type: "lesson", id: lesson.id },
    code: input.coach.handle,
    city: cityOf(input.coach.tz, null)?.slug ?? null,
    data: { by: input.by, outcome, status },
  });
  return { lesson: updated, outcome };
}

/** Hourly: a lesson whose time has passed is done. The coach can still mark a no-show. */
export async function completePastLessons(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .update(lessons)
    .set({ status: "done" })
    .where(and(eq(lessons.status, "booked"), sql`${lessons.startsAt} + make_interval(mins => ${lessons.minutes}) < ${now.toISOString()}::timestamptz`))
    .returning({ id: lessons.id });
  return rows.length;
}

export async function markNoShow(db: Db, coachId: string, lessonId: string): Promise<void> {
  await db
    .update(lessons)
    .set({ status: "no_show" })
    .where(and(eq(lessons.id, lessonId), eq(lessons.coachId, coachId), inArray(lessons.status, ["booked", "done"])));
}

export async function listCoachLessons(db: Db, coachId: string, from: Date, to: Date): Promise<LessonWithPeople[]> {
  const rows = await db
    .select({ lesson: lessons, student: players, pkg: lessonPackages })
    .from(lessons)
    .leftJoin(players, eq(players.id, lessons.studentPlayerId))
    .leftJoin(lessonPackages, eq(lessonPackages.id, lessons.packageId))
    .where(and(eq(lessons.coachId, coachId), gte(lessons.startsAt, from), lt(lessons.startsAt, to)))
    .orderBy(asc(lessons.startsAt));
  return rows.map((r) => ({ ...r.lesson, student: r.student, package: r.pkg }));
}

export type StudentLesson = Lesson & { coach: Coach; package: LessonPackage | null };

export async function listStudentLessons(db: Db, playerId: string, from: Date, limit = 20): Promise<StudentLesson[]> {
  const rows = await db
    .select({ lesson: lessons, coach: coaches, pkg: lessonPackages })
    .from(lessons)
    .innerJoin(coaches, eq(coaches.id, lessons.coachId))
    .leftJoin(lessonPackages, eq(lessonPackages.id, lessons.packageId))
    .where(and(eq(lessons.studentPlayerId, playerId), gte(lessons.startsAt, from), or(eq(lessons.status, "booked"), eq(lessons.status, "done"))))
    .orderBy(asc(lessons.startsAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.lesson, coach: r.coach, package: r.pkg }));
}

/** The coaches a player is attached to (asked, accepted or paused), newest first; no package lookups. */
export async function listStudentCoaches(db: Db, playerId: string): Promise<Pick<StudentCoach, "coach" | "status">[]> {
  const rows = await db
    .select({ status: coachStudents.status, coach: coaches })
    .from(coachStudents)
    .innerJoin(coaches, eq(coaches.id, coachStudents.coachId))
    .where(and(eq(coachStudents.playerId, playerId), isNull(coaches.archivedAt)))
    .orderBy(desc(coachStudents.createdAt));
  return rows.map((r) => ({ coach: r.coach, status: r.status as StudentStatus }));
}

/** The coaches a player is attached to, with the package that is open with each. */
export async function studentCoaches(db: Db, playerId: string, now = new Date()): Promise<StudentCoach[]> {
  const out: StudentCoach[] = [];
  for (const r of await listStudentCoaches(db, playerId)) out.push({ ...r, activePackage: await activePackage(db, r.coach.id, playerId, now) });
  return out;
}

export async function listBlocks(db: Db, coachId: string, from: Date, to: Date): Promise<CoachBlock[]> {
  return db
    .select()
    .from(coachBlocks)
    .where(and(eq(coachBlocks.coachId, coachId), lt(coachBlocks.startsAt, to), gt(coachBlocks.endsAt, from)))
    .orderBy(asc(coachBlocks.startsAt));
}

/** Students whose open package is nearly out or nearly expired: the coach's "who to nudge" list. */
export async function lowPackages(db: Db, coachId: string, now = new Date()): Promise<{ pkg: LessonPackage; player: Player; left: number; daysLeft: number | null }[]> {
  const rows = await db
    .select({ pkg: lessonPackages, player: players })
    .from(lessonPackages)
    .innerJoin(players, eq(players.id, lessonPackages.studentPlayerId))
    .where(and(eq(lessonPackages.coachId, coachId), isNull(lessonPackages.closedAt)));
  return rows
    .filter((r) => isPackageOpen(r.pkg, now))
    .map((r) => ({ ...r, ...packageLine(r.pkg, now) }))
    .filter((r) => r.left <= 2 || (r.daysLeft !== null && r.daysLeft <= 14))
    .sort((a, b) => a.left - b.left);
}

// ---------------------------------------------------------------- uploaded QR

export const QR_UPLOAD_MAX_BYTES = 400_000;

/** Stores the coach's own payment QR picture (their bank's), replacing any previous one. */
export async function setCoachQr(db: Db, coachId: string, mime: string, dataBase64: string): Promise<void> {
  if (!/^image\/(png|jpeg|webp)$/.test(mime)) throw new DomainError("invalid", "mime");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(dataBase64) || Buffer.from(dataBase64, "base64").length > QR_UPLOAD_MAX_BYTES) throw new DomainError("invalid", "size");
  const [asset] = await db.insert(coachAssets).values({ coachId, kind: "qr", mime, dataBase64: dataBase64.replace(/\s+/g, "") }).returning({ id: coachAssets.id });
  const [prev] = await db.select({ qrAssetId: coaches.qrAssetId }).from(coaches).where(eq(coaches.id, coachId)).limit(1);
  await db.update(coaches).set({ qrAssetId: asset.id, updatedAt: new Date() }).where(eq(coaches.id, coachId));
  if (prev?.qrAssetId) await db.delete(coachAssets).where(eq(coachAssets.id, prev.qrAssetId));
}

export async function removeCoachQr(db: Db, coachId: string): Promise<void> {
  const [prev] = await db.select({ qrAssetId: coaches.qrAssetId }).from(coaches).where(eq(coaches.id, coachId)).limit(1);
  await db.update(coaches).set({ qrAssetId: null, updatedAt: new Date() }).where(eq(coaches.id, coachId));
  if (prev?.qrAssetId) await db.delete(coachAssets).where(eq(coachAssets.id, prev.qrAssetId));
}

export async function getCoachQr(db: Db, coachId: string): Promise<{ mime: string; bytes: Buffer } | null> {
  const [row] = await db
    .select({ mime: coachAssets.mime, data: coachAssets.dataBase64 })
    .from(coaches)
    .innerJoin(coachAssets, eq(coachAssets.id, coaches.qrAssetId))
    .where(eq(coaches.id, coachId))
    .limit(1);
  return row ? { mime: row.mime, bytes: Buffer.from(row.data, "base64") } : null;
}

// ---------------------------------------------------------------- blocks

/** Time the coach keeps free: a whole day off or a range. Existing lessons inside stay until the coach cancels them. */
export async function addBlock(db: Db, coachId: string, from: Date, to: Date, reason?: string | null, externalId?: string | null): Promise<CoachBlock> {
  if (!(to.getTime() > from.getTime())) throw new DomainError("invalid", "range");
  const [row] = await db
    .insert(coachBlocks)
    .values({ coachId, startsAt: from, endsAt: to, reason: reason?.slice(0, 120) ?? null, externalId: externalId ?? null })
    .returning();
  return row;
}

export async function removeBlock(db: Db, coachId: string, blockId: string): Promise<void> {
  await db.delete(coachBlocks).where(and(eq(coachBlocks.id, blockId), eq(coachBlocks.coachId, coachId)));
}

export async function getLesson(db: Db, lessonId: string): Promise<Lesson | null> {
  const [row] = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  return row ?? null;
}

export async function getPlayerById(db: Db, playerId: string): Promise<Player | null> {
  const [row] = await db.select().from(players).where(eq(players.id, playerId)).limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------- findable

/** Coaches who chose to be listed, newest last; a city narrows by the coach's zone. */
export async function listPublicCoaches(db: Db, cityTz?: string | null, limit = 200): Promise<Coach[]> {
  return db
    .select()
    .from(coaches)
    .where(and(eq(coaches.isPublic, true), isNull(coaches.archivedAt), ...(cityTz ? [eq(coaches.tz, cityTz)] : [])))
    .orderBy(asc(coaches.createdAt))
    .limit(limit);
}

/** The first ten listed coaches of a city carry a founding badge, and everything stays free for them (mirrors founding clubs). */
export const FOUNDING_COACHES = 10;

/** How many founding places a city (time zone) has handed out, listed or not: ten, and then no more, whatever happens to the ten. */
export async function foundingPlaces(db: Db, tz: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(coaches)
    .where(eq(coaches.foundingTz, tz));
  return Number(row?.n ?? 0);
}
/** How many coaches are listed in a city (time zone) right now. */
export async function listedCount(db: Db, tz: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(coaches)
    .where(and(eq(coaches.isPublic, true), isNull(coaches.archivedAt), eq(coaches.tz, tz)));
  return Number(row?.n ?? 0);
}
/** The badge shows while the book is listed in the city the place was earned in; the place itself is never taken back. */
export const isFoundingCoach = (coach: Pick<Coach, "foundingAt" | "foundingTz" | "tz" | "isPublic" | "archivedAt">): boolean => Boolean(coach.foundingAt) && coach.foundingTz === coach.tz && coach.isPublic && !coach.archivedAt;

/** Listed coaches who named this club among theirs (case aside): the club page's "coaches here". */
export async function coachesAtClub(db: Db, clubName: string): Promise<Coach[]> {
  const name = clubName.trim().toLowerCase();
  if (!name) return [];
  return db
    .select()
    .from(coaches)
    .where(and(eq(coaches.isPublic, true), isNull(coaches.archivedAt), sql`${name} in (select lower(x) from jsonb_array_elements_text(${coaches.clubNames}) as x)`))
    .orderBy(asc(coaches.createdAt))
    .limit(50);
}
