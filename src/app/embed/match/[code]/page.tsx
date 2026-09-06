import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { LevelChip } from "@/components/LevelSelect";
import { getDb } from "@/db";
import { calendarTitle } from "@/lib/calendar";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl } from "@/lib/config";
import { formatEventDayLong, formatEventTime } from "@/lib/dates";
import { isOccupied } from "@/lib/domain/events";
import { isLevelVerified } from "@/lib/domain/levels";
import { getEventByCode } from "@/lib/domain/queries";
import { venueWithCourt } from "@/lib/labels";
import { rangeChip } from "@/lib/levelText";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ code: string }> };
export const metadata: Metadata = { robots: { index: false, follow: true } };

/** One match as an iframe: who plays, spots left, one button that opens the real page. */
export default async function EmbedMatch({ params }: Props) {
  const { code } = await params;
  if (!isValidShareCode(code)) notFound();
  const db = await getDb();
  const detail = await getEventByCode(db, code);
  if (!detail) notFound();
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const ev = detail.event;
  const base = baseUrl();
  const seats = detail.roster.filter((s) => s.position <= ev.capacity).sort((a, b) => a.position - b.position);
  const occupied = seats.filter(isOccupied).length;
  const spotsLeft = Math.max(0, ev.capacity - occupied - seats.filter((s) => s.status === "invited").length);
  const chip = rangeChip(t, { min: ev.levelMin, max: ev.levelMax });
  const cancelled = ev.status === "cancelled";
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-3 p-3">
      <div>
        <div className="text-xs font-bold uppercase tracking-wider text-muted">{formatEventDayLong(ev.startsAt, ev.tz, locale)}</div>
        <h1 className="mt-0.5 text-lg font-extrabold leading-tight">
          {formatEventTime(ev.startsAt, ev.tz, locale)} · {calendarTitle(ev, t(ev.type === "match" ? "event.match" : "event.tournament"))}
        </h1>
        <div className="mt-0.5 text-sm text-muted">
          {venueWithCourt(ev, { venueTbd: t("event.venueTbd"), courtNumber: (n) => t("event.courtNumber", { n }) })}
          {chip ? ` · ${chip}` : ""}
        </div>
      </div>
      <ul className="grid grid-cols-2 gap-1.5 text-sm">
        {seats.slice(0, 8).map((s) => (
          <li key={s.id} className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 ${isOccupied(s) ? "bg-white ring-1 ring-line" : "border border-dashed border-line-strong text-faint"}`}>
            {isOccupied(s) ? (
              <>
                <span className="truncate font-semibold">{s.player?.displayName ?? s.invitedName ?? "?"}</span>
                <LevelChip level={s.player?.level} verified={s.player ? isLevelVerified(s.player) : false} />
              </>
            ) : (
              <span>{s.status === "invited" ? (s.invitedName ?? "?") : "—"}</span>
            )}
          </li>
        ))}
      </ul>
      {ev.capacity > 8 && <p className="text-xs text-faint">{t("event.players", { count: occupied, capacity: ev.capacity })}</p>}
      <a href={`${base}/${ev.code}`} target="_blank" rel="noopener noreferrer" className={`${cancelled || spotsLeft === 0 ? "btn-secondary" : "btn-primary"} w-full`}>
        {cancelled ? t("event.statusCancelled") : spotsLeft > 0 ? `${t("event.join")} · ${t("event.spotsLeft", { count: spotsLeft })}` : t("embed.openOn")}
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
