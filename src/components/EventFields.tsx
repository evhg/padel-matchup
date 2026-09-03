"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { POINTS_PRESETS } from "@/lib/domain/americano";
import { wallClock } from "@/lib/dates";
import { VenueCombobox, type VenueOption } from "./VenueCombobox";

export type EventFormValues = {
  type: "match" | "tournament";
  title: string;
  date: string;
  time: string;
  tz: string;
  venueName: string;
  venueMapUrl: string;
  note: string;
  capacity: number;
  whenFull: "waitlist" | "closed";
  courts: number | null;
  pointsPerMatch: number | null;
};

type Chip = { key: string; date: string; time: string; label: string };

/** Quick picks: tonight 19:00 (if still ahead), tomorrow 18:00, next Sat/Sun 10:00. */
function quickChips(tz: string, locale: string, t: (k: "create.chipTonight" | "create.chipTomorrow" | "create.chipDay", v: Record<string, string>) => string, now = new Date()): Chip[] {
  const w = wallClock(now, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  const dayAt = (offset: number) => {
    const d = new Date(Date.UTC(w.year, w.month - 1, w.day + offset));
    return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, dow: d.getUTCDay(), d };
  };
  const fmtDay = (d: Date) => new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(d);
  const chips: Chip[] = [];
  if (w.hour < 18) chips.push({ key: "tonight", ...dayAt(0), time: "19:00", label: t("create.chipTonight", { time: "19:00" }) });
  chips.push({ key: "tomorrow", ...dayAt(1), time: "18:00", label: t("create.chipTomorrow", { time: "18:00" }) });
  for (const dow of [6, 0]) {
    let off = (dow - w.day + 7) % 7;
    if (off === 0) off = 7;
    if (off === 1) continue; // already covered by "tomorrow"
    const x = dayAt(off);
    chips.push({ key: `dow${dow}`, date: x.date, time: "10:00", label: t("create.chipDay", { day: fmtDay(x.d), time: "10:00" }) });
  }
  return chips;
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
}: {
  values: EventFormValues;
  onChange: (patch: Partial<EventFormValues>) => void;
  venues: VenueOption[];
  showType?: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [tzOpen, setTzOpen] = useState(false);
  const zones = useMemo(() => timeZones(values.tz), [values.tz]);
  const chips = useMemo(() => quickChips(values.tz, locale, t as never), [values.tz, locale, t]);
  const [moreOpen, setMoreOpen] = useState(Boolean(values.title || values.note));

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

      {values.type === "tournament" && (
        <div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">{t("create.capacity")}</label>
              <input className="input px-3" type="number" inputMode="numeric" min={4} max={64} value={values.capacity} onChange={(e) => onChange({ capacity: Number(e.target.value) })} />
            </div>
            <div>
              <label className="label">{t("create.courts")}</label>
              <select className="input px-3" value={values.courts ?? ""} onChange={(e) => onChange({ courts: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{t("create.courtsAuto")}</option>
                {Array.from({ length: Math.max(1, Math.floor((values.capacity || 4) / 4)) }, (_, i) => i + 1).map((n) => (
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
          <p className="mt-1.5 text-sm text-muted">{t("create.tournamentHelp")}</p>
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
