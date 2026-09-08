import { and, eq, gte, isNotNull, isNull, lt, ne } from "drizzle-orm";
import type { Db } from "@/db";
import { coachBlocks, coaches, lessons, type Coach } from "@/db/schema";
import { cancelLesson, DAY_MS, getPlayerById } from "@/lib/domain/coaching";
import { deleteCalendarEvent, eventSpan, insertCalendarEvent, isOurs, listCalendarEvents, type GcalEvent } from "./gcal";
import { parseIcsBusy } from "./ical";
import { afterLessonFreed } from "./chains";
import { notifyLessonCancelled, notifyOffer } from "./notify";

/**
 * Keeps a coach's book and their calendar telling the same story, both ways:
 *  - what the coach writes in Google Calendar (or publishes as iCal) becomes busy time here;
 *  - what is booked here appears in their Google Calendar, tagged as ours;
 *  - a lesson the coach deletes there is cancelled here, with the student told.
 * Runs every few minutes for every attached coach; each pass is idempotent.
 */

export const SYNC_PAST_DAYS = 1;
export const SYNC_AHEAD_DAYS = 45;

export type SyncResult = { coachId: string; source: "gcal" | "ical" | "none"; busy: number; pushed: number; removed: number; cancelledHere: number; error: string | null };

async function replaceBlocks(db: Db, coachId: string, source: "gcal" | "ical", from: Date, to: Date, spans: { externalId: string; start: Date; end: Date; reason: string }[]): Promise<number> {
  // Blocks from this source inside the window are replaced wholesale: the calendar is the truth for them.
  await db.delete(coachBlocks).where(and(eq(coachBlocks.coachId, coachId), eq(coachBlocks.source, source), gte(coachBlocks.endsAt, from), lt(coachBlocks.startsAt, to)));
  if (spans.length === 0) return 0;
  await db.insert(coachBlocks).values(spans.map((s) => ({ coachId, startsAt: s.start, endsAt: s.end, reason: s.reason.slice(0, 120), source, externalId: s.externalId })));
  return spans.length;
}

