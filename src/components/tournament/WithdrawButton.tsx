"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { withdrawPairAction } from "@/actions/competitions";

/** Takes a pair out, with one question first; the spot goes to the first pair waiting. */
export function WithdrawButton({ slug, pairId }: { slug: string; pairId: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="btn-ghost btn-sm shrink-0"
      disabled={pending}
      onClick={() => {
        if (!confirm(t("tournament.withdrawConfirm"))) return;
        start(async () => {
          await withdrawPairAction(slug, pairId);
          router.refresh();
        });
      }}
    >
      {t("tournament.withdraw")}
    </button>
  );
}
