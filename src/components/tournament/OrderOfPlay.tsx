import { getLocale, getTranslations } from "next-intl/server";
import type { PlayRow } from "@/lib/domain/competitionSchedule";
import { scoreText } from "@/lib/domain/draw";
import { utcToZonedParts } from "@/lib/dates";
import { dayHeading } from "@/lib/tournamentText";
import { roundsIndex, sourceName } from "./sourceName";

/** The matches by day and time, with the court: what the desk and the players read on the day. */
export async function OrderOfPlay({ rows, tz, myPairIds = [] }: { rows: PlayRow[]; tz: string; /** The viewer's pairs: their own rows stand out. */ myPairIds?: readonly string[] }) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const loose = t as unknown as (key: string, values?: Record<string, string | number>) => string;
  const rounds = roundsIndex(rows);
  const mine = new Set(myPairIds);
  const side = (r: PlayRow, s: "A" | "B") => (s === "A" ? r.aName : r.bName) ?? sourceName(loose, s === "A" ? r.sourceA : r.sourceB, rounds(r.categoryId)) ?? t("tournament.tbd");
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
                const own = (r.pairAId !== null && mine.has(r.pairAId)) || (r.pairBId !== null && mine.has(r.pairBId));
                return (
                  <li key={r.id} className="flex gap-3 py-2" data-mine={own ? "1" : undefined}>
                    <div className="w-12 shrink-0 font-bold tabular-nums">{utcToZonedParts(r.scheduledAt!, tz).time}</div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate">
                        <span className="font-semibold">{r.courtName}</span> · {r.categoryName}
                      </div>
                      <div className={`truncate ${own ? "font-bold text-ink" : "text-muted"}`}>
                        {side(r, "A")} {t("tournament.vs")} {side(r, "B")}
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
