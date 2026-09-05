"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setRankingOptInAction } from "@/actions/identity";

/** One tap from the ranking page: appear on the boards (off by default). */
export function RankingOptIn({ optedIn }: { optedIn: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const [on, setOn] = useState(optedIn);
  const [pending, start] = useTransition();
  if (on) return <p className="mt-3 text-xs text-faint">✓ {t("ranking.optedIn")}</p>;
  return (
    <div className="mt-4 rounded-2xl bg-bg p-3">
      <p className="text-sm text-muted">{t("ranking.optInHelp")}</p>
      <button
        type="button"
        className="btn-secondary btn-sm mt-2"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await setRankingOptInAction(true);
            if (r.ok) {
              setOn(true);
              router.refresh();
            }
          })
        }
      >
        {pending ? t("common.working") : t("ranking.optInCta")}
      </button>
    </div>
  );
}
