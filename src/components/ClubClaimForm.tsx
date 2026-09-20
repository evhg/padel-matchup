"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { claimClubAction, type ClaimClubInput } from "@/actions/clubs";
import { ClaimCodeForm } from "@/components/ClaimCodeForm";
import { CopyButton } from "@/components/ShareSheet";
import { CLAIM_ROLES } from "@/lib/domain/claimRoles";
import { COUNTRIES, countryName, countryOfTz } from "@/lib/domain/countries";

/** A club Kicksmash already lists and nobody has claimed: the owner picks it rather than retyping it. */
export type ListedClub = { name: string; country: string | null; province: string | null };

type Step = "club" | "courts" | "links" | "you";
const STEPS: Step[] = ["club", "courts", "links", "you"];

/**
 * The claim as a walk, like the coach's: the club, then its courts and hours, then the links, then
 * who the claimant is and how the club can confirm it, with the claim itself on that last step. It
 * used to be one screen of eleven fields, which is a form, and a form is where a club owner on a
 * phone stops. Done, the screen carries what makes the page work from day one: the manage link
 * (also on My matches), the poster to print for the courts, the week to fill with the socials that
 * repeat, and, when the contact was a work email at the club's own domain, the code that confirms it.
 */
export function ClubClaimForm({ initialName, hasIdentity, base, listed = [] }: { initialName: string; hasIdentity: boolean; base: string; listed?: ListedClub[] }) {
  const t = useTranslations();
  const locale = useLocale();
  const [pending, start] = useTransition();
  const [step, setStep] = useState<Step>("club");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ slug: string; token: string; codeSentTo: string | null } | null>(null);
  const [v, setV] = useState({ name: "", clubName: initialName, website: "", bookingUrl: "", mapUrl: "", courts: "", courtsIndoor: "", courtsOutdoor: "", opensAt: "", closesAt: "", about: "", place: "", country: "", claimRole: "", claimContact: "" });
  const set = (patch: Partial<typeof v>) => setV((s) => ({ ...s, ...patch }));
  // The browser's time zone guesses the country once; the person corrects it if it is wrong.
  useEffect(() => {
    const c = countryOfTz(Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (c) setV((s) => (s.country ? s : { ...s, country: c }));
  }, []);
  const countries = useMemo(() => COUNTRIES.map((code) => ({ code, name: countryName(code, locale) })).sort((a, b) => a.name.localeCompare(b.name, locale)), [locale]);
  const index = STEPS.indexOf(step);
  const goNext = () => setStep(STEPS[Math.min(STEPS.length - 1, index + 1)]);
  const goBack = () => setStep(STEPS[Math.max(0, index - 1)]);
  // Picking the club Kicksmash already lists claims that page, with its matches and its court counts
  // on it. Typing a near-miss opens an empty second one, so the list is offered from the first letter.
  const typed = v.clubName.trim().toLowerCase();
  const suggestions = typed.length < 1 || listed.some((c) => c.name.toLowerCase() === typed) ? [] : listed.filter((c) => c.name.toLowerCase().includes(typed)).slice(0, 6);

  if (done) {
    const manage = `${base}/v/${done.slug}/manage/${done.token}`;
    return (
      <section className="card flex flex-col gap-4" data-testid="claim-done">
        <div>
          <h2 className="text-xl font-extrabold">{t("club.claimed")}</h2>
          <p className="mt-1 text-sm text-muted">{t(done.codeSentTo ? "club.claimedHelpCode" : "club.claimedHelp")}</p>
        </div>
        {done.codeSentTo && <ClaimCodeForm token={done.token} email={done.codeSentTo} />}
        <div className="rounded-2xl bg-bg px-4 py-3">
          <div className="text-xs font-bold uppercase tracking-wider text-faint">{t("club.manageLink")}</div>
          <div className="mt-1 break-all font-mono text-sm">{manage}</div>
          <div className="mt-2">
            <CopyButton value={manage} label={t("common.copy")} copiedLabel={t("common.copied")} className="btn-secondary btn-sm" />
          </div>
        </div>
        <p className="text-sm font-bold">{t("club.walkDoneNext")}</p>
        <a href={`/v/${done.slug}/poster`} className="flex items-center justify-between gap-3 rounded-2xl border border-line px-4 py-3 hover:border-ink/30" data-testid="claim-poster">
          <span>
            <span className="block font-bold">🖨 {t("club.walkPosterTitle")}</span>
            <span className="block text-xs text-muted">{t("club.walkPosterHelp", { club: v.clubName })}</span>
          </span>
          <span aria-hidden>→</span>
        </a>
        <a href={`${manage}#week`} className="flex items-center justify-between gap-3 rounded-2xl border border-line px-4 py-3 hover:border-ink/30" data-testid="claim-week">
          <span>
            <span className="block font-bold">📅 {t("club.walkWeekTitle")}</span>
            <span className="block text-xs text-muted">{t("club.walkWeekHelp")}</span>
          </span>
          <span aria-hidden>→</span>
        </a>
        <div className="flex flex-wrap gap-2">
          <a href={manage} className="btn-primary">
            {t("club.manageTitle", { club: v.clubName })}
          </a>
          <a href={`/v/${done.slug}`} className="btn-ghost">
            {t("club.openPage")}
          </a>
        </div>
      </section>
    );
  }

  const submit = () => {
    setError(null);
    start(async () => {
      const r = await claimClubAction({
        name: hasIdentity ? undefined : v.name,
        clubName: v.clubName.trim(),
        website: v.website || undefined,
        bookingUrl: v.bookingUrl || undefined,
        mapUrl: v.mapUrl || undefined,
        courts: v.courts ? Number(v.courts) : null,
        courtsIndoor: v.courtsIndoor === "" ? null : Number(v.courtsIndoor),
        courtsOutdoor: v.courtsOutdoor === "" ? null : Number(v.courtsOutdoor),
        opensAt: v.opensAt || undefined,
        closesAt: v.closesAt || undefined,
        about: v.about || undefined,
        place: v.place.trim() || undefined,
        country: v.country || undefined,
        claimRole: (v.claimRole || undefined) as ClaimClubInput["claimRole"],
        claimContact: v.claimContact.trim() || undefined,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (r.ok) setDone(r.data);
      else setError(r.error === "name_required" ? t("identity.nameRequired") : r.error === "forbidden" ? t("club.alreadyClaimed") : r.error === "invalid" ? t("club.nameInvalid") : t("common.somethingWrong"));
    });
  };

  const stepTitle = step === "club" ? t("club.walkClub") : step === "courts" ? t("club.walkCourts") : step === "links" ? t("club.walkLinks") : t("club.walkYou");
  return (
    <form
      className="card flex flex-col gap-4"
      data-testid={`claim-${step}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (step === "you") submit();
        else goNext();
      }}
    >
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-faint">{t("club.walkStep", { n: index + 1, total: STEPS.length })}</p>
        <h2 className="mt-1 text-xl font-extrabold">{stepTitle}</h2>
      </div>

      {step === "club" && (
        <>
          {!hasIdentity && (
            <label className="block">
              <span className="text-sm font-bold">{t("club.ownerName")}</span>
              <input className="input mt-1" value={v.name} maxLength={60} required onChange={(e) => set({ name: e.target.value })} autoComplete="given-name" />
            </label>
          )}
          <label className="block">
            <span className="text-sm font-bold">{t("club.clubName")}</span>
            <input className="input mt-1" value={v.clubName} maxLength={80} minLength={2} required autoComplete="off" onChange={(e) => set({ clubName: e.target.value })} />
            {suggestions.length > 0 && (
              <ul className="mt-1 overflow-hidden rounded-2xl border border-line">
                {suggestions.map((c) => (
                  <li key={c.name}>
                    <button type="button" className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left hover:bg-bg" onClick={() => set({ clubName: c.name })}>
                      <span className="font-semibold">{c.name}</span>
                      <span className="text-xs text-muted">{[c.province, c.country].filter(Boolean).join(", ")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <span className="mt-1 block text-xs text-muted">{t("club.clubNameHelp")}</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm font-bold">{t("club.city")}</span>
              <input className="input mt-1" value={v.place} maxLength={60} required placeholder={t("club.placePlaceholder")} autoComplete="address-level2" onChange={(e) => set({ place: e.target.value })} />
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
            <span className="text-sm font-bold">{t("club.mapUrl")}</span>
            <input className="input mt-1" type="url" inputMode="url" placeholder="https://maps…" value={v.mapUrl} maxLength={500} onChange={(e) => set({ mapUrl: e.target.value })} />
          </label>
        </>
      )}

      {step === "courts" && (
        <>
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
          <label className="block">
            <span className="text-sm font-bold">
              {t("club.about")} <span className="font-normal">({t("common.optional")})</span>
            </span>
            <textarea className="input mt-1 min-h-20" value={v.about} maxLength={400} onChange={(e) => set({ about: e.target.value })} />
            <span className="mt-1 block text-xs text-muted">{t("club.aboutHelp")}</span>
          </label>
        </>
      )}

      {step === "links" && (
        <>
          <label className="block">
            <span className="text-sm font-bold">{t("club.bookingUrl")}</span>
            <input className="input mt-1" type="url" inputMode="url" placeholder="https://" value={v.bookingUrl} maxLength={500} onChange={(e) => set({ bookingUrl: e.target.value })} />
            <span className="mt-1 block text-xs text-muted">{t("club.bookingUrlHelp")}</span>
          </label>
          <label className="block">
            <span className="text-sm font-bold">{t("club.website")}</span>
            <input className="input mt-1" type="url" inputMode="url" placeholder="https://" value={v.website} maxLength={500} onChange={(e) => set({ website: e.target.value })} />
          </label>
        </>
      )}

      {step === "you" && (
        <>
          <div>
            <span className="text-sm font-bold">{t("club.role")}</span>
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={t("club.role")}>
              {CLAIM_ROLES.map((r) => (
                <button key={r} type="button" aria-pressed={v.claimRole === r} onClick={() => set({ claimRole: r })} className={`min-h-10 rounded-xl px-3 text-sm font-bold transition ${v.claimRole === r ? "bg-ink text-white" : "border border-line hover:border-ink/30"}`}>
                  {t(`club.role_${r}`)}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <span className="text-sm font-bold">{t("club.contact")}</span>
            <input className="input mt-1" value={v.claimContact} maxLength={120} required placeholder={t("club.contactPlaceholder")} autoComplete="off" onChange={(e) => set({ claimContact: e.target.value })} />
            <span className="mt-1 block text-xs text-muted">{t("club.contactHelp")}</span>
          </label>
          <p className="text-xs text-muted">{t("club.attest", { club: v.clubName })}</p>
          {error && <p className="text-sm font-bold text-warn">{error}</p>}
        </>
      )}

      <div className="flex gap-2">
        {index > 0 && (
          <button type="button" className="btn-ghost" onClick={goBack}>
            {t("common.back")}
          </button>
        )}
        <button type="submit" className="btn-primary flex-1" disabled={pending || (step === "you" && !v.claimRole)}>
          {pending ? t("common.working") : step === "you" ? t("club.submit") : t("club.walkNext")}
        </button>
      </div>
    </form>
  );
}
