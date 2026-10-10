"use client";

import { useTranslations } from "next-intl";
import { startTransition, useState, useTransition } from "react";
import { thatsMeAction } from "@/actions/identity";
import { requestBackIn } from "./backInBus";

/**
 * "That's me" (DECIDING rule 32): one tap signs this browser in as the record of that name, or folds
 * the browser's own new record into it. The page shows it only where `thatsMeVerdict` already said
 * yes, and the action asks again; when the answer has changed in between, the way back in that needs
 * proof (email code, Telegram) opens instead, as it always did for a record that can prove itself.
 */
export function ThatsMeButton({ code, name, className = "btn-ghost btn-xs shrink-0" }: { code: string; name: string; className?: string }) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const tap = () =>
    start(async () => {
      setError(null);
      const r = await thatsMeAction(code, name);
      startTransition(() => {
        if (r.ok) return;
        setError(r.error === "too_many" ? t("errors.too_many") : t("identity.thatsMeNo"));
        if (r.error !== "too_many") requestBackIn();
      });
    });
  return (
    <>
      <button type="button" data-testid="thats-me" className={className} disabled={pending} onClick={tap}>
        {pending ? t("common.working") : t("identity.thatsMeIn")}
      </button>
      {error && (
        <span role="status" className="block text-xs font-semibold text-danger">
          {error}
        </span>
      )}
    </>
  );
}

/** For a browser that already made its own record: the old record of the same name is in the crew, not on this roster. */
export function ThatsMeLine({ code, name }: { code: string; name: string }) {
  const t = useTranslations();
  return (
    <div data-testid="thats-me-line" className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-sm text-muted">
      <span>{t("identity.thatsMeCrew", { name })}</span>
      <ThatsMeButton code={code} name={name} />
    </div>
  );
}
