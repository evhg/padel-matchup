import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getDb } from "@/db";
import { calendarTitle } from "@/lib/calendar";
import { baseUrl } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { getVenueBoard, isValidVenueSlug } from "@/lib/domain/venueBoard";
import { rangeChip } from "@/lib/levelText";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }> };
export const metadata: Metadata = { robots: { index: false, follow: true } };

/** The venue board as an iframe: no header, no footer, opens matches on kicksma.sh in a new tab. */
export default async function EmbedBoard({ params }: Props) {
  const { slug } = await params;
  if (!isValidVenueSlug(slug)) notFound();
  const db = await getDb();
  const board = await getVenueBoard(db, slug);
  if (!board) notFound();
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const base = baseUrl();
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-3 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg font-extrabold leading-tight">{t("venue.boardTitle", { venue: board.name })}</h1>
        <a href={`${base}/v/${slug}`} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs font-bold text-court">
          {t("embed.openOn")} ↗
        </a>
      </div>
      {board.events.length === 0 ? (
        <p className="text-sm text-muted">{t("venue.empty", { venue: board.name })}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {board.events.slice(0, 8).map(({ event: ev, spotsLeft }) => {
            const chip = rangeChip(t, { min: ev.levelMin, max: ev.levelMax });
            return (
              <li key={ev.id}>
                <a href={`${base}/${ev.code}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-2xl border border-line bg-white px-3 py-2 hover:border-ink/30">
                  <div className="w-14 shrink-0 text-center">
                    <div className="text-[10px] font-bold uppercase text-muted">{formatEventDay(ev.startsAt, ev.tz, locale)}</div>
                    <div className="text-base font-extrabold tabular-nums">{formatEventTime(ev.startsAt, ev.tz, locale)}</div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold">{calendarTitle(ev, t(ev.type === "match" ? "event.match" : "event.tournament"))}</div>
                    <div className={`text-xs font-bold ${spotsLeft > 0 ? "text-ok" : "text-warn"}`}>
                      {spotsLeft > 0 ? t("event.spotsLeft", { count: spotsLeft }) : t("venue.full")}
                      {chip ? ` · ${chip}` : ""}
                    </div>
                  </div>
                </a>
              </li>
            );
          })}
        </ul>
      )}
      <a href={`${base}/?venue=${encodeURIComponent(board.name)}`} target="_blank" rel="noopener noreferrer" className="btn-secondary btn-sm self-start">
        + {t("common.newMatch")}
      </a>
      <p className="text-[11px] text-faint">
        {t("embed.poweredBy")}{" "}
        <a href={base} target="_blank" rel="noopener noreferrer" className="font-semibold text-muted">
          kicksma.sh
        </a>
      </p>
    </main>
  );
}
