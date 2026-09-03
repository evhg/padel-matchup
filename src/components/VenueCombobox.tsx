"use client";

import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";

export type VenueOption = { name: string; mapUrl: string | null };

export function VenueCombobox({
  venues,
  value,
  mapUrl,
  onChange,
}: {
  venues: VenueOption[];
  value: string;
  mapUrl: string;
  onChange: (v: { name: string; mapUrl: string }) => void;
}) {
  const t = useTranslations();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [showMap, setShowMap] = useState(Boolean(mapUrl));
  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    return venues.filter((v) => !q || v.name.toLowerCase().includes(q)).slice(0, 6);
  }, [venues, value]);
  const exact = venues.some((v) => v.name.toLowerCase() === value.trim().toLowerCase());

  return (
    <div className="relative">
      <label htmlFor={id} className="label">
        {t("create.venue")} <span className="font-normal">({t("common.optional")})</span>
      </label>
      <input
        id={id}
        className="input"
        value={value}
        placeholder={t("create.venuePlaceholder")}
        autoComplete="off"
        onChange={(e) => {
          onChange({ name: e.target.value, mapUrl });
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        maxLength={80}
      />
      {open && (matches.length > 0 || (value.trim() && !exact)) && (
        <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-2xl border border-line bg-white shadow-card">
          {matches.map((v) => (
            <li key={v.name}>
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-bg"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange({ name: v.name, mapUrl: v.mapUrl ?? "" });
                  setShowMap(Boolean(v.mapUrl));
                  setOpen(false);
                }}
              >
                <span className="font-semibold">{v.name}</span>
                {v.mapUrl && <span className="text-xs text-muted">📍</span>}
              </button>
            </li>
          ))}
          {value.trim() && !exact && (
            <li>
              <button type="button" className="w-full px-4 py-3 text-left text-court font-semibold hover:bg-bg" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(false)}>
                {t("create.venueNew", { name: value.trim() })}
              </button>
            </li>
          )}
        </ul>
      )}
      {!value.trim() && <p className="mt-1 text-xs text-faint">{t("create.venueHint")}</p>}
      {showMap ? (
        <div className="mt-2">
          <label className="label">{t("create.venueMapUrl")}</label>
          <input className="input" type="url" inputMode="url" placeholder={t("create.venueMapUrlPlaceholder")} value={mapUrl} onChange={(e) => onChange({ name: value, mapUrl: e.target.value })} />
        </div>
      ) : (
        <button type="button" className="mt-2 text-sm link" onClick={() => setShowMap(true)}>
          + {t("create.addMapLink")}
        </button>
      )}
    </div>
  );
}
