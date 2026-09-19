"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { clearDrawAction, makeDrawAction, publishDrawAction, updateDrawSettingsAction } from "@/actions/competitions";

export type DrawSettingsView = { format: string; groupSize: number; groupsThrough: number; consolation: boolean; qualifyingSpots: number; scoringGroup: string; scoringKnockout: string; scoringFinal: string; goldenPoint: boolean; drawStatus: string; maxPairs: number };
const SCORING = ["set6tb", "set9", "sets2stb", "sets3"] as const;

/** The draw's settings while there is no draw; then make it, look at it, publish it, or clear it. */
export function DrawControls({ slug, categoryId, categoryName, settings }: { slug: string; categoryId: string; categoryName: string; settings: DrawSettingsView }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [v, setV] = useState({ ...settings });
  const locked = settings.drawStatus !== "none";
  const act = (fn: () => Promise<{ ok: boolean; error?: string; detail?: string }>) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error === "invalid" && r.detail === "few" ? t("tournament.drawFew") : r.error === "invalid" && r.detail === "scored" ? t("tournament.errLocked") : t("common.somethingWrong"));
      router.refresh();
    });
  };
  const select = (label: string, key: keyof typeof v, options: { value: string | number; label: string }[]) => (
    <label className="block">
      <span className="text-sm font-bold">{label}</span>
      <select className="input mt-1" disabled={locked} value={String(v[key])} onChange={(e) => setV({ ...v, [key]: typeof v[key] === "number" ? Number(e.target.value) : e.target.value })}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
  const scoringOptions = SCORING.map((s) => ({ value: s, label: t(`tournament.sc_${s}`) }));
  return (
    <section className="card flex flex-col gap-3" data-testid={`draw-controls-${categoryId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-extrabold">
          {t("tournament.drawSettings")} · {categoryName}
        </h2>
        <span className="chip-muted">{settings.drawStatus === "none" ? t("tournament.drawNone") : settings.drawStatus === "drawn" ? t("tournament.drawDrawn") : settings.drawStatus === "published" ? t("tournament.drawPublished") : t("tournament.drawDone")}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {select(t("tournament.format"), "format", [
          { value: "groups_knockout", label: t("tournament.formatGroups") },
          { value: "knockout", label: t("tournament.formatKnockout") },
        ])}
        {select(t("tournament.qualifyingSpots"), "qualifyingSpots", [0, 1, 2, 4, 8].filter((n) => n < settings.maxPairs).map((n) => ({ value: n, label: String(n) })))}
        {v.format === "groups_knockout" && select(t("tournament.groupSize"), "groupSize", [3, 4, 5, 6].map((n) => ({ value: n, label: String(n) })))}
        {v.format === "groups_knockout" && select(t("tournament.groupsThrough"), "groupsThrough", [1, 2, 3].filter((n) => n < v.groupSize).map((n) => ({ value: n, label: String(n) })))}
        {select(t("tournament.scoringGroup"), "scoringGroup", scoringOptions)}
        {select(t("tournament.scoringKnockout"), "scoringKnockout", scoringOptions)}
        {select(t("tournament.scoringFinal"), "scoringFinal", scoringOptions)}
        <div className="flex flex-col gap-2 pt-6">
          <label className="flex items-center gap-2 text-sm font-bold">
            <input type="checkbox" disabled={locked} checked={v.consolation} onChange={(e) => setV({ ...v, consolation: e.target.checked })} />
            {t("tournament.consolationOn")}
          </label>
          <label className="flex items-center gap-2 text-sm font-bold">
            <input type="checkbox" disabled={locked} checked={v.goldenPoint} onChange={(e) => setV({ ...v, goldenPoint: e.target.checked })} />
            {t("tournament.goldenPoint")}
          </label>
        </div>
      </div>
      {error && <p className="text-sm font-semibold text-warn">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {!locked && (
          <>
            <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => act(() => updateDrawSettingsAction(slug, categoryId, { format: v.format, groupSize: v.groupSize, groupsThrough: v.groupsThrough, consolation: v.consolation, qualifyingSpots: v.qualifyingSpots, scoringGroup: v.scoringGroup, scoringKnockout: v.scoringKnockout, scoringFinal: v.scoringFinal, goldenPoint: v.goldenPoint }))}>
              {t("common.save")}
            </button>
            <button type="button" className="btn-primary btn-sm" disabled={pending} onClick={() => act(async () => (await updateDrawSettingsAction(slug, categoryId, { format: v.format, groupSize: v.groupSize, groupsThrough: v.groupsThrough, consolation: v.consolation, qualifyingSpots: v.qualifyingSpots, scoringGroup: v.scoringGroup, scoringKnockout: v.scoringKnockout, scoringFinal: v.scoringFinal, goldenPoint: v.goldenPoint })).ok ? makeDrawAction(slug, categoryId) : { ok: false, error: "generic" })}>
              {t("tournament.makeDraw")}
            </button>
          </>
        )}
        {settings.drawStatus === "drawn" && (
          <>
            <button type="button" className="btn-primary btn-sm" disabled={pending} onClick={() => act(() => publishDrawAction(slug, categoryId))}>
              {t("tournament.publishDraw")}
            </button>
            <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => act(() => makeDrawAction(slug, categoryId))}>
              {t("tournament.redraw")}
            </button>
          </>
        )}
        {locked && settings.drawStatus !== "done" && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            disabled={pending}
            onClick={() => {
              if (confirm(t("tournament.clearDraw"))) act(() => clearDrawAction(slug, categoryId));
            }}
          >
            {t("tournament.clearDraw")}
          </button>
        )}
      </div>
    </section>
  );
}
