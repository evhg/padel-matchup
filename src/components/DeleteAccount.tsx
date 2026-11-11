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
  // Why the deletion did not happen: the proof a session by name lacks, or anything else. A refusal
  // that showed nothing left the button as it was, and the person could not tell it had failed.
  const [refused, setRefused] = useState<"proof_required" | "generic" | null>(null);
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
          setRefused(null);
          start(async () => {
            const r = await deleteMyAccountAction();
            if (r.ok) router.push("/");
            else setRefused(r.error === "proof_required" ? "proof_required" : "generic");
          });
        }}
      >
        {pending ? t("common.working") : t("me.deleteAccount")}
      </button>
      {refused && (
        <span className="mt-2 block" role="alert">
          {t(refused === "proof_required" ? "errors.proof_required" : "errors.generic")}
        </span>
      )}
    </p>
  );
}
