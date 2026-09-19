"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createCompetitionAction, updateCompetitionAction } from "@/actions/competitions";

export type CityOption = { slug: string; name: string; tz: string };
export type CompetitionValues = { name: string; startsOn: string; endsOn: string; venueName: string; city: string; entryNote: string };

/**
 * The competition's details: on /t/new it creates and opens the manage screen; on the manage
 * screen it saves in place. The city sets the time zone; without one, the browser's.
 */
export function CompetitionForm({ hasIdentity, cities, listed = [], initial, slug }: { hasIdentity: boolean; cities: CityOption[]; listed?: string[]; initial?: CompetitionValues; slug?: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [organizerName, setOrganizerName] = useState("");
  const [v, setV] = useState<CompetitionValues>(initial ?? { name: "", startsOn: "", endsOn: "", venueName: "", city: "", entryNote: "" });
  const set = (patch: Partial<CompetitionValues>) => setV((s) => ({ ...s, ...patch }));
  const typed = v.venueName.trim().toLowerCase();
  const suggestions = typed.length < 1 || listed.some((n) => n.toLowerCase() === typed) ? [] : listed.filter((n) => n.toLowerCase().includes(typed)).slice(0, 6);
  const tzOf = () => cities.find((c) => c.slug === v.city)?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    start(async () => {
      const fields = { name: v.name, startsOn: v.startsOn, endsOn: v.endsOn || v.startsOn, venueName: v.venueName || null, city: v.city || null, entryNote: v.entryNote || null, tz: tzOf() };
      const r = slug ? await updateCompetitionAction(slug, fields) : await createCompetitionAction({ ...fields, organizerName: hasIdentity ? undefined : organizerName });
      if (!r) return; // the create redirected
      if (r.ok) {
        setSaved(true);
        router.refresh();
      } else setError(r.error === "name_required" ? t("identity.nameRequired") : r.error === "too_many" ? t("tournament.tooManyCompetitions") : r.error === "invalid" ? t("errors.invalid") : t("common.somethingWrong"));
    });
  };

  return (
    <form onSubmit={submit} className="card flex flex-col gap-4" data-testid="competition-form">
      {!hasIdentity && !slug && (
        <label className="block">
          <span className="text-sm font-bold">{t("tournament.yourName")}</span>
          <input className="input mt-1" value={organizerName} maxLength={60} required onChange={(e) => setOrganizerName(e.target.value)} autoComplete="given-name" />
        </label>
      )}
      <div>
        <label className="block">
          <span className="text-sm font-bold">{t("tournament.name")}</span>
          <input className="input mt-1" value={v.name} maxLength={80} minLength={2} required onChange={(e) => set({ name: e.target.value })} />
        </label>
        <span className="mt-1 block text-xs text-muted">{t("tournament.nameHelp")}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-bold">{t("tournament.startsOn")}</span>
          <input className="input mt-1" type="date" value={v.startsOn} required onChange={(e) => set({ startsOn: e.target.value, endsOn: v.endsOn && v.endsOn >= e.target.value ? v.endsOn : e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm font-bold">{t("tournament.endsOn")}</span>
          <input className="input mt-1" type="date" value={v.endsOn} min={v.startsOn || undefined} onChange={(e) => set({ endsOn: e.target.value })} />
        </label>
      </div>
      <label className="block">
        <span className="text-sm font-bold">{t("tournament.venue")}</span>
        <input className="input mt-1" value={v.venueName} maxLength={80} autoComplete="off" onChange={(e) => set({ venueName: e.target.value })} />
        {suggestions.length > 0 && (
          <ul className="mt-1 overflow-hidden rounded-2xl border border-line">
            {suggestions.map((n) => (
              <li key={n}>
                <button type="button" className="w-full px-4 py-2 text-left font-semibold hover:bg-bg" onClick={() => set({ venueName: n })}>
                  {n}
                </button>
              </li>
            ))}
          </ul>
        )}
      </label>
      <label className="block">
        <span className="text-sm font-bold">{t("tournament.city")}</span>
        <select className="input mt-1" value={v.city} onChange={(e) => set({ city: e.target.value })}>
          <option value="">{t("tournament.cityOther")}</option>
          {cities.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <div>
        <label className="block">
          <span className="text-sm font-bold">{t("tournament.note")}</span>
          <textarea className="input mt-1 min-h-20" value={v.entryNote} maxLength={400} rows={3} onChange={(e) => set({ entryNote: e.target.value })} />
        </label>
        <span className="mt-1 block text-xs text-muted">{t("tournament.noteHelp")}</span>
      </div>
      {error && <p className="text-sm font-semibold text-warn">{error}</p>}
      {saved && <p className="text-sm font-semibold text-ok">{t("tournament.saved")}</p>}
      <button type="submit" className="btn-primary" disabled={pending}>
        {slug ? t("common.save") : t("tournament.create")}
      </button>
    </form>
  );
}
