import { getTranslations } from "next-intl/server";
import { statNumber, type StatKind } from "@/lib/domain/matchStatKinds";

export type StatTile = { kind: StatKind; value: number; margin: number | null; who?: string | null; note?: string | null };

/** A number that is known to worse than this wears "≈". */
const ABOUT_FROM = 0.05;
export const pairName = (name: string, partner: string | null) => (partner ? `${name} & ${partner}` : name);

/**
 * The numbers of a match as tiles: the number, what it is, and whose it is. The match page, the club's
 * records, the public profile and "My stats" all draw a number the same way here.
 */
export async function StatTiles({ rows, testid }: { rows: StatTile[]; testid?: string }) {
  const t = await getTranslations("stats");
  return (
    <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-4 text-center sm:grid-cols-3" data-testid={testid}>
      {rows.map((r, i) => {
        const n = statNumber(r.kind, r.value);
        const unit = n.unit === "count" ? "" : t(`unit.${n.unit}`);
        return (
          <li key={`${r.kind}-${i}`} data-stat={r.kind}>
            <div className="text-2xl font-extrabold tabular-nums">
              {r.margin != null && r.margin > ABOUT_FROM ? "≈ " : ""}
              {n.digits}
              {unit && <span className={n.unit === "percent" ? "" : "text-sm font-bold"}>{n.unit === "percent" ? unit : ` ${unit}`}</span>}
            </div>
            <div className="text-2xs font-bold uppercase tracking-wider text-faint">{t(`kind.${r.kind}`)}</div>
            {r.who && <div className="text-xs font-semibold text-muted">{r.who}</div>}
            {r.note && <div className="text-2xs text-faint">{r.note}</div>}
          </li>
        );
      })}
    </ul>
  );
}
