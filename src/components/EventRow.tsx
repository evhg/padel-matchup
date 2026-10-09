import Link from "next/link";
import type { Event } from "@/db/schema";
import { calendarTitle } from "@/lib/calendar";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import type { Fill } from "@/lib/domain/venueBoard";
import { rangeChip } from "@/lib/levelText";

/** Any next-intl translator, server or client; the message files prove the keys, not this type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type T = (key: any, values?: any) => string;

export type EventRowData = Pick<Event, "code" | "type" | "title" | "startsAt" | "tz" | "venueName" | "levelMin" | "levelMax" | "cost" | "format"> & {
  /** The organiser's first name, or empty to leave the line out. */
  organiser: string;
  fill: Fill;
};

/** "2 spots left", "Full", "6/8 players": what the group rows say about seats, in the same words. */
export function fillText(t: T, f: Fill): string {
  return f.kind === "full" ? t("event.statusFull") : f.kind === "left" ? t("event.spotsLeft", { count: f.count }) : t("event.players", { count: f.count, capacity: f.capacity });
}

const FORMAT_KEY = { americano: "create.formatAmericano", mexicano: "create.formatMexicano", king: "create.formatKing" } as const;

/**
 * One game in a list, the whole row a link to it. The time leads, big and in tabular figures, so a
 * column of rows reads like a timetable; then what it is, where, who runs it; then the chips a
 * player decides on: seats, format, level, price.
 *
 * Built for /play and meant to replace the other row styles (the city page, the venue board, the
 * group page) one at a time, so it takes plain data and a translator, and fetches nothing.
 */
export function EventRow({ ev, t, locale }: { ev: EventRowData; t: T; locale: string }) {
  const range = rangeChip(t, { min: ev.levelMin, max: ev.levelMax });
  const where = [ev.venueName, ev.organiser ? t("city.playBy", { name: ev.organiser }) : null].filter(Boolean).join(" · ");
  return (
    <Link href={`/${ev.code}`} prefetch={false} className="flex items-center gap-3 rounded-2xl border border-line bg-card px-4 py-3 hover:border-ink/30" data-testid="event-row">
      {/* The weekday stays (it is how a player picks a game this week), so the column is wide enough
          for it: up to 83 px in bold capitals at 12 px ("DOM, 13 SEPT"), 93 px with Bigger text. */}
      <div className="w-[5.5rem] shrink-0 text-center">
        <div className="whitespace-nowrap text-xs font-bold uppercase text-faint" data-testid="event-row-day">
          {formatEventDay(ev.startsAt, ev.tz, locale)}
        </div>
        <div className="text-2xl font-extrabold leading-none tabular-nums">{formatEventTime(ev.startsAt, ev.tz, locale)}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-bold">{calendarTitle(ev, t(ev.type === "match" ? "event.match" : "event.tournament"))}</div>
        {where && <div className="truncate text-sm text-muted">{where}</div>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className={`${ev.fill.kind === "full" ? "chip-full" : "chip-open"} tabular-nums`} data-testid="event-row-fill">
            {fillText(t, ev.fill)}
          </span>
          {ev.type === "tournament" && <span className="chip-muted">{t(FORMAT_KEY[ev.format ?? "americano"])}</span>}
          {range && <span className="chip-muted">🎚️ {range}</span>}
          {ev.cost && (
            <span className="chip-muted min-w-0 max-w-full">
              <span className="truncate">💸 {t("event.costPerPlayer", { cost: ev.cost })}</span>
            </span>
          )}
        </div>
      </div>
      <span className="text-faint" aria-hidden>
        ›
      </span>
    </Link>
  );
}
