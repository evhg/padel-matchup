"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { claimSameNameAction } from "@/actions/identity";

/**
 * "These are mine" folds the row in (checked again on the server). "Not me" is remembered in this
 * browser only: nothing is written about a row somebody said is a stranger's. A row the person may
 * not claim (`mayClaim`: a member of a group that asks to join, or a row that runs a crew, with no match
 * the two sat in together) gets one line in place of the claim button, never a button the server would
 * refuse. The line says that a name alone cannot add the matches, and never how to pass the guard.
 */
export function SameNameButtons({ rowId, notMine, blocked = null }: { rowId: string; notMine: string[]; blocked?: "asking_group" | "runs_crew" | null }) {
  const t = useTranslations("me");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState(false);
  const claim = () =>
    start(async () => {
      setError(false);
      const r = await claimSameNameAction(rowId);
      if (!r.ok) {
        setError(true);
        return;
      }
      router.refresh();
    });
  const dismiss = () => {
    const ids = [...new Set([...notMine, rowId])].slice(-20).join(",");
    document.cookie = `ks_notmine=${ids}; path=/me; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    router.refresh();
  };
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {blocked === null ? (
        <button type="button" className="btn-primary btn-sm" disabled={pending} onClick={claim} data-testid="same-name-mine">
          {pending ? "…" : t("sameMine")}
        </button>
      ) : (
        <p className="w-full text-xs text-muted" data-testid={blocked === "runs_crew" ? "same-name-runs-crew" : "same-name-asking-group"}>
          {blocked === "runs_crew" ? t("sameRunsCrew") : t("sameNameOnly")}
        </p>
      )}
      <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={dismiss} data-testid="same-name-not-me">
        {t("sameNotMe")}
      </button>
      {error && <p className="w-full text-xs font-semibold text-danger">{t("sameFailed")}</p>}
    </div>
  );
}
