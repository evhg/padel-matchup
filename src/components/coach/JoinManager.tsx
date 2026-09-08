"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { claimManagerAction } from "@/actions/coach";

/** One name, one button: from then on this person runs the coach's book too. */
export function JoinManager({ code, coachName }: { code: string; coachName: string }) {
  const t = useTranslations("coach");
  const tRoot = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card flex flex-col gap-3">
      <h1 className="text-2xl font-extrabold tracking-tight">{t("managers.joinTitle")}</h1>
      <p className="text-sm text-muted">{t("managers.joinLead", { name: coachName })}</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start(async () => {
            const r = await claimManagerAction(code, name);
            if (!r.ok) {
              setError(t("managers.joinGone"));
              return;
            }
            router.push("/coach");
          });
        }}
      >
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tRoot("identity.namePlaceholder")} maxLength={40} autoComplete="given-name" autoFocus />
        <button type="submit" className="btn-primary w-full" disabled={pending || !name.trim()}>
          {pending ? "…" : t("managers.joinButton", { name: coachName })}
        </button>
      </form>
      {error && <p className="text-sm font-semibold text-danger">{error}</p>}
    </section>
  );
}
