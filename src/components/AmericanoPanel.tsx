"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { deleteLastRoundAction, generateRoundAction, saveTournamentMatchAction, setTournamentLockAction, setTournamentSettingsAction } from "@/actions/tournament";
import { POINTS_PRESETS } from "@/lib/domain/americano";
import { PlayAgainButton } from "./PlayAgainButton";

export type PanelMatch = { id: string; court: number; a: [string, string]; b: [string, string]; sideA: number | null; sideB: number | null };
export type PanelRound = { id: string; roundNumber: number; resting: string[]; matches: PanelMatch[] };
export type PanelStanding = { playerId: string; name: string; rank: number; points: number; played: number; wins: number; diff: number };

export function AmericanoPanel({
  code,
  isCreator,
  canScore,
  locked,
  started,
  cancelled,
  courts,
  maxCourts,
  pointsPerMatch,
  participantCount,
  capacity,
  rounds,
  standings,
  canPlayAgain = false,
}: {
  code: string;
  isCreator: boolean;
  canScore: boolean;
  locked: boolean;
  started: boolean;
  cancelled: boolean;
  courts: number | null;
  maxCourts: number;
  pointsPerMatch: number | null;
  /** Named roster spots: joined, confirmed and reserved-not-yet-accepted. */
  participantCount: number;
  capacity: number;
  rounds: PanelRound[];
  standings: PanelStanding[];
  canPlayAgain?: boolean;
}) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const last = rounds.at(-1);
  const lastUnscored = last ? last.matches.every((m) => m.sideA == null && m.sideB == null) : false;
  const nextRound = (last?.roundNumber ?? 0) + 1;
  const firstRound = rounds.length === 0;
  const inFours = participantCount % 4 === 0;
  const canGenerate = isCreator && !locked && !cancelled && participantCount >= 4 && (!firstRound || inFours);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(t(`errors.${(r.error as string) === "name_required" || r.error === "no_identity" ? "generic" : (r.error as string)}` as "errors.generic"));
    });

  return (
    <section id="score" className="card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-extrabold">{t("americano.title")}</h2>
        {locked ? <span className="chip-open">✓ {t("americano.locked")}</span> : rounds.length > 0 && started ? <span className="chip-live">● {t("americano.live")}</span> : null}
      </div>
      <button type="button" className="mt-1 text-left text-sm link" onClick={() => setHelp((h) => !h)}>
        {help ? "−" : "?"} {t("create.typeTournament")}
      </button>
      {help && <p className="mt-1 text-sm text-muted">{t("americano.howItWorks")}</p>}

      {isCreator && !locked && !cancelled && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="label">{t("americano.courts")}</span>
            <select className="input" value={courts ?? ""} disabled={pending} onChange={(e) => run(() => setTournamentSettingsAction(code, { courts: e.target.value ? Number(e.target.value) : null }))}>
              <option value="">{t("americano.auto", { n: Math.max(1, maxCourts) })}</option>
              {Array.from({ length: Math.max(1, maxCourts) }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">{t("americano.pointsPerMatch")}</span>
            <select className="input" value={pointsPerMatch ?? ""} disabled={pending} onChange={(e) => run(() => setTournamentSettingsAction(code, { pointsPerMatch: e.target.value ? Number(e.target.value) : null }))}>
              <option value="">{t("americano.free")}</option>
              {POINTS_PRESETS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {(rounds.length > 0 || locked) && (
        <div className="mt-4">
          <h3 className="text-sm font-extrabold uppercase tracking-wider text-muted">{locked ? t("americano.finalStandings") : t("americano.standings")}</h3>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-bold uppercase tracking-wider text-faint">
                <th className="w-8 py-1">#</th>
                <th className="py-1">&nbsp;</th>
                <th className="py-1 text-right">{t("americano.pts")}</th>
                <th className="w-9 py-1 text-right">{t("americano.colPlayed")}</th>
                <th className="w-9 py-1 text-right">{t("americano.colWins")}</th>
                <th className="w-12 py-1 text-right">{t("americano.colDiff")}</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((s) => (
                <tr key={s.playerId} className={`border-t border-line ${locked && s.rank === 1 ? "bg-accent-soft" : ""}`}>
                  <td className="py-2 font-extrabold tabular-nums">{s.rank}</td>
                  <td className="py-2 font-semibold">{s.name}</td>
                  <td className="py-2 text-right text-base font-extrabold tabular-nums">{s.points}</td>
                  <td className="py-2 text-right tabular-nums text-muted">{s.played}</td>
                  <td className="py-2 text-right tabular-nums text-muted">{s.wins}</td>
                  <td className="py-2 text-right tabular-nums text-muted">{s.diff > 0 ? `+${s.diff}` : s.diff}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rounds.length === 0 && !isCreator && <p className="mt-4 text-sm text-muted">{t("americano.noRounds")}</p>}
      {rounds.length > 0 && !started && <p className="mt-3 text-sm text-muted">{t("americano.notStarted")}</p>}
      {rounds.length > 0 && started && canScore && !locked && <p className="mt-3 text-xs text-faint">{t("americano.enterHelp")}</p>}

      <div className="mt-4 flex flex-col gap-4">
        {[...rounds].reverse().map((r) => (
          <div key={r.id} className="rounded-2xl border border-line p-3">
            <div className="flex items-center justify-between">
              <div className="font-extrabold">{t("americano.round", { n: r.roundNumber })}</div>
              {isCreator && !locked && r.id === last?.id && lastUnscored && (
                <button
                  type="button"
                  className="btn-danger btn-xs"
                  disabled={pending}
                  onClick={() => {
                    if (confirm(t("americano.deleteLastRoundConfirm", { n: r.roundNumber }))) run(() => deleteLastRoundAction(code));
                  }}
                >
                  {t("americano.deleteLastRound", { n: r.roundNumber })}
                </button>
              )}
            </div>
            <div className="mt-2 flex flex-col gap-2">
              {r.matches.map((m) => (
                <MatchRow key={m.id} code={code} match={m} editable={canScore && started && !cancelled && (!locked || isCreator)} pointsPerMatch={pointsPerMatch} />
              ))}
            </div>
            {r.resting.length > 0 && <p className="mt-2 text-xs text-muted">{t("americano.resting", { names: r.resting.join(", ") })}</p>}
          </div>
        ))}
      </div>

      {error && <p className="mt-3 text-sm font-semibold text-danger">{error}</p>}

      {isCreator && !cancelled && (
        <div className="mt-4 flex flex-col gap-2">
          {!locked && (
            <>
              <button type="button" className={`${rounds.length === 0 || started ? "btn-primary" : "btn-secondary"} w-full`} disabled={pending || !canGenerate} onClick={() => run(() => generateRoundAction(code))}>
                {pending ? t("common.working") : rounds.length === 0 ? t("americano.generateFirst") : t("americano.generateRound", { n: nextRound })}
              </button>
              {participantCount < 4 ? (
                <p className="text-center text-xs text-muted">{t("americano.needPlayers", { count: participantCount })}</p>
              ) : firstRound && !inFours ? (
                <p className="text-center text-xs font-semibold text-warn">{t("americano.needMultiple", { count: participantCount, up: 4 - (participantCount % 4), down: participantCount % 4 })}</p>
              ) : firstRound && participantCount < capacity ? (
                <p className="text-center text-xs text-muted">{t("americano.autoShrink", { count: participantCount })}</p>
              ) : null}
              {rounds.length > 0 && (
                <button
                  type="button"
                  className="btn-ghost w-full"
                  disabled={pending}
                  onClick={() => {
                    if (confirm(t("americano.finalizeConfirm"))) run(() => setTournamentLockAction(code, true));
                  }}
                >
                  🏆 {t("americano.finalize")}
                </button>
              )}
            </>
          )}
          {locked && (
            <button type="button" className="btn-ghost btn-sm self-start" disabled={pending} onClick={() => run(() => setTournamentLockAction(code, false))}>
              {t("americano.unlock")}
            </button>
          )}
        </div>
      )}
      {locked && canPlayAgain && (
        <div className="mt-4 border-t border-line pt-4">
          <PlayAgainButton code={code} />
        </div>
      )}
    </section>
  );
}

function MatchRow({ code, match, editable, pointsPerMatch }: { code: string; match: PanelMatch; editable: boolean; pointsPerMatch: number | null }) {
  const t = useTranslations();
  const [a, setA] = useState<string>(match.sideA == null ? "" : String(match.sideA));
  const [b, setB] = useState<string>(match.sideB == null ? "" : String(match.sideB));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const dirty = a !== (match.sideA == null ? "" : String(match.sideA)) || b !== (match.sideB == null ? "" : String(match.sideB));
  const [, start] = useTransition();
  const aWon = match.sideA != null && match.sideB != null && match.sideA > match.sideB;
  const bWon = match.sideA != null && match.sideB != null && match.sideB > match.sideA;

  const save = () => {
    if (!dirty) return;
    setState("saving");
    start(async () => {
      const r = await saveTournamentMatchAction(code, match.id, a === "" ? null : Number(a), b === "" ? null : Number(b));
      setState(r.ok ? "saved" : "error");
      if (r.ok) setTimeout(() => setState("idle"), 1500);
    });
  };
  const onOther = (mine: string, setMine: (v: string) => void, v: string) => {
    setMine(v);
    // Fixed-points format: typing one side fills the other.
    if (pointsPerMatch && v !== "" && Number(v) <= pointsPerMatch) {
      const other = String(pointsPerMatch - Number(v));
      if (setMine === setA) setB(other);
      else setA(other);
    }
    void mine;
  };

  return (
    <div className="rounded-xl bg-bg p-3">
      <div className="mb-2 text-[11px] font-extrabold uppercase tracking-wider text-faint">{t("americano.court", { n: match.court })}</div>
      <div className="grid grid-cols-[1fr_auto_auto_auto_1fr] items-center gap-2">
        <div className={`text-sm font-bold leading-tight ${aWon ? "" : match.sideA != null ? "text-muted" : ""}`}>
          {match.a[0]}
          <br />
          {match.a[1]}
        </div>
        {editable ? (
          <input aria-label="A" className="input h-12 min-h-0 w-14 px-0 text-center text-xl font-extrabold tabular-nums" type="number" inputMode="numeric" min={0} max={99} value={a} onChange={(e) => onOther(a, setA, e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        ) : (
          <span className={`inline-grid h-12 w-14 place-items-center rounded-xl text-xl font-extrabold tabular-nums ${aWon ? "bg-accent" : "bg-white"}`}>{match.sideA ?? "–"}</span>
        )}
        <span className="text-xs font-bold text-faint">{t("americano.vs")}</span>
        {editable ? (
          <input aria-label="B" className="input h-12 min-h-0 w-14 px-0 text-center text-xl font-extrabold tabular-nums" type="number" inputMode="numeric" min={0} max={99} value={b} onChange={(e) => onOther(b, setB, e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        ) : (
          <span className={`inline-grid h-12 w-14 place-items-center rounded-xl text-xl font-extrabold tabular-nums ${bWon ? "bg-accent" : "bg-white"}`}>{match.sideB ?? "–"}</span>
        )}
        <div className={`text-right text-sm font-bold leading-tight ${bWon ? "" : match.sideB != null ? "text-muted" : ""}`}>
          {match.b[0]}
          <br />
          {match.b[1]}
        </div>
      </div>
      {editable && (
        <div className="mt-1 h-4 text-right text-xs font-semibold">
          {state === "saving" && <span className="text-muted">…</span>}
          {state === "saved" && <span className="text-ok">✓ {t("americano.saved")}</span>}
          {state === "error" && <span className="text-danger">{t("errors.generic")}</span>}
          {state === "idle" && dirty && (
            <button type="button" className="link" onMouseDown={(e) => e.preventDefault()} onClick={save}>
              {t("americano.save")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
