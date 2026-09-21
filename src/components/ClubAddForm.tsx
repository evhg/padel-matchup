"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState, useTransition } from "react";
import { addClubAction } from "@/actions/clubs";
import { COUNTRIES, countryName, countryOfTz } from "@/lib/domain/countries";

/**
 * Anybody lists a club. Short on purpose: a name, where it is, and the two court counts.
 *
 * This is not the claim form. Claiming a page asks who you are at the club and checks a work
 * address, because a claim hands somebody the club's own voice. Listing hands them nothing, so it
 * asks only for what a player standing at the courts can answer.
 */
export function ClubAddForm({ hasIdentity, initialName = "" }: { hasIdentity: boolean; initialName?: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [v, setV] = useState({ name: "", clubName: initialName, place: "", country: "", indoor: "", outdoor: "", mapUrl: "", website: "" });
  const set = (p: Partial<typeof v>) => setV((s) => ({ ...s, ...p }));

  // The browser's zone guesses the country once; the person corrects it if it is wrong.
  useEffect(() => {
    const c = countryOfTz(Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (c) setV((s) => (s.country ? s : { ...s, country: c }));
  }, []);
  const countries = useMemo(() => COUNTRIES.map((code) => ({ code, name: countryName(code, locale) })).sort((a, b) => a.name.localeCompare(b.name, locale)), [locale]);

  const indoor = Number(v.indoor || 0);
  const outdoor = Number(v.outdoor || 0);
  const total = indoor + outdoor;
  const ready = v.clubName.trim().length >= 2 && v.place.trim().length >= 2 && v.country !== "" && total >= 1 && (hasIdentity || v.name.trim().length >= 1);

  const submit = () =>
    start(async () => {
      setError(null);
      const r = await addClubAction({
        name: hasIdentity ? undefined : v.name.trim(),
        clubName: v.clubName.trim(),
        place: v.place.trim(),
        country: v.country,
        courtsIndoor: indoor,
        courtsOutdoor: outdoor,
        mapUrl: v.mapUrl.trim() || undefined,
        website: v.website.trim() || undefined,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (r.ok) {
        router.push(`/v/${r.data.slug}?added=1`);
        return;
      }
      setError(r.error === "forbidden" ? t("club.addTaken") : r.error === "too_many" ? t("club.addLimit") : r.error === "name_required" ? t("identity.nameRequired") : r.error === "invalid" ? t("club.nameInvalid") : t("common.somethingWrong"));
    });

  return (
    <form
      className="card flex flex-col gap-4"
      data-testid="club-add-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !pending) submit();
      }}
    >
      {!hasIdentity && (
        <label className="block">
          <span className="text-sm font-bold">{t("identity.yourName")}</span>
          <input className="input mt-1" value={v.name} maxLength={60} required autoComplete="given-name" onChange={(e) => set({ name: e.target.value })} />
        </label>
      )}
      <label className="block">
        <span className="text-sm font-bold">{t("club.clubName")}</span>
        <input className="input mt-1" value={v.clubName} maxLength={80} required data-testid="add-club-name" onChange={(e) => set({ clubName: e.target.value })} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-bold">{t("club.city")}</span>
          <input className="input mt-1" value={v.place} maxLength={60} required placeholder={t("club.placePlaceholder")} autoComplete="address-level2" onChange={(e) => set({ place: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm font-bold">{t("club.country")}</span>
          <select className="input mt-1" value={v.country} required onChange={(e) => set({ country: e.target.value })}>
            <option value="">—</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {/* The court split is what the listing is worth: no public source says which courts have a roof. */}
      <div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-bold">{t("club.courtsIndoor")}</span>
            <input className="input mt-1" type="number" inputMode="numeric" min={0} max={64} value={v.indoor} data-testid="add-indoor" onChange={(e) => set({ indoor: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-sm font-bold">{t("club.courtsOutdoor")}</span>
            <input className="input mt-1" type="number" inputMode="numeric" min={0} max={64} value={v.outdoor} data-testid="add-outdoor" onChange={(e) => set({ outdoor: e.target.value })} />
          </label>
        </div>
        <p className="mt-1 text-xs text-muted">{total > 0 ? t("club.courtsCount", { count: total }) : t("club.courtsSplitHelp")}</p>
      </div>
      <label className="block">
        <span className="text-sm font-bold">{t("club.mapUrl")}</span>
        <input className="input mt-1" type="url" inputMode="url" placeholder="https://maps…" value={v.mapUrl} maxLength={500} onChange={(e) => set({ mapUrl: e.target.value })} />
      </label>
      <label className="block">
        <span className="text-sm font-bold">{t("club.website")}</span>
        <input className="input mt-1" type="url" inputMode="url" placeholder="https://" value={v.website} maxLength={500} onChange={(e) => set({ website: e.target.value })} />
      </label>
      {error && <p className="text-sm font-semibold text-danger">{error}</p>}
      <button type="submit" className="btn-primary" disabled={!ready || pending} data-testid="add-submit">
        {pending ? t("common.saving") : t("club.addCta")}
      </button>
    </form>
  );
}
