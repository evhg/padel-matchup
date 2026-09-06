"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { LEVEL_SCALES, bandOf, formatLevel, fromScale, type LevelScale } from "@/lib/domain/levels";

/** Folded under the level picker: a number from another app becomes a 0–7 level, mapping shown, nothing hidden. */
export function LevelImport({ onPick }: { onPick: (level: number) => void }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [scaleId, setScaleId] = useState<LevelScale["id"]>("playtomic");
  const [raw, setRaw] = useState("");
  const scale = LEVEL_SCALES.find((s) => s.id === scaleId)!;
  const level = raw.trim() ? fromScale(scaleId, Number(raw.replace(",", "."))) : null;
  if (!open)
    return (
      <button type="button" className="self-start text-sm link" onClick={() => setOpen(true)}>
        {t("passport.importTitle")}
      </button>
    );
  return (
    <div className="rounded-2xl border border-line px-3 py-3">
      <div className="text-sm font-bold">{t("passport.importTitle")}</div>
      <p className="mt-1 text-xs text-muted">{t("passport.importHelp")}</p>
      <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
        <label className="block">
          <span className="text-xs font-bold text-faint">{t("passport.importScale")}</span>
          <select className="input mt-1" value={scaleId} onChange={(e) => setScaleId(e.target.value as LevelScale["id"])}>
            {LEVEL_SCALES.map((s) => (
              <option key={s.id} value={s.id}>
                {t(`passport.scale.${s.id}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="block w-24">
          <span className="text-xs font-bold text-faint">{t("passport.importValue")}</span>
          <input className="input mt-1" inputMode="decimal" min={scale.min} max={scale.max} step={scale.step} type="number" value={raw} onChange={(e) => setRaw(e.target.value)} />
        </label>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-sm">
        <span className="text-muted">{raw.trim() ? (level != null ? `→ ${formatLevel(level)} · ${t(`level.bands.${bandOf(level)}`)}` : t("passport.importInvalid")) : `${scale.min}–${scale.max}`}</span>
        <button type="button" className="btn-secondary btn-sm" disabled={level == null} onClick={() => level != null && onPick(level)}>
          {level != null ? t("passport.importUse", { level: formatLevel(level) }) : t("passport.importUse", { level: "—" })}
        </button>
      </div>
    </div>
  );
}
