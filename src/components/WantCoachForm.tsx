"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { wantCoachAction } from "@/actions/coach";
import { LevelSelect } from "@/components/LevelSelect";

/**
 * "I want a coach in {city}": a level and a few words on when. The first coach who lists here
 * hears about it, and the person hears about them. On a list with coaches it is the quieter door
 * under them; on an empty list it is the only thing to do, which is the point.
 */
export function WantCoachForm({ citySlug, cityName, hasIdentity, reachable, waiting }: { citySlug: string; cityName: string; hasIdentity: boolean; /** The person has an email or Telegram on file, so the notice has somewhere to go. */ reachable: boolean; waiting: number }) {
  const t = useTranslations("coaches");
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [level, setLevel] = useState<number | null>(null);
  const [when, setWhen] = useState("");
  const [done, setDone] = useState<{ waiting: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await wantCoachAction({ city: citySlug, level, when, name: hasIdentity ? undefined : name });
      if (r.ok) setDone(r.data);
      else setError(t("wantFailed"));
    });
  };
  if (done) {
    return (
      <section className="card" data-testid="want-coach-done">
        <p className="font-bold">✓ {t("wantDone", { city: cityName })}</p>
        {done.waiting > 0 && <p className="mt-1 text-sm text-muted">{t("wantWaiting", { count: done.waiting })}</p>}
        {!reachable && (
          <p className="mt-2 text-sm text-muted">
            {t("wantReach")}{" "}
            <Link href="/me" prefetch={false} className="link">
              {t("wantReachLink")}
            </Link>
          </p>
        )}
      </section>
    );
  }
  return (
    <form className="card flex flex-col gap-3" onSubmit={submit} data-testid="want-coach">
      <div>
        <p className="font-bold">{t("wantTitle", { city: cityName })}</p>
        <p className="mt-1 text-xs text-muted">{t("wantHelp")}</p>
        {waiting > 0 && <p className="mt-1 text-xs text-muted">{t("wantWaiting", { count: waiting })}</p>}
      </div>
      {!hasIdentity && (
        <label className="block">
          <span className="text-sm font-bold">{t("wantName")}</span>
          <input className="input mt-1" value={name} maxLength={60} required autoComplete="given-name" onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className="block text-sm font-bold">{t("wantLevel")}</span>
          <LevelSelect value={level} onChange={setLevel} className="mt-1" ariaLabel={t("wantLevel")} />
        </div>
        <label className="block">
          <span className="text-sm font-bold">{t("wantWhen")}</span>
          <input className="input mt-1" value={when} maxLength={80} placeholder={t("wantWhenPlaceholder")} onChange={(e) => setWhen(e.target.value)} />
        </label>
      </div>
      {error && <p className="text-sm font-bold text-warn">{error}</p>}
      <button type="submit" className="btn-secondary w-full" disabled={pending} data-testid="want-coach-send">
        {pending ? t("wantSending") : t("wantCta")}
      </button>
    </form>
  );
}
