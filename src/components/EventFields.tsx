"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
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
};

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
  const [tzOpen, setTzOpen] = useState(false);
  const zones = useMemo(() => timeZones(values.tz), [values.tz]);
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
          {values.type === "tournament" && <p className="chip-live mt-2">{t("create.roundScoringSoon")}</p>}
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

      {values.type === "tournament" && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">{t("create.capacity")}</label>
            <input className="input" type="number" inputMode="numeric" min={2} max={64} value={values.capacity} onChange={(e) => onChange({ capacity: Number(e.target.value) })} />
          </div>
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
