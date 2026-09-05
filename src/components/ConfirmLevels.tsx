"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { verifyLevelsAction } from "@/actions/levels";
import { formatLevel } from "@/lib/domain/levels";

type Candidate = { id: string; name: string; level: number; verified: boolean };

/** After the result: the organizer confirms the levels of the people they played with. One row, folded by default. */
export function ConfirmLevels({ code, players }: { code: string; players: Candidate[] }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<Set<string>>(() => new Set(players.filter((p) => p.verified).map((p) => p.id)));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const left = players.filter((p) => !done.has(p.id));
  const confirm = (ids: string[]) =>
    start(async () => {
      setError(null);
      const r = await verifyLevelsAction(code, ids);
      if (r.ok) setDone((d) => new Set([...d, ...ids]));
      else setError(t("errors.generic"));
    });
  return (
    <section className="card">
      <button type="button" className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>
          <span className="block font-extrabold">✓ {t("level.confirmTitle")}</span>
          <span className="block text-xs text-muted">{left.length === 0 ? t("level.confirmedCount", { count: done.size }) : t("level.confirmHelpShort", { count: left.length })}</span>
        </span>
        <span className={`shrink-0 text-faint transition ${open ? "rotate-180" : ""}`} aria-hidden>
          ⌄
        </span>
      </button>
      {open && (
        <div className="mt-3 animate-pop">
          <p className="text-sm text-muted">{t("level.confirmHelp")}</p>
          <ul className="mt-3 flex flex-col gap-2">
            {players.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 rounded-2xl border border-line px-3 py-2">
                <span className="min-w-0 truncate font-semibold">
                  {p.name} <span className="ml-1 text-sm text-muted tabular-nums">{formatLevel(p.level)}</span>
                </span>
                {done.has(p.id) ? (
                  <span className="chip-open shrink-0">✓ {t("level.confirmed")}</span>
                ) : (
                  <button type="button" className="btn-secondary btn-xs shrink-0" disabled={pending} onClick={() => confirm([p.id])}>
                    {t("level.confirmOne")}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {left.length > 1 && (
            <button type="button" className="btn-primary mt-3 w-full" disabled={pending} onClick={() => confirm(left.map((p) => p.id))}>
              {pending ? t("common.working") : t("level.confirmAll", { count: left.length })}
            </button>
          )}
          {error && <p className="mt-2 text-sm font-semibold text-danger">{error}</p>}
        </div>
      )}
    </section>
  );
}
