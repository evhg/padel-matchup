"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { setupCoachAction } from "@/actions/coach";
import { HowThisWorks } from "./HowThisWorks";
import type { HoursPreset } from "@/lib/domain/coaching";

/** Four taps: where, how long, when, done. The name is already known. */
export function CoachSetup({ initialClubs = "" }: { initialClubs?: string }) {
  const t = useTranslations("coach");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [clubs, setClubs] = useState(initialClubs);
  const [minutes, setMinutes] = useState<60 | 90>(60);
  const [preset, setPreset] = useState<HoursPreset | "custom">("both");
  const [error, setError] = useState<string | null>(null);

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const r = await setupCoachAction({ clubs, minutes, preset, tz });
      if (!r.ok) {
        setError(t("errors.no_coach"));
        return;
      }
      router.push("/coach?welcome=1");
      router.refresh();
    });
  };

  const chip = (active: boolean) => `rounded-full border px-4 py-2 text-sm font-bold transition ${active ? "border-ink bg-ink text-white" : "border-line bg-white text-ink hover:border-ink/40"}`;

  return (
    <form onSubmit={create} className="card flex flex-col gap-5">
      <div>
        <span className="chip-muted">🎾 {t("eyebrow")}</span>
        <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("setup.title")}</h1>
        <p className="mt-2 text-sm text-muted">{t("setup.sub")}</p>
      </div>

      <div>
        <label className="text-sm font-bold" htmlFor="coach-clubs">
          {t("setup.club")}
        </label>
        <input id="coach-clubs" className="input mt-2" value={clubs} onChange={(e) => setClubs(e.target.value)} placeholder={t("setup.clubPlaceholder")} maxLength={120} autoFocus enterKeyHint="next" />
        <p className="mt-1 text-xs text-faint">{t("setup.clubHelp")}</p>
      </div>

      <div>
        <div className="text-sm font-bold">{t("setup.length")}</div>
        <div className="mt-2 flex gap-2" role="radiogroup" aria-label={t("setup.length")}>
          {([60, 90] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={minutes === m} className={chip(minutes === m)} onClick={() => setMinutes(m)}>
              {t("minutes", { n: m })}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-sm font-bold">{t("setup.hours")}</div>
        <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label={t("setup.hours")}>
          {(["mornings", "afternoons", "both", "custom"] as const).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={preset === p} className={chip(preset === p)} onClick={() => setPreset(p)}>
              {t(`setup.${p}`)}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm font-semibold text-danger">{error}</p>}
      <button type="submit" className="btn-primary w-full" disabled={pending}>
        {pending ? "…" : t("setup.create")}
      </button>
      <HowThisWorks text={t("setup.how")} />
    </form>
  );
}
