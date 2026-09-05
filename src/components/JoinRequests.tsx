"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { decideJoinRequestAction } from "@/actions/slots";
import { formatLevel } from "@/lib/domain/levels";

export type RequestItem = { id: string; name: string; level: number | null; ago: string };

/** Organizer-only: players outside the level range who asked in. */
export function JoinRequests({ code, items }: { code: string; items: RequestItem[] }) {
  const t = useTranslations();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const decide = (id: string, approve: boolean) => {
    setBusy(id);
    start(async () => {
      setError(null);
      const r = await decideJoinRequestAction(code, id, approve);
      if (!r.ok) setError(t(`errors.${r.error === "name_required" || r.error === "no_identity" || r.error === "level_required" ? "generic" : r.error}` as "errors.generic"));
      setBusy(null);
    });
  };
  if (items.length === 0) return null;
  return (
    <div className="mt-4 rounded-2xl border border-warn/40 bg-warn-soft/40 p-3">
      <div className="font-extrabold">{t("level.requestsTitle")}</div>
      <p className="text-xs text-muted">{t("level.requestsHelp")}</p>
      <ul className="mt-2 flex flex-col gap-2">
        {items.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2">
            <span className="font-bold">{r.name}</span>
            {r.level != null && <span className="chip-muted tabular-nums">{formatLevel(r.level)}</span>}
            <span className="text-xs text-faint">{t("level.asked", { ago: r.ago })}</span>
            <span className="ml-auto flex gap-1.5">
              <button type="button" className="btn-secondary btn-sm" disabled={pending && busy === r.id} onClick={() => decide(r.id, true)}>
                {t("level.approve")}
              </button>
              <button type="button" className="btn-ghost btn-sm" disabled={pending && busy === r.id} onClick={() => decide(r.id, false)}>
                {t("level.decline")}
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-sm font-semibold text-danger">{error}</p>}
    </div>
  );
}
