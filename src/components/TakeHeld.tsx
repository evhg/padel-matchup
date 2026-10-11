"use client";

import { useTranslations } from "next-intl";
import { startTransition, useState, useTransition } from "react";
import { takeHeldPlaceAction } from "@/actions/slots";
import { useTwoTap } from "./ThatsMe";

/**
 * "Take Danny's held place" (DECIDING rule 34, the owner, 11 October 2026): two taps fill the place
 * the organiser held for this name, from the plain match link. The first tap asks "Take Danny's held
 * place?" and sends nothing; a tap anywhere else takes the question back (`useTwoTap`). The page shows
 * it only where `heldVerdict` said yes, and the action asks again under the match's lock.
 */
export function TakeHeldButton({
  code,
  name,
  className = "link text-sm font-semibold",
  armedClassName = "link text-sm font-extrabold text-ink",
}: {
  code: string;
  name: string;
  className?: string;
  armedClassName?: string;
}) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const { armed, setArmed, ref } = useTwoTap<HTMLButtonElement>();
  const [error, setError] = useState<string | null>(null);
  const tap = () => {
    if (!armed) {
      setError(null);
      setArmed(true);
      return;
    }
    setArmed(false);
    start(async () => {
      const r = await takeHeldPlaceAction(code, name);
      startTransition(() => {
        if (!r.ok) setError(r.error === "too_many" ? t("errors.too_many") : t("identity.takeHeldNo", { name }));
      });
    });
  };
  return (
    <>
      <button ref={ref} type="button" data-testid="take-held" data-armed={armed ? "true" : undefined} className={armed ? armedClassName : className} disabled={pending} onClick={tap} onBlur={() => setArmed(false)}>
        {pending ? t("common.working") : armed ? t("identity.takeHeldSure", { name }) : t("identity.takeHeld", { name })}
      </button>
      {error && (
        <span role="status" className="block text-xs font-semibold text-danger">
          {error}
        </span>
      )}
    </>
  );
}
