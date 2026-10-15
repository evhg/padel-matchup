"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import type { FreeFeed } from "@/lib/domain/bestTimes";

export type VenueOption = { name: string; mapUrl: string | null; where?: "yours" | "here" | "nearby" | "elsewhere"; country?: string | null; province?: string | null; courts?: number | null; /** The club's courts by name, when it listed them. */ courtNames?: string[]; /** The club's free courts for the week: the create form's free times. Only the create form passes it. */ free?: FreeFeed | null };

/** Before a letter is typed the list is a glance, not a directory; typing one opens it up. */
const SHOWN_AT_REST = 6;
const SHOWN_WHEN_SEARCHING = 24;

/**
 * What Go (Enter) does in the venue field while its list is open: the club typed in full, else the
 * first row (`first`), picked as a tap picks it; "close" when the list offers only "Use … as a new
 * court"; null when Go is not the field's own, so the create form moves on (`enterMovesOn`). An empty
 * field is not a pick. Nor is the club that the field already holds with its map link: a returning
 * organiser's own club is filled in, and Go there picked it again and kept the focus, so "next" took
 * two presses (review, 15 October 2026). A name in another case, or with spaces round it, is still
 * picked, because the pick writes the club's own name.
 */
export function venueGo(venues: readonly VenueOption[], first: VenueOption | undefined, value: string, mapUrl: string): VenueOption | "close" | null {
  const typed = value.trim().toLowerCase();
  if (!typed) return null;
  const exact = venues.find((v) => v.name.toLowerCase() === typed);
  if (exact && exact.name === value && (!exact.mapUrl || exact.mapUrl === mapUrl)) return null;
  return exact ?? first ?? "close";
}

export function VenueCombobox({
  venues,
  value,
  mapUrl,
  onChange,
  enterKeyHint,
}: {
  venues: VenueOption[];
  value: string;
  mapUrl: string;
  onChange: (v: { name: string; mapUrl: string }) => void;
  /** "next" on the create form, where Go moves on to the next field. */
  enterKeyHint?: "next";
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
  const listShown = open && (rows.length > 0 || Boolean(value.trim() && !exact));
  const choose = (v: VenueOption) => {
    onChange({ name: v.name, mapUrl: v.mapUrl ?? "" });
    setShowMap(Boolean(v.mapUrl));
    setOpen(false);
  };

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
        // Go (Enter) with the list open and a name typed picks the first suggestion, as a tap does
        // (`venueGo`). A pick calls preventDefault, so it sends no form, and the create form keeps the
        // field for the next Go. An empty field, or the club the field already holds, is no pick: the
        // list closes and Go moves on (`enterMovesOn`).
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing || !listShown) return;
          const pick = venueGo(venues, rows[0]?.venue, value, mapUrl);
          if (pick === null) return setOpen(false);
          e.preventDefault();
          if (pick === "close") setOpen(false);
          else choose(pick);
        }}
        enterKeyHint={enterKeyHint}
        maxLength={80}
      />
      {listShown && (
        <ul className="absolute z-20 mt-1 max-h-80 w-full overflow-y-auto overflow-x-hidden rounded-2xl border border-line bg-card shadow-card">
          {rows.map(({ venue: v, heading }) => (
            <li key={v.name}>
              {heading && <div className="bg-bg px-4 py-1 text-xs font-bold uppercase tracking-wider text-faint">{heading}</div>}
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-bg"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(v)}
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
