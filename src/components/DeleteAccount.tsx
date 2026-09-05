"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { deleteMyAccountAction } from "@/actions/identity";

/** Faint, at the very bottom of My matches. One confirm, then gone. */
export function DeleteAccount() {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <p className="mt-6 text-center text-xs text-faint">
      <button
        type="button"
        className="underline hover:text-muted"
        disabled={pending}
        onClick={() => {
          if (!confirm(t("me.deleteConfirm"))) return;
          start(async () => {
            const r = await deleteMyAccountAction();
            if (r.ok) router.push("/");
          });
        }}
      >
        {pending ? t("common.working") : t("me.deleteAccount")}
      </button>
    </p>
  );
}
