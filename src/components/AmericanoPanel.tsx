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
  pointsPerMatch,
  participantCount,
  capacity,
  rounds,
  standings,
  courtNames,
  rotationLength,
  canPlayAgain = false,
}: {
  code: string;
  isCreator: boolean;
  canScore: boolean;
  locked: boolean;
  started: boolean;
  cancelled: boolean;
  pointsPerMatch: number | null;
  /** Named roster spots: joined, confirmed and reserved-not-yet-accepted. */
  participantCount: number;
  capacity: number;
  rounds: PanelRound[];
  standings: PanelStanding[];
  /** Organizer-given court names by index (court 1 = [0]). */
  courtNames: string[] | null;
  /** Rounds until everyone has partnered everyone once (field in fours), else null. */
  rotationLength: number | null;
  canPlayAgain?: boolean;
}) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [namesOpen, setNamesOpen] = useState(false);
  const last = rounds.at(-1);
  const lastScored = last ? last.matches.some((m) => m.sideA != null || m.sideB != null) : false;
  const nextRound = (last?.roundNumber ?? 0) + 1;
  const firstRound = rounds.length === 0;
  const inFours = participantCount % 4 === 0;
  const canGenerate = isCreator && !locked && !cancelled && participantCount >= 4 && (!firstRound || inFours);
  const courtCount = Math.max(1, Math.floor(participantCount / 4), ...rounds.flatMap((r) => r.matches.map((m) => m.court)));
  const courtLabel = (n: number) => courtNames?.[n - 1]?.trim() || t("americano.court", { n });
  const [names, setNames] = useState<string[]>(() => Array.from({ length: courtCount }, (_, i) => courtNames?.[i] ?? ""));
  const repeatsRound = rotationLength && nextRound > rotationLength ? ((nextRound - 1) % rotationLength) + 1 : null;

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
          <div className="block">
            <span className="label">{t("americano.courtNames")}</span>
            <button type="button" className="btn-ghost w-full justify-between" onClick={() => setNamesOpen((o) => !o)} aria-expanded={namesOpen}>
              <span className="truncate">{Array.from({ length: courtCount }, (_, i) => courtLabel(i + 1)).join(" · ")}</span>
              <span className="text-faint">✎</span>
            </button>
          </div>
        </div>
      )}
      {isCreator && !locked && !cancelled && namesOpen && (
        <form
          className="mt-3 rounded-2xl bg-bg p-3 animate-pop"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => setTournamentSettingsAction(code, { courtNames: names }));
            setNamesOpen(false);
          }}
        >
          <p className="text-xs text-muted">{t("americano.courtNamesHelp")}</p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {names.map((v, i) => (
              <input key={i} className="input min-h-11 text-sm" aria-label={t("americano.court", { n: i + 1 })} placeholder={t("americano.court", { n: i + 1 })} maxLength={20} value={v} onChange={(e) => setNames((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))} />
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <button type="submit" className="btn-secondary btn-sm" disabled={pending}>
              {t("americano.saveNames")}
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setNamesOpen(false)}>
              {t("common.cancel")}
            </button>
          </div>
        </form>
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
      {rounds.length > 0 && canScore && !locked && <p className="mt-3 text-xs text-faint">{t("americano.enterHelp")}</p>}

      <div className="mt-4 flex flex-col gap-4">
        {[...rounds].reverse().map((r) => (
          <div key={r.id} className="rounded-2xl border border-line p-3">
            <div className="flex items-center justify-between">
              <div className="font-extrabold">{t("americano.round", { n: r.roundNumber })}</div>
              {isCreator && !locked && r.id === last?.id && (
                <button
                  type="button"
                  className="btn-danger btn-xs"
                  disabled={pending}
                  onClick={() => {
                    if (confirm(t(lastScored ? "americano.deleteScoredRoundConfirm" : "americano.deleteLastRoundConfirm", { n: r.roundNumber }))) run(() => deleteLastRoundAction(code));
                  }}
                >
                  {t("americano.deleteLastRound", { n: r.roundNumber })}
                </button>
              )}
            </div>
            <div className="mt-2 flex flex-col gap-2">
              {r.matches.map((m) => (
                <MatchRow key={m.id} code={code} match={m} courtLabel={courtLabel(m.court)} editable={canScore && !cancelled && (!locked || isCreator)} pointsPerMatch={pointsPerMatch} />
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
                {pending ? t("common.working") : rounds.length === 0 ? t("americano.generateFirst") : repeatsRound ? t("americano.generateRepeat", { n: nextRound, again: repeatsRound }) : t("americano.generateRound", { n: nextRound })}
              </button>
              {participantCount < 4 ? (
                <p className="text-center text-xs text-muted">{t("americano.needPlayers", { count: participantCount })}</p>
              ) : firstRound && !inFours ? (
                <p className="text-center text-xs font-semibold text-warn">{t("americano.needMultiple", { count: participantCount, up: 4 - (participantCount % 4), down: participantCount % 4 })}</p>
              ) : firstRound && participantCount < capacity ? (
                <p className="text-center text-xs text-muted">{t("americano.autoShrink", { count: participantCount })}</p>
              ) : rotationLength && rounds.length >= rotationLength ? (
                <p className="text-center text-xs text-muted">{t("americano.rotationDone", { n: rotationLength })}</p>
              ) : rotationLength ? (
                <p className="text-center text-xs text-faint">{t("americano.rotationInfo", { n: rotationLength, left: rotationLength - rounds.length })}</p>
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

function MatchRow({ code, match, courtLabel, editable, pointsPerMatch }: { code: string; match: PanelMatch; courtLabel: string; editable: boolean; pointsPerMatch: number | null }) {
  const t = useTranslations();
  const [a, setA] = useState<string>(match.sideA == null ? "" : String(match.sideA));
  const [b, setB] = useState<string>(match.sideB == null ? "" : String(match.sideB));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "incomplete" | "error">("idle");
  const dirty = a !== (match.sideA == null ? "" : String(match.sideA)) || b !== (match.sideB == null ? "" : String(match.sideB));
  const [, start] = useTransition();
  const aWon = match.sideA != null && match.sideB != null && match.sideA > match.sideB;
  const bWon = match.sideA != null && match.sideB != null && match.sideB > match.sideA;

  const save = () => {
    if (!dirty) return;
    // Half a score is not an error: wait for the other box.
    if ((a === "") !== (b === "")) {
      setState("incomplete");
      return;
    }
    setState("saving");
    start(async () => {
      const r = await saveTournamentMatchAction(code, match.id, a === "" ? null : Number(a), b === "" ? null : Number(b));
      setState(r.ok ? "saved" : "error");
      if (r.ok) setTimeout(() => setState("idle"), 1500);
    });
  };
  const onOther = (setMine: (v: string) => void, v: string) => {
    setMine(v);
    setState("idle");
    // Fixed-points format: typing one side fills the other.
    if (pointsPerMatch && v !== "" && Number(v) <= pointsPerMatch) {
      const other = String(pointsPerMatch - Number(v));
      if (setMine === setA) setB(other);
      else setA(other);
    }
  };

  return (
    <div className="rounded-xl bg-bg p-3">
      <div className="mb-2 text-[11px] font-extrabold uppercase tracking-wider text-faint">{courtLabel}</div>
      <div className="grid grid-cols-[1fr_auto_auto_auto_1fr] items-center gap-2">
        <div className={`text-sm font-bold leading-tight ${aWon ? "" : match.sideA != null ? "text-muted" : ""}`}>
          {match.a[0]}
          <br />
          {match.a[1]}
        </div>
        {editable ? (
          <input aria-label="A" className="input h-12 min-h-0 w-14 px-0 text-center text-xl font-extrabold tabular-nums" type="number" inputMode="numeric" min={0} max={99} value={a} onChange={(e) => onOther(setA, e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        ) : (
          <span className={`inline-grid h-12 w-14 place-items-center rounded-xl text-xl font-extrabold tabular-nums ${aWon ? "bg-accent" : "bg-white"}`}>{match.sideA ?? "–"}</span>
        )}
        <span className="text-xs font-bold text-faint">{t("americano.vs")}</span>
        {editable ? (
          <input aria-label="B" className="input h-12 min-h-0 w-14 px-0 text-center text-xl font-extrabold tabular-nums" type="number" inputMode="numeric" min={0} max={99} value={b} onChange={(e) => onOther(setB, e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
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
          {state === "incomplete" && <span className="text-muted">{t("americano.completeScore")}</span>}
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
