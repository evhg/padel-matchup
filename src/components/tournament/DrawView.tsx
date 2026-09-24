import { getLocale, getTranslations } from "next-intl/server";
import type { DrawView as View, MatchView } from "@/lib/domain/competitionDraw";
import { roundKey, scoreText } from "@/lib/domain/draw";
import { utcToZonedParts } from "@/lib/dates";
import { whenLabel } from "@/lib/tournamentText";
import { MoveMatch } from "./MoveMatch";
import { StreamForm } from "./StreamForm";
import { ScoreForm } from "./ScoreForm";
import { sourceName } from "./sourceName";

/** The translator, typed loosely: the typed key union is too deep to pass around, and every key here is proven by the message files. */
type T = (key: string, values?: Record<string, string | number>) => string;

const roundName = (t: T, round: number, rounds: number): string => {
  const k = roundKey(round, rounds);
  return k.key === "final" ? t("tournament.roundFinal") : k.key === "semi" ? t("tournament.roundSemi") : k.key === "quarter" ? t("tournament.roundQuarter") : t("tournament.roundOf", { n: k.of ?? 0 });
};
const over = (m: MatchView) => m.status === "done" || m.status === "walkover";
const pairLabel = (t: T, p: MatchView["a"], m: MatchView, side: "A" | "B", where: Where) => {
  if (p) return `${p.name}${p.seed ? ` (${p.seed})` : ""}`;
  if (m.bye) return t("tournament.bye");
  // Where the side comes from ("Winner of group A"), not "to be decided".
  return sourceName(t, side === "A" ? m.sourceA : m.sourceB, where.roundsOf) ?? t("tournament.tbd");
};

type Where = { tz: string; locale: string; courtNames: string[]; roundsOf: (phase: string) => number };

