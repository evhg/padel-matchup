"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setRankingOptInAction } from "@/actions/identity";

/**
 * On a ranking page: a player is on the boards by default (the owner, 23 November 2026), leaves with one
 * tap ("Remove me from rankings") and comes back with one ("Show me in rankings").
 */
export function RankingOptIn({ optedIn }: { optedIn: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const [on, setOn] = useState(optedIn);
  const [pending, start] = useTransition();
  const set = (next: boolean) =>
    start(async () => {
      const r = await setRankingOptInAction(next);
      if (r.ok) {
        setOn(next);
        router.refresh();
      }
    });
  if (on)
    return (
      <p className="mt-3 text-xs text-faint">
        ✓ {t("ranking.optedIn")} ·{" "}
        <button type="button" className="link" disabled={pending} onClick={() => set(false)}>
          {pending ? t("common.working") : t("ranking.removeCta")}
        </button>
      </p>
    );
  return (
    <div className="mt-4 rounded-2xl bg-bg p-3">
      <p className="text-sm text-muted">{t("ranking.optInHelp")}</p>
      <button
        type="button"
        className="btn-secondary btn-sm mt-2"
        disabled={pending}
        onClick={() => set(true)}
      >
        {pending ? t("common.working") : t("ranking.optInCta")}
      </button>
    </div>
  );
}
