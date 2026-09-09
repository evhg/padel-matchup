import { eq } from "drizzle-orm";
import { createTranslator } from "next-intl";
import type { Db } from "@/db";
import { events, type Milestone } from "@/db/schema";
import { loadMessages, toLocale } from "@/i18n/config";
import { formatEventDay } from "@/lib/dates";

/** The words for a moment, in the reader's language: the pool of kinds is closed on purpose. */
export async function momentLine(m: Pick<Milestone, "kind" | "value">, localeLike: string): Promise<string> {
  const locale = toLocale(localeLike) ?? "en";
  const t = createTranslator({ locale, messages: await loadMessages(locale) });
  switch (m.kind) {
    case "first_win":
    case "matches_10":
    case "matches_50":
    case "streak_3":
    case "partners_10":
      return t(`moments.${m.kind}`);
    case "level_up":
      return t("moments.level_up", { band: t(`level.bands.${m.value}` as "level.bands.beginner") });
    case "podium": {
      const place = Number(m.value.split(":").pop() ?? "3");
      return t("moments.podium", { place: t(`moments.place${Math.min(3, Math.max(1, place))}` as "moments.place1") });
    }
    default:
      return t("moments.title");
  }
}

/** "Thu 10 Sep · Rawai", when the moment came from a match. */
export async function momentWhere(db: Db, m: Pick<Milestone, "eventId">, localeLike: string): Promise<string | null> {
  if (!m.eventId) return null;
  const [ev] = await db.select({ startsAt: events.startsAt, tz: events.tz, venueName: events.venueName }).from(events).where(eq(events.id, m.eventId)).limit(1);
  if (!ev) return null;
  const locale = toLocale(localeLike) ?? "en";
  const day = formatEventDay(ev.startsAt, ev.tz, locale);
  return ev.venueName ? `${day} · ${ev.venueName}` : day;
}
