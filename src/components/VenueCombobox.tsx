"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";

export type VenueOption = { name: string; mapUrl: string | null; where?: "yours" | "here" | "elsewhere"; country?: string | null; province?: string | null };

/** Before a letter is typed the list is a glance, not a directory; typing one opens it up. */
const SHOWN_AT_REST = 6;
const SHOWN_WHEN_SEARCHING = 24;

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
  const locale = useLocale();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [showMap, setShowMap] = useState(Boolean(mapUrl));
  // The list arrives in the order a person reads it — the courts they use, then the clubs where they
  // are, then everywhere else by country and province — so the headings come from walking it once.
  const rows = useMemo(() => {
    const q = value.trim().toLowerCase();
    const shown = venues.filter((v) => !q || v.name.toLowerCase().includes(q)).slice(0, q ? SHOWN_WHEN_SEARCHING : SHOWN_AT_REST);
    const region = (code: string | null | undefined) => {
      if (!code) return null;
      try {
        return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
      } catch {
        return code;
      }
    };
    let last = "";
    return shown.map((v) => {
      // A place with no country and no province still needs a heading of its own, or it reads as if it
      // were in whatever province the row above it is in.
      const head = v.where === "yours" ? t("create.venueYours") : [region(v.country), v.province].filter(Boolean).join(" · ") || t("create.venueOther");
      const heading = head && head !== last ? head : null;
      if (head) last = head;
      return { venue: v, heading };
    });
  }, [venues, value, locale, t]);
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
      {open && (rows.length > 0 || (value.trim() && !exact)) && (
        <ul className="absolute z-20 mt-1 max-h-80 w-full overflow-y-auto overflow-x-hidden rounded-2xl border border-line bg-white shadow-card">
          {rows.map(({ venue: v, heading }) => (
            <li key={v.name}>
              {heading && <div className="bg-bg px-4 py-1 text-xs font-bold uppercase tracking-wider text-faint">{heading}</div>}
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
