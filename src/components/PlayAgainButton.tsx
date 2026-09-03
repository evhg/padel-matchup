"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { duplicateEventAction } from "@/actions/events";

export function PlayAgainButton({ code, className = "btn-primary w-full" }: { code: string; className?: string }) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button
        type="button"
        className={className}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await duplicateEventAction(code);
            if (r && !r.ok) setError(t("common.somethingWrong"));
          })
        }
      >
        {pending ? t("common.working") : `↻ ${t("event.playAgain")}`}
      </button>
      <p className="mt-1 text-center text-xs text-faint">{t("event.playAgainHelp")}</p>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
