"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { POINTS_PRESETS } from "@/lib/domain/americano";
import { hasRange, LEVEL_PRESETS, LEVEL_STEPS, formatLevel, normalizeRange, presetFor, rangeFor, type PresetKey } from "@/lib/domain/levels";
import { nextOccurrence } from "@/lib/dates";
import { rangeText } from "@/lib/levelText";
import { LevelGuide, LevelSelect } from "./LevelSelect";
import { VenueCombobox, type VenueOption } from "./VenueCombobox";

export type EventFormValues = {
  type: "match" | "tournament";
  title: string;
  date: string;
  time: string;
  tz: string;
  venueName: string;
  venueMapUrl: string;
  court: string;
  note: string;
  capacity: number;
  whenFull: "waitlist" | "closed";
  courts: number | null;
  pointsPerMatch: number | null;
  /** Level range; both null = open to everyone. */
  levelMin: number | null;
  levelMax: number | null;
  /** Organizer's own level, asked once when they set a range without having one. */
  myLevel: number | null;
};

export type TimePatternInput = { dow: number; time: string };
type Chip = { key: string; date: string; time: string; label: string };

/** Quick picks: the organizer's own recurring slots, projected to their next occurrence. Never guessed. */
function historyChips(patterns: TimePatternInput[], tz: string, locale: string, label: (day: string, time: string) => string, now = new Date()): Chip[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  return patterns.map((p) => {
    const next = nextOccurrence(p.dow, p.time, tz, now);
    return { key: `${p.dow}-${p.time}`, ...next, label: label(fmt.format(new Date(`${next.date}T00:00:00Z`)), p.time) };
  });
}

function timeZones(current: string): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    return list.includes(current) || !current ? list : [current, ...list];
  } catch {
    return [current];
  }
}

