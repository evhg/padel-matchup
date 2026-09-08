import type { Coach } from "@/db/schema";
import { formatEventTime, utcToZonedParts } from "@/lib/dates";
import { DAY_MS, packageLine, type LessonWithPeople, type StudentLesson } from "@/lib/domain/coaching";

/** What the coach screens receive: plain strings and numbers, formatted once on the server in the viewer's language. */

export type DayLabels = Record<string, string>;

export function dayLabel(dateStr: string, locale: string, todayStr: string, words: { today: string; tomorrow: string }): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const label = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(d);
  const tomorrow = new Date(new Date(`${todayStr}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10);
  if (dateStr === todayStr) return `${words.today} · ${label}`;
  if (dateStr === tomorrow) return `${words.tomorrow} · ${label}`;
  return label;
}

export const todayIn = (tz: string, now = new Date()): string => utcToZonedParts(now, tz).date;

export function slotDTOs(slots: Date[], tz: string, locale: string): { iso: string; day: string; time: string }[] {
  return slots.map((s) => ({ iso: s.toISOString(), day: utcToZonedParts(s, tz).date, time: formatEventTime(s, tz, locale) }));
}

export function pkgDTO(l: { package: { size: number; used: number; expiresAt: Date | null; closedAt: Date | null } | null }, now: Date) {
  if (!l.package) return null;
  const line = packageLine(l.package as Parameters<typeof packageLine>[0], now);
  return { left: line.left, size: l.package.size, days: line.daysLeft };
}

export function coachLessonDTO(l: LessonWithPeople, coach: Pick<Coach, "tz">, locale: string, labels: DayLabels, now: Date) {
  const { date } = utcToZonedParts(l.startsAt, coach.tz);
  return {
    id: l.id,
    iso: l.startsAt.toISOString(),
    day: date,
    time: formatEventTime(l.startsAt, coach.tz, locale),
    dayLabel: labels[date] ?? date,
    studentName: l.student?.displayName ?? "?",
    studentPlayerId: l.studentPlayerId,
    status: l.status,
    pkg: pkgDTO(l, now),
  };
}

export function studentLessonDTO(l: StudentLesson, locale: string, labels: DayLabels, now: Date) {
  const { date } = utcToZonedParts(l.startsAt, l.coach.tz);
  return {
    id: l.id,
    iso: l.startsAt.toISOString(),
    label: `${labels[date] ?? date} · ${formatEventTime(l.startsAt, l.coach.tz, locale)}`,
    status: l.status,
    hoursUntil: (l.startsAt.getTime() - now.getTime()) / 3_600_000,
  };
}

/** Labels for every day in a window, keyed by "YYYY-MM-DD" in the coach's zone. */
export function labelsFor(days: string[], locale: string, todayStr: string, words: { today: string; tomorrow: string }): DayLabels {
  const out: DayLabels = {};
  for (const d of days) out[d] = dayLabel(d, locale, todayStr, words);
  return out;
}

export function dayRange(todayStr: string, count: number): string[] {
  const start = new Date(`${todayStr}T00:00:00Z`).getTime();
  return Array.from({ length: count }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10));
}
