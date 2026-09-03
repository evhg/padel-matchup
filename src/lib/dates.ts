/**
 * Timezone helpers built on Intl only (no date library).
 * All persisted instants are UTC; `tz` is an IANA name used for display.
 */

const partsCache = new Map<string, Intl.DateTimeFormat>();

function dtf(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock components of `date` in `tz`. */
export function wallClock(date: Date, tz: string) {
  const parts = dtf(tz).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") === 24 ? 0 : get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `tz` from UTC at instant `date`, in milliseconds. */
export function tzOffsetMs(date: Date, tz: string): number {
  const w = wallClock(date, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Convert a local date ("YYYY-MM-DD") + time ("HH:mm") in `tz` to a UTC Date.
 * Handles DST transitions by a two-pass offset correction.
 */
export function zonedTimeToUtc(dateStr: string, timeStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  if (![y, m, d, hh, mm].every(Number.isFinite)) throw new Error("Invalid date/time");
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  let guess = naive - tzOffsetMs(new Date(naive), tz);
  const off2 = tzOffsetMs(new Date(guess), tz);
  guess = naive - off2;
  return new Date(guess);
}

/** Inverse of zonedTimeToUtc: "YYYY-MM-DD" and "HH:mm" strings for form inputs. */
export function utcToZonedParts(date: Date, tz: string): { date: string; time: string } {
  const w = wallClock(date, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${w.year}-${pad(w.month)}-${pad(w.day)}`,
    time: `${pad(w.hour)}:${pad(w.minute)}`,
  };
}

/** Default for the create form: tomorrow at 18:00 in `tz`. */
export function tomorrowAt(tz: string, hour = 18, now = new Date()): { date: string; time: string } {
  const w = wallClock(now, tz);
  const tomorrow = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${tomorrow.getUTCFullYear()}-${pad(tomorrow.getUTCMonth() + 1)}-${pad(tomorrow.getUTCDate())}`,
    time: `${pad(hour)}:00`,
  };
}

export function formatEventDay(date: Date, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
}

export function formatEventDayLong(date: Date, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "short",
  }).format(date);
}

export function formatEventTime(date: Date, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: locale.startsWith("en") ? "h23" : undefined,
  }).format(date);
}

export function formatEventDateTime(date: Date, tz: string, locale: string): string {
  return `${formatEventDay(date, tz, locale)} · ${formatEventTime(date, tz, locale)}`;
}

/** Short tz label like "GMT+2" or "CEST" for display next to a time. */
export function tzLabel(date: Date, tz: string, locale: string): string {
  try {
    const parts = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" }).formatToParts(date);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch {
    return tz;
  }
}

/** "2 days ago" style relative time (past only), localized. */
export function relativeTime(from: Date, locale: string, now = new Date()): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const diffSec = Math.round((from.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return rtf.format(Math.trunc(diffSec), "second");
  if (abs < 3600) return rtf.format(Math.trunc(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.trunc(diffSec / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.trunc(diffSec / 86400), "day");
  return rtf.format(Math.trunc(diffSec / (86400 * 30)), "month");
}

/** ICS / Google Calendar UTC stamp: 20250904T160000Z */
export function icsStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
