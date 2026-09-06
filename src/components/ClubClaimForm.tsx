"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { claimClubAction } from "@/actions/clubs";
import { CopyButton } from "@/components/ShareSheet";

type City = { slug: string; name: string };

/** The claim in one screen; success shows the manage link once (it is also on My matches). */
export function ClubClaimForm({ initialName, hasIdentity, cities, base }: { initialName: string; hasIdentity: boolean; cities: City[]; base: string }) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ slug: string; token: string } | null>(null);
  const [v, setV] = useState({ name: "", clubName: initialName, website: "", bookingUrl: "", mapUrl: "", courts: "", about: "", city: "" });
  const set = (patch: Partial<typeof v>) => setV((s) => ({ ...s, ...patch }));

  if (done) {
    const manage = `${base}/v/${done.slug}/manage/${done.token}`;
    return (
      <section className="card flex flex-col gap-3">
        <h2 className="text-xl font-extrabold">{t("club.claimed")}</h2>
        <p className="text-sm text-muted">{t("club.claimedHelp")}</p>
        <div className="rounded-2xl bg-bg px-4 py-3">
          <div className="text-xs font-bold uppercase tracking-wider text-faint">{t("club.manageLink")}</div>
          <div className="mt-1 break-all font-mono text-sm">{manage}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyButton value={manage} label={t("common.copy")} copiedLabel={t("common.copied")} className="btn-primary" />
          <a href={manage} className="btn-secondary">
            {t("club.manageTitle", { club: v.clubName })}
          </a>
          <a href={`/v/${done.slug}`} className="btn-ghost">
            {t("club.openPage")}
          </a>
        </div>
      </section>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await claimClubAction({
        name: hasIdentity ? undefined : v.name,
        clubName: v.clubName.trim(),
        website: v.website || undefined,
        bookingUrl: v.bookingUrl || undefined,
        mapUrl: v.mapUrl || undefined,
        courts: v.courts ? Number(v.courts) : null,
        about: v.about || undefined,
        city: v.city || undefined,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (r.ok) setDone(r.data);
      else setError(r.error === "name_required" ? t("identity.nameRequired") : r.error === "forbidden" ? t("club.alreadyClaimed") : r.error === "invalid" ? t("club.nameInvalid") : t("common.somethingWrong"));
    });
  };

  return (
    <form onSubmit={submit} className="card flex flex-col gap-4">
      {!hasIdentity && (
        <label className="block">
          <span className="text-sm font-bold">{t("club.ownerName")}</span>
          <input className="input mt-1" value={v.name} maxLength={60} required onChange={(e) => set({ name: e.target.value })} autoComplete="given-name" />
        </label>
      )}
      <label className="block">
        <span className="text-sm font-bold">{t("club.clubName")}</span>
        <input className="input mt-1" value={v.clubName} maxLength={80} minLength={2} required onChange={(e) => set({ clubName: e.target.value })} />
        <span className="mt-1 block text-xs text-muted">{t("club.clubNameHelp")}</span>
      </label>
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
          <span className="text-sm font-bold">{t("club.courts")}</span>
          <input className="input mt-1" type="number" inputMode="numeric" min={1} max={64} value={v.courts} onChange={(e) => set({ courts: e.target.value })} />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-bold">{t("club.mapUrl")}</span>
          <input className="input mt-1" type="url" inputMode="url" placeholder="https://maps…" value={v.mapUrl} maxLength={500} onChange={(e) => set({ mapUrl: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm font-bold">{t("club.city")}</span>
          <select className="input mt-1" value={v.city} onChange={(e) => set({ city: e.target.value })}>
            <option value="">{t("club.cityOther")}</option>
            {cities.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block">
        <span className="text-sm font-bold">
          {t("club.about")} <span className="font-normal">({t("common.optional")})</span>
        </span>
        <textarea className="input mt-1 min-h-20" value={v.about} maxLength={400} onChange={(e) => set({ about: e.target.value })} />
        <span className="mt-1 block text-xs text-muted">{t("club.aboutHelp")}</span>
      </label>
      {error && <p className="text-sm font-bold text-warn">{error}</p>}
      <button type="submit" className="btn-primary w-full" disabled={pending}>
        {pending ? t("common.working") : t("club.submit")}
      </button>
    </form>
  );
}
