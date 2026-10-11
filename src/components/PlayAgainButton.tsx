"use client";

import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { duplicateEventAction } from "@/actions/events";

/** What "Play again" needs from the page: the default and the bounds as the match's own wall clock ("2026-10-17T18:00"). */
export type PlayAgainOffer = {
  /** The last game's day and time a week on: one tap still does what it always did. */
  defaultWhen: string;
  /** Now, and 90 days on: the server refuses anything outside, so the browser stops it first. */
  minWhen: string;
  maxWhen: string;
  /** This match's players already had their one "I'm in?" message: the help line stops promising it. */
  sent: boolean;
};

/**
 * "Play again" (DECIDING rule 37): one next game with the same settings, on the day and at the time in
 * the one control above the button. Stacked on purpose: at 390 px a field and a button side by side
 * wrap into a half-width button, so the field takes its line and the button keeps the full width. The
 * input is uncontrolled: a value typed before the page hydrates is not wiped by the first render.
 */
export function PlayAgainButton({ code, offer }: { code: string; offer: PlayAgainOffer }) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const when = useRef<HTMLInputElement>(null);
  const go = () => {
    const input = when.current;
    // A pick before now or past 90 days: say why here, without the round trip.
    if (input && !input.checkValidity()) {
      setError(t("event.playAgainWhenRange"));
      return;
    }
    start(async () => {
      setError(null);
      const [date, time] = (input?.value ?? "").split("T");
      const r = await duplicateEventAction(code, date && time ? { date, time: time.slice(0, 5) } : null);
      if (r && !r.ok) setError(r.error === "invalid" ? t("event.playAgainWhenRange") : t("common.somethingWrong"));
    });
  };
  return (
    <div data-testid="play-again" className="flex flex-col gap-2">
      <input
        ref={when}
        type="datetime-local"
        aria-label={t("event.playAgainWhen")}
        className="input w-full"
        defaultValue={offer.defaultWhen}
        min={offer.minWhen}
        max={offer.maxWhen}
        data-testid="play-again-when"
      />
      <button type="button" className="btn-primary w-full" disabled={pending} onClick={go}>
        {pending ? t("common.working") : t("event.playAgainShort")}
      </button>
      <p className="text-center text-xs text-faint">{offer.sent ? t("event.playAgainSent") : t("event.playAgainOne")}</p>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
