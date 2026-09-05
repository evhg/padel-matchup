"use client";

import { useTranslations } from "next-intl";
import { formatLevel, LEVEL_BANDS, LEVEL_STEPS, type BandKey } from "@/lib/domain/levels";

/** 0–7 in quarter steps, grouped by band. A plain <select>: it works in every sheet and keyboard situation. */
export function LevelSelect({ value, onChange, className = "", ariaLabel, placeholder }: { value: number | null; onChange: (v: number | null) => void; className?: string; ariaLabel?: string; placeholder?: string }) {
  const t = useTranslations();
  const groups = LEVEL_BANDS.map((b) => ({ key: b.key, steps: LEVEL_STEPS.filter((s) => s >= b.min && (s < b.max || (b.key === "pro" && s <= b.max))) }));
  return (
    <select className={`input px-3 ${className}`} aria-label={ariaLabel ?? t("level.yourLevel")} value={value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
      <option value="">{placeholder ?? t("level.pickTitle")}</option>
      {groups.map((g) => (
        <optgroup key={g.key} label={t(`level.bands.${g.key}`)}>
          {g.steps.map((s) => (
            <option key={s} value={String(s)}>
              {formatLevel(s)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Collapsed band descriptions for people who have never rated themselves. */
export function LevelGuide({ className = "" }: { className?: string }) {
  const t = useTranslations();
  const bands: BandKey[] = ["starting", "beginner", "intermediate", "advanced", "expert", "pro"];
  return (
    <details className={`text-sm ${className}`}>
      <summary className="cursor-pointer list-none link">{t("level.guide")}</summary>
      <ul className="mt-2 flex flex-col gap-1 text-muted">
        {bands.map((b) => (
          <li key={b}>
            <span className="font-bold text-ink">{t(`level.bands.${b}`)}</span> · {t(`level.bandHelp.${b}`)}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function LevelChip({ level, verified = false, className = "" }: { level: number | null | undefined; verified?: boolean; className?: string }) {
  const t = useTranslations();
  if (level == null) return null;
  return (
    <span className={`chip-muted tabular-nums ${className}`} title={verified ? t("level.verified") : undefined}>
      {formatLevel(level)}
      {verified && (
        <span className="ml-0.5 text-accent-strong" aria-label={t("level.verified")}>
          ✓
        </span>
      )}
    </span>
  );
}
