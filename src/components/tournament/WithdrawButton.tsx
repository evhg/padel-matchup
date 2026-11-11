"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { withdrawPairAction } from "@/actions/competitions";

/**
 * Takes a pair out, with one question first. The question says what happens to the spot: it goes to
 * the first pair waiting, or, with nobody waiting, it stays empty. A refusal is said on the screen.
 */
export function WithdrawButton({ slug, pairId, spotGoesOn }: { slug: string; pairId: string; /** An entered pair, and a pair waiting in its category. */ spotGoesOn: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        className="btn-ghost btn-sm shrink-0"
        disabled={pending}
        onClick={() => {
          if (!confirm(t(spotGoesOn ? "tournament.withdrawConfirm" : "tournament.withdrawConfirmEmpty"))) return;
          setError(null);
          start(async () => {
            const r = await withdrawPairAction(slug, pairId);
            if (!r.ok) setError(r.error === "closed" ? t("tournament.withdrawClosed") : t("common.somethingWrong"));
            router.refresh();
          });
        }}
      >
        {t("tournament.withdraw")}
      </button>
      {error && (
        <span className="text-xs font-semibold text-danger" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
