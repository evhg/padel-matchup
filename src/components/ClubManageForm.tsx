"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { refreshClubAction, updateClubAction } from "@/actions/clubs";
import { COUNTRIES, countryName } from "@/lib/domain/countries";

export type ClubFormValues = { website: string; bookingUrl: string; mapUrl: string; courts: string; courtsIndoor: string; courtsOutdoor: string; about: string; place: string; country: string; opensAt: string; closesAt: string; availabilityUrl: string; availabilityKind: string };

/** Everything a club can change, one screen; the feed section folds because most clubs skip it. */
export function ClubManageForm({ token, initial }: { token: string; initial: ClubFormValues }) {
  const t = useTranslations();
  const locale = useLocale();
  const countries = useMemo(() => COUNTRIES.map((code) => ({ code, name: countryName(code, locale) })).sort((a, b) => a.name.localeCompare(b.name, locale)), [locale]);
  const [pending, start] = useTransition();
  const [v, setV] = useState(initial);
  const [note, setNote] = useState<string | null>(null);
  const [feedOpen, setFeedOpen] = useState(Boolean(initial.availabilityUrl));
  // "Share it" under the free courts on the same page lands here with #feed: the section opens itself.
  useEffect(() => {
    if (window.location.hash === "#feed") setFeedOpen(true);
  }, []);
  const set = (patch: Partial<ClubFormValues>) => setV((s) => ({ ...s, ...patch }));

  const feedNote = (r: { slots: number | null; feedError: string | null }) => (r.feedError ? `${t("club.freeError")} (${r.feedError})` : r.slots != null ? t("club.freeHours", { count: r.slots }) : null);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    setNote(null);
    start(async () => {
      const r = await updateClubAction(token, {
        website: v.website || undefined,
        bookingUrl: v.bookingUrl || undefined,
        mapUrl: v.mapUrl || undefined,
        courts: v.courts ? Number(v.courts) : null,
        courtsIndoor: v.courtsIndoor === "" ? null : Number(v.courtsIndoor),
        courtsOutdoor: v.courtsOutdoor === "" ? null : Number(v.courtsOutdoor),
        about: v.about || undefined,
        place: v.place || undefined,
        country: v.country || undefined,
        opensAt: v.opensAt || undefined,
        closesAt: v.closesAt || undefined,
        availabilityUrl: feedOpen ? v.availabilityUrl || undefined : undefined,
        availabilityKind: feedOpen ? v.availabilityKind || undefined : undefined,
      });
      setNote(r.ok ? [t("club.saved"), feedNote(r.data)].filter(Boolean).join(" · ") : t("common.somethingWrong"));
    });
  };
  const refresh = () =>
    start(async () => {
      const r = await refreshClubAction(token);
      setNote(r.ok ? (feedNote(r.data) ?? t("club.saved")) : t("common.somethingWrong"));
    });

  return (
    <form onSubmit={save} className="card flex flex-col gap-4">
      <label className="block">
        <span className="text-sm font-bold">{t("club.bookingUrl")}</span>
        <input className="input mt-1" type="url" inputMode="url" placeholder="https://" value={v.bookingUrl} maxLength={500} onChange={(e) => set({ bookingUrl: e.target.value })} />
        <span className="mt-1 block text-xs text-muted">{t("club.bookingUrlHelp")}</span>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-bold">{t("club.website")}</span>
          <input className="input mt-1" type="url" inputMode="url" placeholder="https://" value={v.website} maxLength={500} onChange={(e) => set({ website: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm font-bold">{t("club.mapUrl")}</span>
          <input className="input mt-1" type="url" inputMode="url" placeholder="https://maps…" value={v.mapUrl} maxLength={500} onChange={(e) => set({ mapUrl: e.target.value })} />
        </label>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <label className="block">
          <span className="text-sm font-bold">{t("club.courts")}</span>
          <input className="input mt-1" type="number" inputMode="numeric" min={1} max={64} value={v.courts} onChange={(e) => set({ courts: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm font-bold">{t("club.courtsIndoor")}</span>
          <input className="input mt-1" type="number" inputMode="numeric" min={0} max={64} value={v.courtsIndoor} onChange={(e) => set({ courtsIndoor: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm font-bold">{t("club.courtsOutdoor")}</span>
          <input className="input mt-1" type="number" inputMode="numeric" min={0} max={64} value={v.courtsOutdoor} onChange={(e) => set({ courtsOutdoor: e.target.value })} />
        </label>
      </div>
      <span className="-mt-3 block text-xs text-muted">{t("club.courtsSplitHelp")}</span>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-bold">{t("club.opensAt")}</span>
          <input className="input mt-1" type="time" value={v.opensAt} onChange={(e) => set({ opensAt: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm font-bold">{t("club.closesAt")}</span>
          <input className="input mt-1" type="time" value={v.closesAt} onChange={(e) => set({ closesAt: e.target.value })} />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-bold">{t("club.city")}</span>
          <input className="input mt-1" value={v.place} maxLength={60} placeholder={t("club.placePlaceholder")} autoComplete="address-level2" onChange={(e) => set({ place: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm font-bold">{t("club.country")}</span>
          <select className="input mt-1" value={v.country} onChange={(e) => set({ country: e.target.value })}>
            <option value="">—</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block">
        <span className="text-sm font-bold">{t("club.about")}</span>
        <textarea className="input mt-1 min-h-20" value={v.about} maxLength={400} onChange={(e) => set({ about: e.target.value })} />
      </label>

      <div className="rounded-2xl border border-line" id="feed">
        <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left" onClick={() => setFeedOpen((o) => !o)} aria-expanded={feedOpen}>
          <span className="text-sm font-bold">{t("club.feed")}</span>
          <span className="text-faint">{feedOpen ? "−" : "+"}</span>
        </button>
        {feedOpen && (
          <div className="flex flex-col gap-3 border-t border-line px-4 py-3">
            <p className="text-xs text-muted">{t("club.feedHelp")}</p>
            <label className="block">
              <span className="text-sm font-bold">{t("club.feedKind")}</span>
              <select className="input mt-1" value={v.availabilityKind} onChange={(e) => set({ availabilityKind: e.target.value })}>
                <option value="ics_bookings">{t("club.feedIcs")}</option>
                <option value="json_free">{t("club.feedJson")}</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-bold">URL</span>
              <input className="input mt-1" type="url" inputMode="url" placeholder="https://…/bookings.ics" value={v.availabilityUrl} maxLength={500} onChange={(e) => set({ availabilityUrl: e.target.value })} />
            </label>
            {initial.availabilityUrl && (
              <button type="button" className="btn-ghost btn-sm self-start" onClick={refresh} disabled={pending}>
                ↻ {t("club.refresh")}
              </button>
            )}
          </div>
        )}
      </div>

      {note && <p className="text-sm font-bold">{note}</p>}
      <button type="submit" className="btn-primary w-full" disabled={pending}>
        {pending ? t("common.saving") : t("common.save")}
      </button>
    </form>
  );
}
