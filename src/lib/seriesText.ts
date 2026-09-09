import type { Series } from "@/db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type T = (key: any, values?: any) => string;

/** The weekday name for 0 = Sunday … 6 = Saturday, in the reader's language. */
export function weekdayOf(dow: number, locale: string): string {
  // 4 January 2026 is a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + dow)));
}

/** "Every Saturday at 09:00", "Every other Saturday at 09:00", "First Saturday of the month at 09:00". */
export function rhythmLabel(t: T, locale: string, s: Pick<Series, "dow" | "time" | "every" | "nth">): string {
  const weekday = weekdayOf(s.dow, locale);
  if (s.every === "month") return t("series.rhythmMonth", { nth: t(`series.nth${Math.min(5, Math.max(1, s.nth ?? 1))}`), weekday, time: s.time });
  if (s.every === "fortnight") return t("series.rhythmFortnight", { weekday, time: s.time });
  return t("series.rhythmWeek", { weekday, time: s.time });
}
