import { getTranslations } from "next-intl/server";
import type { ShownStat } from "@/lib/domain/matchStats";
import { isHealthKind } from "@/lib/domain/matchStatKinds";
import { StatTiles, pairName } from "./StatTiles";

/**
 * On the match page: the numbers that were measured from the video of this match. Nothing while there are none, and
 * nothing when the only numbers are from a watch (a fast reel measures none): one player's heart rate under "Measured
 * from the video of this match" was untrue and looked odd (the owner, 26 November 2026). It stays on My stats.
 */
export async function MatchNumbers({ rows }: { rows: ShownStat[] }) {
  if (rows.every((r) => isHealthKind(r.kind))) return null;
  const t = await getTranslations("stats");
  return (
    <section className="card" data-testid="match-numbers">
      <h2 className="text-lg font-extrabold">{t("title")}</h2>
      <p className="mt-1 text-xs text-muted">{t("lead")}</p>
      <StatTiles rows={rows.map((r) => ({ kind: r.kind, value: r.value, margin: r.margin, who: pairName(r.name, r.partnerName) }))} />
    </section>
  );
}
