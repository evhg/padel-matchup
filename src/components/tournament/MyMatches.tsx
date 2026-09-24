import { getLocale, getTranslations } from "next-intl/server";
import type { DrawView, MatchView } from "@/lib/domain/competitionDraw";
import { roundKey, scoreText } from "@/lib/domain/draw";
import { whenLabel } from "@/lib/tournamentText";
import { ScoreForm } from "./ScoreForm";
import { sourceName } from "./sourceName";

type T = (key: string, values?: Record<string, string | number>) => string;
const PHASES = ["qualifying", "group", "main", "consolation"];
const over = (m: MatchView) => m.status === "done" || m.status === "walkover";

/**
 * A player's own matches, first on the page: when, which court, against whom, the result from their
 * side, and the score form under each match still to play.
 *
 * The rehearsal of 24 September 2026 (26 pairs, two categories, four courts) put a player's own entry
 * 3,474 pixels down, under an order of play of 52 matches, and his score forms seven screens down,
 * inside the draw. On the day a player wants one line: where do I play next. The draw below still
 * shows every match; the forms live here, once.
 */
export async function MyMatches({ draws, myPairIds, slug, tz }: { draws: Map<string, DrawView>; myPairIds: ReadonlySet<string>; slug: string; tz: string }) {
  const [t0, locale] = await Promise.all([getTranslations(), getLocale()]);
  const t = t0 as unknown as T;
  const rows: { m: MatchView; view: DrawView; label: string; side: "A" | "B"; roundsOf: (phase: string) => number }[] = [];
  for (const view of draws.values()) {
    const roundsOf = (phase: string) => (phase === "main" ? view.main.length : phase === "consolation" ? view.consolation.length : phase === "qualifying" ? view.qualifying.length : 0);
    const roundName = (m: MatchView) => {
      const k = roundKey(m.round, roundsOf(m.phase));
      return k.key === "final" ? t("tournament.roundFinal") : k.key === "semi" ? t("tournament.roundSemi") : k.key === "quarter" ? t("tournament.roundQuarter") : t("tournament.roundOf", { n: k.of ?? 0 });
    };
    const all = [...view.qualifying.flat(), ...view.groups.flatMap((g) => g.matches), ...view.main.flat(), ...view.consolation.flat()];
    for (const m of all) {
      if (m.bye) continue;
      const side = m.pairAId && myPairIds.has(m.pairAId) ? "A" : m.pairBId && myPairIds.has(m.pairBId) ? "B" : null;
      if (!side) continue;
      const label =
        m.phase === "group" ? t("tournament.group", { label: m.groupLabel ?? "" }) : m.phase === "qualifying" ? t("tournament.phaseQualifying") : m.phase === "consolation" ? `${t("tournament.phaseConsolation")} · ${roundName(m)}` : roundName(m);
      rows.push({ m, view, label, side, roundsOf });
    }
  }
  if (rows.length === 0) return null;
  const at = (m: MatchView) => (m.scheduledAt ? m.scheduledAt.getTime() : Number.MAX_SAFE_INTEGER);
  rows.sort((x, y) => at(x.m) - at(y.m) || PHASES.indexOf(x.m.phase) - PHASES.indexOf(y.m.phase) || x.m.round - y.m.round);
  const next = rows.find((r) => !over(r.m))?.m.id;
  return (
    <section className="card" data-testid="my-matches">
      <h2 className="text-lg font-extrabold">{t("tournament.myMatches")}</h2>
      <ul className="mt-2 flex flex-col divide-y divide-line">
        {rows.map(({ m, view, label, side, roundsOf }) => {
          const them = side === "A" ? m.b : m.a;
          const themName = them?.name ?? sourceName(t, side === "A" ? m.sourceB : m.sourceA, roundsOf) ?? t("tournament.tbd");
          const won = m.winner === side;
          const mine = side === "A" ? scoreText(m.scoreA, m.scoreB) : scoreText(m.scoreB, m.scoreA);
          const result = m.status === "walkover" ? t(won ? "tournament.myWonWalkover" : "tournament.myLostWalkover") : over(m) ? t(won ? "tournament.myWon" : "tournament.myLost", { score: mine }) : null;
          const ready = Boolean(m.a && m.b);
          return (
            <li key={m.id} className="flex flex-col gap-1 py-3" data-testid={`my-match-${m.id}`}>
              <div className="flex items-baseline gap-2">
                <div className="min-w-0 flex-1 font-bold">
                  {m.scheduledAt ? `${whenLabel(m.scheduledAt, tz, locale)} · ${m.courtName ?? ""}` : t("tournament.myNotYet")}
                </div>
                {m.id === next && <span className="chip-muted shrink-0 text-ok">{t("tournament.myNext")}</span>}
                {result && <span className={`shrink-0 text-sm font-bold ${won ? "text-ok" : "text-muted"}`}>{result}</span>}
              </div>
              <div className="text-sm">
                {t("tournament.vs")} <span className="font-semibold">{themName}</span>
              </div>
              <div className="text-xs text-muted">
                {view.category.name} · {label}
              </div>
              {ready && !over(m) && <ScoreForm slug={slug} matchId={m.id} rule={m.scoring} ruleLabel={t(`tournament.sc_${m.scoring}`)} organizer={false} done={false} aName={m.a!.name} bName={m.b!.name} mySide={side} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
