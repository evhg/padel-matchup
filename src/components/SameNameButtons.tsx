"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { claimSameNameAction } from "@/actions/identity";

/**
 * "These are mine" folds the row in (checked again on the server). "Not me" is remembered in this
 * browser only: nothing is written about a row somebody said is a stranger's.
 */
export function SameNameButtons({ rowId, notMine }: { rowId: string; notMine: string[] }) {
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
      <button type="button" className="btn-primary btn-sm" disabled={pending} onClick={claim} data-testid="same-name-mine">
        {pending ? "…" : t("sameMine")}
      </button>
      <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={dismiss} data-testid="same-name-not-me">
        {t("sameNotMe")}
      </button>
      {error && <p className="w-full text-xs font-semibold text-danger">{t("sameFailed")}</p>}
    </div>
  );
}