function MatchLine({ t, m, slug, canScore, organizer, ruleLabel, where }: { t: T; m: MatchView; slug: string; canScore: boolean; organizer: boolean; ruleLabel: string; where: Where }) {
  const done = over(m);
  const a = pairLabel(t, m.a, m, "A", where);
  const b = pairLabel(t, m.b, m, "B", where);
  const winA = m.winner === "A";
  const winB = m.winner === "B";
  const ready = Boolean(m.a && m.b) && !m.bye;
  return (
    <li className="py-2" data-testid={`match-${m.id}`}>
      <div className="flex items-baseline gap-2 text-sm">
        <div className="min-w-0 flex-1">
          <div className={`truncate ${winA ? "font-bold" : m.a ? "" : "text-faint"}`}>{a}</div>
          <div className={`truncate ${winB ? "font-bold" : m.b ? "" : "text-faint"}`}>{b}</div>
        </div>
        <div className="shrink-0 text-right font-semibold tabular-nums">{m.status === "walkover" ? t("tournament.walkover") : done ? scoreText(m.scoreA, m.scoreB) : m.bye ? "" : "·"}</div>
      </div>
      {m.scheduledAt && !m.bye && (
        <div className="text-xs text-muted" data-testid="match-when">
          {whenLabel(m.scheduledAt, where.tz, where.locale)} · {m.courtName}
        </div>
      )}
      {m.streamUrl && (
        <a href={m.streamUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm mt-1 inline-block" data-testid="watch-live">
          ▶ {t("tournament.watchLive")}
        </a>
      )}
      {organizer && !done && !m.bye && (
        <div className="flex flex-wrap gap-2">
          <MoveMatch slug={slug} matchId={m.id} courtNames={where.courtNames} court={m.courtName} local={m.scheduledAt ? `${utcToZonedParts(m.scheduledAt, where.tz).date}T${utcToZonedParts(m.scheduledAt, where.tz).time}` : null} />
          <StreamForm slug={slug} matchId={m.id} url={m.streamUrl} />
        </div>
      )}
      {ready && (canScore || organizer) && (!done || organizer) && <ScoreForm slug={slug} matchId={m.id} rule={m.scoring} ruleLabel={ruleLabel} organizer={organizer} done={done} aName={m.a?.name ?? "A"} bName={m.b?.name ?? "B"} />}
    </li>
  );
}

/**
 * A category's draw as the page shows it: the qualifying, the groups with their tables, the main
 * draw round by round, the consolation, and the champions. A player of a pair gets the score form
 * under their own match; the organiser under every match.
 */
export async function DrawView({ view, slug, myMatchIds = [], organizer = false, tz, courtNames = [] }: { view: View; slug: string; myMatchIds?: string[]; organizer?: boolean; tz: string; courtNames?: string[] }) {
  const [t0, locale] = await Promise.all([getTranslations(), getLocale()]);
  const t = t0 as unknown as T;
  const roundsOf = (phase: string) => (phase === "main" ? view.main.length : phase === "consolation" ? view.consolation.length : phase === "qualifying" ? view.qualifying.length : 0);
  const where: Where = { tz, locale, courtNames, roundsOf };
  const mine = new Set(myMatchIds);
  const ruleLabel = (code: string) => t(`tournament.sc_${code}`);
  const rounds = (phase: MatchView[][], title: string, testId: string) =>
    phase.length > 0 && (
      <div className="mt-4" data-testid={testId}>
        <h3 className="font-extrabold">{title}</h3>
        {phase.map((ms, i) => (
          <div key={i} className="mt-2">
            <div className="text-xs font-bold uppercase tracking-wide text-muted">{roundName(t, i + 1, phase.length)}</div>
            <ul className="divide-y divide-line">
              {ms.map((m) => (
                <MatchLine key={m.id} t={t} m={m} slug={slug} canScore={mine.has(m.id)} organizer={organizer} ruleLabel={ruleLabel(m.scoring)} where={where} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  return (
    <div data-testid={`draw-${view.category.id}`}>
      {rounds(view.qualifying, t("tournament.phaseQualifying"), "qualifying")}
      {view.groups.length > 0 && (
        <div className="mt-4" data-testid="groups">
          <h3 className="font-extrabold">{t("tournament.phaseGroups")}</h3>
          {view.groups.map((g) => (
            <div key={g.label} className="mt-2" data-testid={`group-${g.label}`}>
              <div className="text-xs font-bold uppercase tracking-wide text-muted">{t("tournament.group", { label: g.label })}</div>
              <table className="mt-1 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="font-semibold"></th>
                    <th className="w-8 text-right font-semibold">{t("tournament.tableP")}</th>
                    <th className="w-8 text-right font-semibold">{t("tournament.tableW")}</th>
                    <th className="w-8 text-right font-semibold">{t("tournament.tableL")}</th>
                    <th className="w-14 text-right font-semibold">{t("tournament.tableSets")}</th>
                    <th className="w-16 text-right font-semibold">{t("tournament.tableGames")}</th>
                  </tr>
                </thead>
                <tbody>
                  {g.table.map((r, i) => (
                    <tr key={r.pairId} className={i < view.category.groupsThrough && g.complete ? "font-bold" : ""}>
                      <td className="max-w-0 truncate py-1 pr-2">
                        {i + 1}. {r.name}
                        {r.seed ? ` (${r.seed})` : ""}
                      </td>
                      <td className="text-right tabular-nums">{r.played}</td>
                      <td className="text-right tabular-nums">{r.won}</td>
                      <td className="text-right tabular-nums">{r.lost}</td>
                      <td className="text-right tabular-nums">
                        {r.setsFor}-{r.setsAgainst}
                      </td>
                      <td className="text-right tabular-nums">
                        {r.gamesFor}-{r.gamesAgainst}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="mt-1 divide-y divide-line">
                {g.matches.map((m) => (
                  <MatchLine key={m.id} t={t} m={m} slug={slug} canScore={mine.has(m.id)} organizer={organizer} ruleLabel={ruleLabel(m.scoring)} where={where} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {rounds(view.main, t("tournament.phaseMain"), "main-draw")}
      {rounds(view.consolation, t("tournament.phaseConsolation"), "consolation-draw")}
      {view.champion && (
        <p className="mt-4 font-bold" data-testid="champion">
          🏆 {t("tournament.champion")}: {view.champion.name}
        </p>
      )}
      {view.consolationWinner && (
        <p className="mt-1 text-sm text-muted">
          {t("tournament.consolationWinner")}: {view.consolationWinner.name}
        </p>
      )}
    </div>
  );
}
