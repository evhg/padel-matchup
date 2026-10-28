"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteMyAccountAction } from "@/actions/identity";

/** The doors on My matches that turn a session by name into a full one: an email code, Telegram, both, or none here. */
export type ProofDoors = "both" | "email" | "telegram" | "other";

/**
 * Faint, at the very bottom of My matches. One confirm, then gone. A session by name that proved nothing
 * (`byName`, DECIDING rule 34) gets no button: it gets why, and the doors above that prove it, because the
 * deletion would cancel the record's matches on the word of a name (the owner, 28 October 2026).
 */
export function DeleteAccount({ byName = null }: { byName?: ProofDoors | null }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [refused, setRefused] = useState(false);
  if (byName)
    return (
      <p className="mt-6 text-center text-xs text-faint" data-testid="delete-by-name">
        {t("me.deleteByName", { doors: byName })}
      </p>
    );
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
            else if (r.error === "proof_required") setRefused(true);
          });
        }}
      >
        {pending ? t("common.working") : t("me.deleteAccount")}
      </button>
      {refused && (
        <span className="mt-2 block" role="alert">
          {t("errors.proof_required")}
        </span>
      )}
    </p>
  );
}
