"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { claimSpotAction } from "@/actions/competitions";
import { useOwnNameAutofill } from "@/components/PasskeyAutofill";

/** The partner's side of the link: whose spot it is, one button, a name when they have none yet. */
export function ClaimCard({ slug, token, p1Name, categoryName, hasIdentity, own }: { slug: string; token: string; p1Name: string; categoryName: string; hasIdentity: boolean; own: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ category: string; p1: string; pairId: string } | null>(null);
  // The passkey above the keyboard (the owner, 28 October 2026): the partner types their OWN name here.
  const ownName = useOwnNameAutofill();
  if (own) {
    return (
      <section className="card" data-testid="claim-card">
        <p className="font-bold">{t("tournament.claimOwn")}</p>
      </section>
    );
  }
  if (done) {
    return (
      <section className="card" data-testid="claim-card">
        <p className="font-bold text-ok">{t("tournament.claimed", { category: done.category, p1: done.p1 })}</p>
      </section>
    );
  }
  return (
    <section className="card" data-testid="claim-card">
      <h2 className="text-lg font-extrabold">{t("tournament.claimTitle", { p1: p1Name, category: categoryName })}</h2>
      <p className="mt-1 text-sm text-muted">{t("tournament.claimHelp")}</p>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          // A typed name and the claim, as before: the passkey's request waiting in the field ends first.
          ownName.stop();
          setError(null);
          start(async () => {
            const r = await claimSpotAction(slug, token, hasIdentity ? undefined : name);
            if (r.ok) {
              setDone(r.data);
              // The server keeps the confirmation on the page; a refresh here would replace this card with "link used".
              router.replace(`/t/${slug}?claimed=${r.data.pairId}`);
            } else setError(r.error === "not_found" ? t("tournament.claimGone") : r.error === "invalid" && r.detail === "own_pair" ? t("tournament.claimOwn") : r.error === "already_in" ? t("tournament.errAlreadyIn", { who: t("tournament.you") }) : r.error === "name_required" ? t("identity.nameRequired") : t("common.somethingWrong"));
          });
        }}
      >
        {!hasIdentity && (
          <label className="block">
            <span className="text-sm font-bold">{t("tournament.yourName")}</span>
            <input className="input mt-1" value={name} maxLength={40} required onChange={(e) => setName(e.target.value)} onFocus={ownName.onFocus} autoComplete={ownName.autoComplete} data-testid="claim-own-name" />
          </label>
        )}
        {!hasIdentity && ownName.note}
        {error && <p className="text-sm font-semibold text-warn">{error}</p>}
        <button type="submit" className="btn-primary" disabled={pending}>
          {t("tournament.claimButton")}
        </button>
      </form>
    </section>
  );
}