/** The Google side: pull foreign events as blocks, push our lessons, notice deletions. */
export async function syncGoogleCalendar(db: Db, coach: Coach, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<SyncResult> {
  const result: SyncResult = { coachId: coach.id, source: "gcal", busy: 0, pushed: 0, removed: 0, cancelledHere: 0, error: null };
  if (!coach.gcalId) return { ...result, source: "none" };
  const from = new Date(now.getTime() - SYNC_PAST_DAYS * DAY_MS);
  const to = new Date(now.getTime() + SYNC_AHEAD_DAYS * DAY_MS);
  const events = await listCalendarEvents(coach.gcalId, from, to, fetchImpl);
  if (!events) {
    result.error = "calendar unreadable";
    await db.update(coaches).set({ calendarError: result.error, gcalStatus: "no_access", gcalCheckedAt: now }).where(eq(coaches.id, coach.id));
    return result;
  }
  const foreign: { externalId: string; start: Date; end: Date; reason: string }[] = [];
  const oursSeen = new Map<string, GcalEvent>();
  for (const ev of events) {
    const lessonId = isOurs(ev);
    if (lessonId) {
      oursSeen.set(lessonId, ev);
      continue;
    }
    if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
    const span = eventSpan(ev);
    if (!span) continue;
    foreign.push({ externalId: ev.id, start: span.start, end: span.end, reason: ev.summary ?? "calendar" });
  }
  result.busy = await replaceBlocks(db, coach.id, "gcal", from, to, foreign);

  // Push: booked lessons in the window with no event yet.
  const toPush = await db
    .select()
    .from(lessons)
    .where(and(eq(lessons.coachId, coach.id), eq(lessons.status, "booked"), isNull(lessons.externalId), gte(lessons.startsAt, now)));
  for (const l of toPush) {
    const student = l.studentPlayerId ? await getPlayerById(db, l.studentPlayerId) : null;
    const id = await insertCalendarEvent(
      coach.gcalId,
      { summary: `Padel · ${student?.displayName ?? "lesson"}`, description: "Booked through Kicksmash. Deleting this event cancels the lesson and tells the student.", location: coach.clubNames.join(", ") || undefined, start: l.startsAt, end: new Date(l.startsAt.getTime() + l.minutes * 60_000), lessonId: l.id },
      fetchImpl,
    );
    if (id) {
      await db.update(lessons).set({ externalId: id }).where(eq(lessons.id, l.id));
      result.pushed++;
    }
  }

  // Remove: lessons no longer booked whose event still exists.
  const toRemove = await db
    .select()
    .from(lessons)
    .where(and(eq(lessons.coachId, coach.id), ne(lessons.status, "booked"), ne(lessons.status, "done"), isNotNull(lessons.externalId), gte(lessons.startsAt, from)));
  for (const l of toRemove) {
    if (l.externalId && (await deleteCalendarEvent(coach.gcalId, l.externalId, fetchImpl))) {
      await db.update(lessons).set({ externalId: null }).where(eq(lessons.id, l.id));
      result.removed++;
    }
  }

  // Cancelled there → cancelled here, as the coach's cancellation (never counts).
  const booked = await db
    .select()
    .from(lessons)
    .where(and(eq(lessons.coachId, coach.id), eq(lessons.status, "booked"), isNotNull(lessons.externalId), gte(lessons.startsAt, now), lt(lessons.startsAt, to)));
  for (const l of booked) {
    const ev = oursSeen.get(l.id);
    if (ev && ev.status === "cancelled") {
      const { lesson, outcome } = await cancelLesson(db, { lessonId: l.id, by: "coach", coach }, now);
      await db.update(lessons).set({ externalId: null }).where(eq(lessons.id, l.id));
      const student = lesson.studentPlayerId ? await getPlayerById(db, lesson.studentPlayerId) : null;
      const freed = await afterLessonFreed(db, coach, lesson, "coach", now);
      if (student) await notifyLessonCancelled(db, { lesson, coach, student, pkg: null, by: "coach", outcome, alternatives: freed.alternatives }).catch(() => undefined);
      if (freed.offer) await notifyOffer(db, coach, freed.offer).catch(() => undefined);
      result.cancelledHere++;
    }
  }
  await db.update(coaches).set({ calendarSyncedAt: now, calendarError: null, gcalStatus: "linked", gcalCheckedAt: now }).where(eq(coaches.id, coach.id));
  return result;
}

/** The iCal side: read-only busy time from a secret address. */
export async function syncIcal(db: Db, coach: Coach, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<SyncResult> {
  const result: SyncResult = { coachId: coach.id, source: "ical", busy: 0, pushed: 0, removed: 0, cancelledHere: 0, error: null };
  if (!coach.icalUrl) return { ...result, source: "none" };
  const from = new Date(now.getTime() - SYNC_PAST_DAYS * DAY_MS);
  const to = new Date(now.getTime() + SYNC_AHEAD_DAYS * DAY_MS);
  try {
    const res = await fetchImpl(coach.icalUrl, { signal: AbortSignal.timeout(12_000), headers: { "user-agent": "Kicksmash coach calendar (https://kicksma.sh)" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("not a calendar");
    const busy = parseIcsBusy(text, from, to).filter((b) => !/kicksma\.sh|Kicksmash/i.test(b.summary));
    result.busy = await replaceBlocks(db, coach.id, "ical", from, to, busy.map((b) => ({ externalId: b.uid.slice(0, 200), start: b.start, end: b.end, reason: b.summary || "calendar" })));
    await db.update(coaches).set({ calendarSyncedAt: now, calendarError: null }).where(eq(coaches.id, coach.id));
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    await db.update(coaches).set({ calendarError: result.error }).where(eq(coaches.id, coach.id));
  }
  return result;
}

/** Every attached coach, one after another (the pooler dislikes bursts). */
export async function syncAllCoachCalendars(db: Db, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<SyncResult[]> {
  const rows = await db.select().from(coaches).where(isNull(coaches.archivedAt));
  const out: SyncResult[] = [];
  for (const coach of rows) {
    if (coach.gcalId) out.push(await syncGoogleCalendar(db, coach, now, fetchImpl));
    if (coach.icalUrl) out.push(await syncIcal(db, coach, now, fetchImpl));
  }
  return out;
}

export type CalendarSettings = { gcalId: string | null; icalUrl: string | null };

/** What the coach typed, cleaned: a calendar address for Google, or a secret iCal link (webcal:// accepted). */
export function cleanCalendarSettings(input: { gcalId?: string | null; icalUrl?: string | null }): CalendarSettings {
  const gcal = (input.gcalId ?? "").trim().toLowerCase();
  const gcalId = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(gcal) ? gcal : null;
  let ical = (input.icalUrl ?? "").trim().replace(/^webcal:\/\//i, "https://");
  if (!/^https:\/\/\S{8,500}$/i.test(ical)) ical = "";
  return { gcalId, icalUrl: ical || null };
}

/** Stores the attachment and forgets what was known about the previous one. */
export async function setCoachCalendar(db: Db, coachId: string, settings: CalendarSettings): Promise<void> {
  await db
    .update(coaches)
    .set({ gcalId: settings.gcalId, icalUrl: settings.icalUrl, gcalStatus: settings.gcalId ? "pending" : null, gcalCheckedAt: null, calendarError: null, calendarSyncedAt: null, updatedAt: new Date() })
    .where(eq(coaches.id, coachId));
  if (!settings.gcalId) await db.delete(coachBlocks).where(and(eq(coachBlocks.coachId, coachId), eq(coachBlocks.source, "gcal")));
  if (!settings.icalUrl) await db.delete(coachBlocks).where(and(eq(coachBlocks.coachId, coachId), eq(coachBlocks.source, "ical")));
}
