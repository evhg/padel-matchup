import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { formatDayMonth } from "@/lib/dates";
import type { RecentResult } from "@/lib/domain/recentResults";

/**
 * "Recent results" on a club page and a city page: each finished match as two lines, one per side,
 * the set scores in columns and a tick on the winners, one tap from its result card. The page reads
 * the rows (`recentResults`, one query); an empty list shows nothing at all, not a "no results" line.
 * The city page names the club under each result, because there the reader cannot tell otherwise.
 * A player who did not opt in to rankings, a result older than 90 days and a deleted account show
 * "Player" here, never a name; the query decides it (see `recentResults`).
 */
export async function RecentResults({ results, showVenue = false }: { results: RecentResult[]; showVenue?: boolean }) {
  if (results.length === 0) return null;
  const [t, locale] = await Promise.all([getTranslations("venue"), getLocale()]);
  return (
    <section className="card" data-testid="recent-results">
      <h2 className="text-lg font-extrabold">{t("recentResults")}</h2>
      <ul className="mt-3 flex flex-col gap-2">
        {results.map((r) => (
          <li key={r.code}>
            <Link href={`/${r.code}/card`} prefetch={false} className="flex items-center gap-3 rounded-2xl border border-line px-4 py-3 hover:border-ink/30">
              {/* Day and month only: with the weekday it ran to two lines at 390 px (83 px in a 64 px column). */}
              <div className="w-16 shrink-0 whitespace-nowrap text-xs font-bold uppercase text-muted" data-testid="result-day">
                {formatDayMonth(r.startsAt, r.tz, locale)}
              </div>
              <div className="min-w-0 flex-1">
                {(["a", "b"] as const).map((side) => {
                  const won = r.winner === side;
                  return (
                    <div key={side} className="flex items-center gap-2">
                      <span className="w-4 shrink-0 text-center font-extrabold text-ok">
                        {won && (
                          <>
                            <span aria-hidden="true">✓</span>
                            <span className="sr-only">{t("recentWon")}</span>
                          </>
                        )}
                      </span>
                      {/* The names truncate; the figures beside them never do. */}
                      <span className={`min-w-0 flex-1 truncate ${won ? "font-extrabold" : "text-muted"}`}>{(side === "a" ? r.a : r.b).map((n) => n ?? t("recentPlayer")).join(" & ")}</span>
                      <span className="flex shrink-0 gap-2 font-bold tabular-nums">
                        {r.sets.map((s, i) => (
                          <span key={i} className="w-5 text-center">
                            {side === "a" ? s.sideA : s.sideB}
                          </span>
                        ))}
                      </span>
                    </div>
                  );
                })}
                {showVenue && r.venueName && <div className="mt-1 truncate pl-6 text-xs text-faint">{r.venueName}</div>}
              </div>
              <span className="shrink-0 text-faint">›</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
