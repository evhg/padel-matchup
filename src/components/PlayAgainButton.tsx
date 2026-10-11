"use client";

import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { duplicateEventAction } from "@/actions/events";

/**
 * "Play again" (DECIDING rule 37): one next game with the same settings, on the day and at the time in
 * the one control beside the button. `defaultWhen` is the last game's day and time a week on, as the
 * match's own wall clock ("2026-10-17T18:00"), so one tap still does what it always did. The input is
 * uncontrolled: a value typed before the page hydrates is not wiped by the first render.
 */
export function PlayAgainButton({ code, defaultWhen }: { code: string; defaultWhen: string }) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const when = useRef<HTMLInputElement>(null);
  const go = () =>
    start(async () => {
      setError(null);
      const [date, time] = (when.current?.value ?? "").split("T");
      const r = await duplicateEventAction(code, date && time ? { date, time: time.slice(0, 5) } : null);
      if (r && !r.ok) setError(r.error === "invalid" ? t("errors.invalid") : t("common.somethingWrong"));
    });
  return (
    <div data-testid="play-again">
      <div className="flex flex-wrap items-center gap-2">
        <input ref={when} type="datetime-local" aria-label={t("event.playAgainWhen")} className="input min-w-0 flex-1 basis-44" defaultValue={defaultWhen} data-testid="play-again-when" />
        <button type="button" className="btn-primary shrink-0" disabled={pending} onClick={go}>
          {pending ? t("common.working") : `↻ ${t("event.playAgainShort")}`}
        </button>
      </div>
      <p className="mt-1 text-xs text-faint">{t("event.playAgainOne")}</p>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