export function EventFields({
  values,
  onChange,
  venues,
  showType = true,
  patterns = [],
  hasLevel = true,
}: {
  values: EventFormValues;
  onChange: (patch: Partial<EventFormValues>) => void;
  venues: VenueOption[];
  showType?: boolean;
  patterns?: TimePatternInput[];
  /** False when the organizer has no level yet: a range then also asks for theirs. */
  hasLevel?: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [tzOpen, setTzOpen] = useState(false);
  const zones = useMemo(() => timeZones(values.tz), [values.tz]);
  const chips = useMemo(() => historyChips(patterns, values.tz, locale, (day, time) => t("create.chipDay", { day, time })), [patterns, values.tz, locale, t]);
  const [moreOpen, setMoreOpen] = useState(Boolean(values.title || values.note));
  const range = { min: values.levelMin, max: values.levelMax };
  const preset = presetFor(range);
  const [customOpen, setCustomOpen] = useState(preset === "custom");
  const levelChoice: PresetKey | "custom" | "any" = customOpen ? "custom" : (preset ?? "any");
  const pickPreset = (k: PresetKey | "custom" | "any") => {
    if (k === "any") {
      setCustomOpen(false);
      onChange({ levelMin: null, levelMax: null });
    } else if (k === "custom") {
      setCustomOpen(true);
      if (!hasRange(range)) onChange({ levelMin: 2.5, levelMax: 4 });
    } else {
      setCustomOpen(false);
      const r = rangeFor(k);
      onChange({ levelMin: r.min, levelMax: r.max });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {showType && (
        <div>
          <div className="segment" role="group" aria-label={t("create.title")}>
            <button type="button" aria-pressed={values.type === "match"} onClick={() => onChange({ type: "match" })}>
              {t("create.typeMatch")}
              <span className="block text-[11px] font-semibold opacity-70">{t("create.typeMatchHelp")}</span>
            </button>
            <button type="button" aria-pressed={values.type === "tournament"} onClick={() => onChange({ type: "tournament" })}>
              {t("create.typeTournament")}
              <span className="block text-[11px] font-semibold opacity-70">{t("create.typeTournamentHelp")}</span>
            </button>
          </div>

        </div>
      )}

      {chips.length > 0 && (
        <div>
          <div className="label">{t("create.chipsLabel")}</div>
          <div className="flex flex-wrap gap-2">
          {chips.map((c) => {
            const active = values.date === c.date && values.time === c.time;
            return (
              <button key={c.key} type="button" aria-pressed={active} onClick={() => onChange({ date: c.date, time: c.time })} className={`min-h-11 rounded-xl px-3.5 text-sm font-bold ring-1 transition ${active ? "bg-ink text-white ring-ink" : "bg-white text-ink ring-line-strong hover:bg-bg"}`}>
                {c.label}
              </button>
            );
          })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">{t("create.date")}</label>
          <input className="input" type="date" value={values.date} onChange={(e) => onChange({ date: e.target.value })} required />
        </div>
        <div>
          <label className="label">{t("create.time")}</label>
          <input className="input" type="time" step={300} value={values.time} onChange={(e) => onChange({ time: e.target.value })} required />
        </div>
      </div>
      <div className="-mt-3 text-sm text-muted">
        {t("create.timezone")}:{" "}
        {tzOpen ? (
          <select className="input mt-1" value={values.tz} onChange={(e) => onChange({ tz: e.target.value })}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        ) : (
          <button type="button" className="link" onClick={() => setTzOpen(true)}>
            {values.tz.replace(/_/g, " ")}
          </button>
        )}
      </div>

      <VenueCombobox venues={venues} value={values.venueName} mapUrl={values.venueMapUrl} onChange={(v) => onChange({ venueName: v.name, venueMapUrl: v.mapUrl })} />

      <div className="-mt-2">
        <label className="label">
          {t("create.court")} <span className="font-normal">({t("common.optional")})</span>
        </label>
        <input className="input" value={values.court} maxLength={40} placeholder={t("create.courtPlaceholder")} autoComplete="off" onChange={(e) => onChange({ court: e.target.value })} />
      </div>

      {values.type === "tournament" && (
        <div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">{t("create.capacity")}</label>
              <select
                className="input px-3"
                aria-label={t("create.capacity")}
                value={values.capacity}
                onChange={(e) => onChange({ capacity: Number(e.target.value) })}
              >
                {Array.from({ length: 16 }, (_, i) => (i + 1) * 4).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{t("create.pointsPerMatch")}</label>
              <select className="input px-3" value={values.pointsPerMatch ?? ""} onChange={(e) => onChange({ pointsPerMatch: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{t("create.pointsFree")}</option>
                {POINTS_PRESETS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="mt-1.5 text-sm text-muted">{t("create.tournamentHelp")} {t("create.capacityHelp")}</p>
        </div>
      )}

      <div>
        <label className="label">{t("create.whenFull")}</label>
        <div className="segment">
          <button type="button" aria-pressed={values.whenFull === "waitlist"} onClick={() => onChange({ whenFull: "waitlist" })}>
            {t("create.whenFullWaitlist")}
          </button>
          <button type="button" aria-pressed={values.whenFull === "closed"} onClick={() => onChange({ whenFull: "closed" })}>
            {t("create.whenFullClosed")}
          </button>
        </div>
        <p className="mt-1.5 text-sm text-muted">{values.whenFull === "waitlist" ? t("create.whenFullWaitlistHelp") : t("create.whenFullClosedHelp")}</p>
      </div>

      <div>
        <label className="label">{t("level.label")}</label>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("level.label")}>
          {(["any", ...LEVEL_PRESETS.map((p) => p.key), "custom"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={levelChoice === k} onClick={() => pickPreset(k)} className={`min-h-10 rounded-xl px-3 text-sm font-bold ring-1 transition ${levelChoice === k ? "bg-ink text-white ring-ink" : "bg-white text-ink ring-line-strong hover:bg-bg"}`}>
              {t(`level.${k}`)}
            </button>
          ))}
        </div>
        {levelChoice === "custom" && (
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div>
              <label className="label">{t("level.from")}</label>
              <select className="input px-3" value={values.levelMin ?? 0} onChange={(e) => { const r = normalizeRange(Number(e.target.value), values.levelMax ?? 7); onChange({ levelMin: r.min, levelMax: r.max }); }}>
                {LEVEL_STEPS.map((v) => (
                  <option key={v} value={v}>
                    {formatLevel(v)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{t("level.to")}</label>
              <select className="input px-3" value={values.levelMax ?? 7} onChange={(e) => { const r = normalizeRange(values.levelMin ?? 0, Number(e.target.value)); onChange({ levelMin: r.min, levelMax: r.max }); }}>
                {LEVEL_STEPS.map((v) => (
                  <option key={v} value={v}>
                    {formatLevel(v)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        <p className="mt-1.5 text-sm text-muted">{hasRange(range) ? t("level.rangeHelp", { range: rangeText(t, range) }) : t("level.anyHelp")}</p>
        {hasRange(range) && !hasLevel && (
          <div className="mt-3 rounded-2xl bg-bg p-3">
            <label className="label">{t("level.yourLevel")}</label>
            <LevelSelect value={values.myLevel} onChange={(v) => onChange({ myLevel: v })} />
            <LevelGuide className="mt-2" />
          </div>
        )}
      </div>

      {moreOpen ? (
        <>
          <div>
            <label className="label">
              {t("create.titleLabel")} <span className="font-normal">({t("common.optional")})</span>
            </label>
            <input className="input" value={values.title} maxLength={80} placeholder={t("create.titlePlaceholder")} onChange={(e) => onChange({ title: e.target.value })} />
          </div>
          <div>
            <label className="label">
              {t("create.note")} <span className="font-normal">({t("common.optional")})</span>
            </label>
            <textarea className="textarea" value={values.note} maxLength={500} placeholder={t("create.notePlaceholder")} onChange={(e) => onChange({ note: e.target.value })} />
          </div>
        </>
      ) : (
        <button type="button" className="self-start text-sm link" onClick={() => setMoreOpen(true)}>
          + {t("create.titleLabel")} / {t("create.note")}
        </button>
      )}
    </div>
  );
}
