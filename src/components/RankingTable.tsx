import { useTranslations } from "next-intl";
import { formatLevel } from "@/lib/domain/levels";
import type { RankingRow } from "@/lib/domain/ranking";

/** Club or city standings: first names, levels and results from the last 90 days. Opted-in players only. */
export function RankingTable({ rows, events, highlightId }: { rows: RankingRow[]; events: number; highlightId?: string | null }) {
  const t = useTranslations();
  if (rows.length === 0) return <p className="mt-3 text-sm text-muted">{events === 0 ? t("ranking.empty") : t("ranking.emptyOptIn")}</p>;
  return (
    <div className="mt-3">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs font-bold uppercase tracking-wider text-faint">
            <th className="w-8 py-1">#</th>
            <th className="py-1">&nbsp;</th>
            <th className="py-1 text-right">{t("ranking.colPts")}</th>
            <th className="w-9 py-1 text-right">{t("ranking.colPlayed")}</th>
            <th className="w-9 py-1 text-right">{t("ranking.colWins")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.playerId} className={`border-t border-line ${highlightId === r.playerId ? "bg-accent-soft" : ""}`}>
              <td className="py-2 font-extrabold tabular-nums">{r.rank}</td>
              <td className="py-2 font-semibold">
                {r.name}
                {r.level != null && (
                  <span className="ml-1.5 text-xs font-semibold text-faint tabular-nums">
                    {formatLevel(r.level)}
                    {r.levelVerified && <span className="ml-0.5 text-accent-strong">✓</span>}
                  </span>
                )}
              </td>
              <td className="py-2 text-right text-base font-extrabold tabular-nums">{r.points}</td>
              <td className="py-2 text-right tabular-nums text-muted">{r.played}</td>
              <td className="py-2 text-right tabular-nums text-muted">{r.wins}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.some((r) => r.levelVerified) && <p className="mt-2 text-xs text-faint">{t("ranking.verifiedLegend")}</p>}
    </div>
  );
}
