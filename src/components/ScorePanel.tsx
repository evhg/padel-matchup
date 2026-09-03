"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { saveScoreAction } from "@/actions/scores";
import { tally } from "@/lib/domain/scores";
import { PlayAgainButton } from "./PlayAgainButton";

type P = { id: string; name: string; team: "a" | "b" | null };
type S = { setNumber: number; sideA: number; sideB: number };

export function ScorePanel({
  code,
  scores,
  players,
  canEdit,
  reason,
  locked,
  enteredBy,
  canPlayAgain = false,
}: {
  code: string;
  scores: S[];
  players: P[];
  canEdit: boolean;
  reason: "not_started" | "cancelled" | "not_participant" | "locked" | null;
  locked: boolean;
  enteredBy: string | null;
  /** Creator or participant: offer "Play again next week" once a result exists. */
  canPlayAgain?: boolean;
}) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [sets, setSets] = useState<S[]>(scores.length ? scores : [{ setNumber: 1, sideA: 6, sideB: 4 }]);
  const [teamA, setTeamA] = useState<string[]>(players.filter((p) => p.team === "a").map((p) => p.id));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const teamAPlayers = players.filter((p) => p.team === "a");
  const teamBPlayers = players.filter((p) => p.team === "b");
  const hasTeams = teamAPlayers.length > 0;
  const tl = tally(scores);

  const toggleTeam = (id: string) => {
    setTeamA((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 2 ? [cur[1], id] : [...cur, id]));
  };

  const save = () =>
    start(async () => {
      setError(null);
      const r = await saveScoreAction(code, sets, teamA.length === 2 ? teamA : undefined);
      if (!r.ok) {
        setError(t(`errors.${r.error === "name_required" || r.error === "no_identity" ? "generic" : r.error}` as "errors.generic"));
        return;
      }
      setEditing(false);
    });

  const numInput = (value: number, onChange: (n: number) => void, label: string) => (
    <input
      aria-label={label}
      className="input h-16 min-h-0 w-full px-0 text-center text-3xl font-extrabold tabular-nums"
      type="number"
      inputMode="numeric"
      min={0}
      max={30}
      value={Number.isFinite(value) ? value : ""}
      onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
      onFocus={(e) => e.target.select()}
    />
  );

  return (
    <section id="score" className="card">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-extrabold">{scores.length ? t("score.result") : t("score.title")}</h2>
        {locked && scores.length > 0 && <span className="chip-open">✓ {t("score.confirmedByOrganizer")}</span>}
      </div>

      {scores.length > 0 && !editing && (
        <div className="mt-3">
          <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2">
            <div className={`font-bold ${tl.a > tl.b ? "" : "text-muted"}`}>{hasTeams ? teamAPlayers.map((p) => p.name).join(" & ") : t("score.teamA")}</div>
            <div className="flex gap-2">
              {scores.map((s) => (
                <span key={s.setNumber} className={`inline-grid h-11 w-11 place-items-center rounded-xl text-xl font-extrabold tabular-nums ${s.sideA > s.sideB ? "bg-accent text-ink" : "bg-bg text-muted"}`}>
                  {s.sideA}
                </span>
              ))}
            </div>
            <div className={`font-bold ${tl.b > tl.a ? "" : "text-muted"}`}>{hasTeams ? teamBPlayers.map((p) => p.name).join(" & ") : t("score.teamB")}</div>
            <div className="flex gap-2">
              {scores.map((s) => (
                <span key={s.setNumber} className={`inline-grid h-11 w-11 place-items-center rounded-xl text-xl font-extrabold tabular-nums ${s.sideB > s.sideA ? "bg-accent text-ink" : "bg-bg text-muted"}`}>
                  {s.sideB}
                </span>
              ))}
            </div>
          </div>
          {enteredBy && !locked && <p className="mt-3 text-xs text-faint">{t("score.enteredBy", { name: enteredBy })}</p>}
          {canPlayAgain && (
            <div className="mt-4 border-t border-line pt-4">
              <PlayAgainButton code={code} />
            </div>
          )}
        </div>
      )}

      {!editing && canEdit && (
        <button type="button" className={`${scores.length ? "btn-ghost btn-sm" : "btn-primary w-full"} mt-4`} onClick={() => setEditing(true)}>
          {scores.length ? t("score.edit") : t("score.enter")}
        </button>
      )}
      {!editing && !canEdit && reason && reason !== "cancelled" && (
        <p className="mt-3 text-sm text-muted">{reason === "not_started" ? t("score.notStarted") : reason === "locked" ? t("score.lockedHelp") : t("score.notParticipant")}</p>
      )}

      {editing && (
        <div className="mt-4 flex flex-col gap-4 animate-pop">
          {players.length >= 2 && (
            <div>
              <div className="text-sm font-semibold text-muted">{t("score.pickTeams")}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {players.map((p) => {
                  const inA = teamA.includes(p.id);
                  const inB = teamA.length === 2 && !inA;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggleTeam(p.id)}
                      className={`min-h-11 rounded-xl px-3 text-sm font-bold ring-1 transition ${inA ? "bg-accent text-ink ring-accent" : inB ? "bg-ink text-white ring-ink" : "bg-white text-ink ring-line-strong"}`}
                    >
                      {inA ? "A · " : inB ? "B · " : ""}
                      {p.name}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-xs text-faint">{t("score.teamsOptional")}</p>
            </div>
          )}

          <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-2">
            <div />
            <div className="text-center text-xs font-extrabold uppercase tracking-wider text-muted">{t("score.teamA")}</div>
            <div className="text-center text-xs font-extrabold uppercase tracking-wider text-muted">{t("score.teamB")}</div>
            {sets.map((s, i) => (
              <div key={i} className="contents">
                <div className="text-sm font-bold text-muted">{t("score.set", { n: i + 1 })}</div>
                {numInput(s.sideA, (n) => setSets((cur) => cur.map((x, j) => (j === i ? { ...x, sideA: n } : x))), `${t("score.set", { n: i + 1 })} ${t("score.teamA")}`)}
                {numInput(s.sideB, (n) => setSets((cur) => cur.map((x, j) => (j === i ? { ...x, sideB: n } : x))), `${t("score.set", { n: i + 1 })} ${t("score.teamB")}`)}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            {sets.length < 3 && (
              <button type="button" className="btn-ghost btn-sm" onClick={() => setSets((c) => [...c, { setNumber: c.length + 1, sideA: 6, sideB: 4 }])}>
                + {t("score.addSet")}
              </button>
            )}
            {sets.length > 1 && (
              <button type="button" className="btn-ghost btn-sm" onClick={() => setSets((c) => c.slice(0, -1))}>
                − {t("score.removeSet")}
              </button>
            )}
          </div>
          {error && <p className="text-sm font-semibold text-danger">{error}</p>}
          <div className="flex gap-2">
            <button type="button" className="btn-primary flex-1" disabled={pending} onClick={save}>
              {pending ? t("common.saving") : t("score.save")}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
