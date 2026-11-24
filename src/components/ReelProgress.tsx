"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReelStep } from "@/lib/domain/matchReel";

/**
 * The reel while its maker works on it (the owner, 24 November 2026: "Show the minutes remaining estimate
 * and progress bar instead"): the share done, the minutes left from the maker's own estimate, and what it
 * does now. The page asks again every 30 seconds, so the bar moves and the reel appears when it is ready.
 */
export function ReelProgress({ pct, readyBy, step, waitingNames = false }: { pct: number; readyBy: string; step: ReelStep | null; /** The maker waits for a player to say who is who. */ waitingNames?: boolean }) {
  const t = useTranslations("reel");
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    const again = setInterval(() => router.refresh(), 30_000);
    return () => {
      clearInterval(tick);
      clearInterval(again);
    };
  }, [router]);
  const minutes = Math.ceil((new Date(readyBy).getTime() - now) / 60_000);
  return (
    <section className="card" data-testid="reel-working">
      <h2 className="text-lg font-extrabold">{t("workingTitle")}</h2>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-fill" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="h-full rounded-full bg-accent-deep transition-[width] duration-700" style={{ width: `${Math.max(3, pct)}%` }} />
      </div>
      <p className="mt-2 text-sm font-semibold" data-testid="reel-working-left">
        {waitingNames ? t("namesWaiting") : minutes > 1 ? t("workingLeft", { min: minutes }) : t("workingAlmost")}
      </p>
      {step && <p className="mt-0.5 text-sm text-muted">{t(`step.${step}`)}</p>}
      <p className="mt-2 text-xs text-faint">{t("workingBody")}</p>
    </section>
  );
}
