import { getLocale, getTranslations } from "next-intl/server";
import type { PlayRow } from "@/lib/domain/competitionSchedule";
import { scoreText } from "@/lib/domain/draw";
import { utcToZonedParts } from "@/lib/dates";
import { dayHeading } from "@/lib/tournamentText";

/** The matches by day and time, with the court: what the desk and the players read on the day. */
export async function OrderOfPlay({ rows, tz }: { rows: PlayRow[]; tz: string }) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const days = new Map<string, PlayRow[]>();
  for (const r of rows) {
    if (!r.scheduledAt) continue;
    const key = utcToZonedParts(r.scheduledAt, tz).date;
    days.set(key, [...(days.get(key) ?? []), r]);
  }
  return (
    <section className="card" data-testid="order-of-play">
      <h2 className="text-lg font-extrabold">{t("tournament.orderOfPlay")}</h2>
      {days.size === 0 ? (
        <p className="mt-2 text-sm text-muted">{t("tournament.orderNone")}</p>
      ) : (
        [...days.entries()].map(([date, list]) => (
          <div key={date} className="mt-3">
            <div className="text-xs font-bold uppercase tracking-wide text-muted">{dayHeading(list[0].scheduledAt!, tz, locale)}</div>
            <ul className="mt-1 divide-y divide-line text-sm">
              {list.map((r) => {
                const over = r.status === "done" || r.status === "walkover";
                return (
                  <li key={r.id} className="flex gap-3 py-2">
                    <div className="w-12 shrink-0 font-bold tabular-nums">{utcToZonedParts(r.scheduledAt!, tz).time}</div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate">
                        <span className="font-semibold">{r.courtName}</span> · {r.categoryName}
                      </div>
                      <div className="truncate text-muted">
                        {r.aName ?? t("tournament.tbd")} {t("tournament.vs")} {r.bName ?? t("tournament.tbd")}
                      </div>
                    </div>
                    <div className="shrink-0 font-semibold tabular-nums">{r.status === "walkover" ? t("tournament.walkover") : over ? scoreText(r.scoreA, r.scoreB) : ""}</div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
