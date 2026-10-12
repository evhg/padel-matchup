"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { answerFor, answerKey, askFor, namesTyped, type PastAnswer, type PastView } from "@/lib/domain/pastAsk";
import { PastAsk } from "./PastAsk";

/** The organiser's past players as the create form holds them: chips (one record of the name) and the views the question reads. */
export type PastNamesState = { chips: readonly string[]; views: readonly PastView[] };

/** How many "Played with you" chips the create form shows at once. */
const CHIPS_SHOWN = 8;

/**
 * Under the create form's "Players you already have" (the owner, 12 October 2026: "As organizer before
 * and after creating the match should be able to select from players they played with before, and if
 * manually typed and it matches a previously played person it should ask if its this person"):
 *
 *   - "Played with you": a tap adds the name on its own line, and the place keeps that player's record,
 *     as the open spot's chips do.
 *   - "Is this Danny, who played with you on Sep 13 at Kross Padel?" under a typed name a past player
 *     carries, and "Which Danny is it?" under a name two carry. The form sends nothing until each is
 *     answered (`CreateEventForm`).
 *   - The answer, with "Change" beside it.
 *
 * The list comes once, when this block first shows (`onLoad`): the landing page itself reads nothing more.
 */
export function PastNames({
  text,
  state,
  answers,
  onLoad,
  onAdd,
  onAnswer,
  reveal = 0,
}: {
  text: string;
  state: PastNamesState | null;
  answers: Readonly<Record<string, PastAnswer>>;
  onLoad: () => void;
  onAdd: (name: string) => void;
  onAnswer: (name: string, answer: PastAnswer | undefined) => void;
  /** Bumped when the form was sent with a question still open: the first one scrolls into view. */
  reveal?: number;
}) {
  const t = useTranslations();
  useEffect(() => onLoad(), [onLoad]);
  useEffect(() => {
    if (reveal) document.querySelector('[data-testid="create-names"] [data-testid="past-ask"]')?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [reveal]);
  if (!state) return null;

  const typed = [...new Map(namesTyped(text).map((n) => [answerKey(n), n])).values()];
  const typedKeys = new Set(typed.map(answerKey));
  const chips = state.chips.filter((c) => !typedKeys.has(answerKey(c))).slice(0, CHIPS_SHOWN);
  const rows = typed.map((name) => ({ name, options: askFor(state.views, name), answer: answerFor(answers, name) })).filter((r) => r.options.length > 0 || r.answer === true);
  if (rows.length === 0 && chips.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="create-names">
      {rows.map((r) =>
        r.answer === undefined ? (
          <PastAsk key={answerKey(r.name)} name={r.name} options={r.options} onAnswer={(a) => onAnswer(r.name, a)} />
        ) : (
          <p key={answerKey(r.name)} className="flex items-center gap-2 text-xs font-semibold" data-testid="past-answered">
            <span className={r.answer === "new" ? "text-muted" : "text-ok"}>{r.answer === "new" ? t("create.askPastNewSet", { name: r.name }) : `✓ ${t("create.keepsRecord", { name: r.name })}`}</span>
            <button type="button" className="underline" onClick={() => onAnswer(r.name, undefined)}>
              {t("create.askPastChange")}
            </button>
          </p>
        ),
      )}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="create-played-with-you">
          <span className="text-xs font-bold uppercase tracking-wider text-faint">{t("create.playedWithYou")}</span>
          {chips.map((n) => (
            <button key={n} type="button" className="chip-muted min-h-9 px-3 text-sm" onClick={() => onAdd(n)}>
              {n}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
