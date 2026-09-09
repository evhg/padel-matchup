"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { createSeriesAction, setSeriesActiveAction } from "@/actions/series";

/**
 * The door on a finished tournament, for its organizer: a name, a rhythm, one
 * button. The series page opens with the next edition already on it.
 */
const FIELD_SIZES = Array.from({ length: 16 }, (_, i) => (i + 1) * 4);

export function SeriesDoor({ code, suggestedName, suggestedCapacity }: { code: string; suggestedName: string; suggestedCapacity: number }) {
  const t = useTranslations();
  const [name, setName] = useState(suggestedName);
  const [capacity, setCapacity] = useState(FIELD_SIZES.find((n) => n >= suggestedCapacity) ?? 64);
  const [every, setEvery] = useState<"week" | "fortnight" | "month">("week");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card" data-testid="series-door">
      <h2 className="text-lg font-extrabold">↻ {t("series.doorTitle")}</h2>
      <p className="mt-1 text-sm text-muted">{t("series.doorHelp")}</p>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start(async () => {
            const r = await createSeriesAction(code, name, every, capacity);
            if (r && !r.ok) setError(r.error === "too_many" ? t("series.tooMany") : t("common.somethingWrong"));
          });
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-sm font-bold">{t("series.name")}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} minLength={2} required />
          <span className="text-xs text-faint">{t("series.nameHelp")}</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-bold">{t("series.players")}</span>
          <select className="input" value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} aria-label={t("series.players")}>
            {FIELD_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-bold">{t("series.every")}</span>
          <select className="input" value={every} onChange={(e) => setEvery(e.target.value as "week" | "fortnight" | "month")} aria-label={t("series.every")}>
            <option value="week">{t("series.everyWeek")}</option>
            <option value="fortnight">{t("series.everyFortnight")}</option>
            <option value="month">{t("series.everyMonth")}</option>
          </select>
        </label>
        <button type="submit" className="btn-primary w-full" disabled={pending || name.trim().length < 2}>
          {pending ? t("common.working") : t("series.create")}
        </button>
        {error && <p className="text-sm text-danger">{error}</p>}
      </form>
    </section>
  );
}

/** Pause or resume, for the organizer on the series page. */
export function SeriesPauseButton({ slug, active }: { slug: string; active: boolean }) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-4 border-t border-line pt-4">
      <button
        type="button"
        className="btn-ghost w-full"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await setSeriesActiveAction(slug, !active);
            if (!r.ok) setError(t("common.somethingWrong"));
          })
        }
      >
        {pending ? t("common.working") : active ? `⏸ ${t("series.pause")}` : `▶ ${t("series.resume")}`}
      </button>
      <p className="mt-1 text-center text-xs text-faint">{t("series.pauseHelp")}</p>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
