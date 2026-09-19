"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { moveMatchAction } from "@/actions/competitions";

/** The organiser's way to put one match on another court or at another time; both pairs hear. */
export function MoveMatch({ slug, matchId, courtNames, court, local }: { slug: string; matchId: string; courtNames: string[]; court: string | null; local: string | null }) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [c, setC] = useState(court ?? courtNames[0] ?? "");
  const [when, setWhen] = useState(local ?? "");
  const [error, setError] = useState<string | null>(null);
  if (courtNames.length === 0) return null;
  if (!open) {
    return (
      <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(true)}>
        {t("tournament.move")}
      </button>
    );
  }
  return (
    <form
      className="mt-1 flex flex-wrap items-end gap-2"
      data-testid={`move-${matchId}`}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await moveMatchAction(slug, matchId, c, when);
          if (r.ok) {
            setOpen(false);
            router.refresh();
          } else setError(t("common.somethingWrong"));
        });
      }}
    >
      <label className="block">
        <span className="text-xs font-bold">{t("tournament.court")}</span>
        <select className="input mt-1 py-1 text-sm" value={c} onChange={(e) => setC(e.target.value)}>
          {courtNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <input className="input py-1 text-sm" type="datetime-local" value={when} required onChange={(e) => setWhen(e.target.value)} aria-label={t("tournament.move")} />
      <button type="submit" className="btn-primary btn-sm" disabled={pending || !when}>
        {t("tournament.move")}
      </button>
      <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>
        {t("common.cancel")}
      </button>
      {error && <span className="text-sm font-semibold text-warn">{error}</span>}
      <span className="w-full text-xs text-muted">{t("tournament.moveHelp")}</span>
    </form>
  );
}
