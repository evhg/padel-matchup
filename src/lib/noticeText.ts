import { formatEventDay, formatEventTime, isValidTimeZone } from "@/lib/dates";
import type { NoticeParams } from "@/lib/domain/noticeKinds";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * A notice row in the reader's language. The row keeps a message key and plain facts; the day and
 * the hour are written here, in the reader's locale and the match's own zone, which is why a row
 * written for a Russian organiser reads in English to nobody and in Spanish to a Spanish reader.
 *
 * Every variable a `noticeItem.*` message may ask for is in the bag, always: next-intl answers a
 * missing one with the key itself, and a notice that reads as its own key is the bug
 * `tests/messages.test.ts` exists for.
 */
export function noticeVars(p: NoticeParams, locale: string, venueTbd: string): Record<string, string | number> {
  const at = p.at ? new Date(p.at) : null;
  const ok = at !== null && !Number.isNaN(at.getTime());
  const tz = p.tz && isValidTimeZone(p.tz) ? p.tz : "UTC";
  return {
    day: ok ? formatEventDay(at, tz, locale) : "",
    time: ok ? formatEventTime(at, tz, locale) : "",
    venue: p.venue || venueTbd,
    name: p.name ?? "",
    group: p.group ?? "",
    club: p.club ?? "",
    title: p.title ?? "",
    count: typeof p.count === "number" ? p.count : 0,
    what: p.what ?? "other",
  };
}

/** The line itself; a key this build does not know (a notice from a sender since renamed) reads as the section's title, never as a key. */
export function noticeText(t: Translate, locale: string, row: { key: string; params: NoticeParams | null }): string {
  const fallback = t("notices.title");
  if (!row.key.startsWith("noticeItem.")) return fallback;
  try {
    const out = t(row.key, noticeVars(row.params ?? {}, locale, t("event.venueTbd")));
    return out && out !== row.key ? out : fallback;
  } catch {
    return fallback;
  }
}
