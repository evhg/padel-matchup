"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveStandingsAction } from "@/actions/scores";

export function StandingsPanel({ code, players, standings, canEdit }: { code: string; players: { id: string; name: string }[]; standings: string[]; canEdit: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [order, setOrder] = useState<string[]>(standings);
  const [pending, start] = useTransition();
  const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? "?";

  const save = () =>
    start(async () => {
      const r = await saveStandingsAction(code, order);
      if (r.ok) {
        setEditing(false);
        router.refresh();
      }
    });

  return (
    <section id="score" className="card">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-extrabold">{t("score.standings")}</h2>
        {standings.length > 0 && <span className="chip-open">✓ {t("score.confirmedByOrganizer")}</span>}
      </div>
      <p className="mt-1 text-sm text-muted">{t("event.tournamentRoundsSoon")}</p>

      {!editing && standings.length > 0 && (
        <ol className="mt-3 flex flex-col gap-1">
          {standings.map((id, i) => (
            <li key={id} className={`flex items-center gap-3 rounded-xl px-3 py-2 ${i === 0 ? "bg-accent-soft" : "bg-bg"}`}>
              <span className="w-7 text-lg font-extrabold tabular-nums">{t("score.place", { n: i + 1 })}</span>
              <span className="font-semibold">{nameOf(id)}</span>
            </li>
          ))}
        </ol>
      )}

      {canEdit && !editing && (
        <button type="button" className={`${standings.length ? "btn-ghost btn-sm" : "btn-primary w-full"} mt-4`} onClick={() => setEditing(true)}>
          {standings.length ? t("score.edit") : t("score.enter")}
        </button>
      )}

      {editing && (
        <div className="mt-4 animate-pop">
          <p className="text-sm font-semibold text-muted">{t("score.standingsHelp")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {players.map((p) => {
              const idx = order.indexOf(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setOrder((o) => (o.includes(p.id) ? o.filter((x) => x !== p.id) : [...o, p.id]))}
                  className={`min-h-11 rounded-xl px-3 text-sm font-bold ring-1 ${idx >= 0 ? "bg-ink text-white ring-ink" : "bg-white ring-line-strong"}`}
                >
                  {idx >= 0 ? `${idx + 1}. ` : ""}
                  {p.name}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn-primary flex-1" disabled={pending || order.length === 0} onClick={save}>
              {pending ? t("common.saving") : t("score.saveStandings")}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setOrder([])}>
              {t("score.clear")}
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
