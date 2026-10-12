"use client";

import { useTranslations } from "next-intl";
import { startTransition, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { reserveManyAction } from "@/actions/slots";
import { namesFromChat, planPaste } from "@/lib/domain/pasteNames";
import { answerFor, answerKey, askFor, pickOf, type PastAnswer, type PastPick, type PastView } from "@/lib/domain/pastAsk";
import { PastAnswered, PastAsk } from "./PastAsk";

/**
 * "Paste the names from the group", for the organiser: the replies copied out of the crew's WhatsApp
 * group become one reserved spot per name, so a player who said "in" there never leaves the group.
 * The names show before anything is held; a name already in the match is skipped. The whole list is
 * one request (`reserveManyAction`), under the daily limit every reserved spot counts towards. The box
 * takes an evening's copy of a chat (twenty thousand characters); the reader keeps the first 24 names.
 *
 * The box is uncontrolled and read when the button is pressed: a person can paste before the page is
 * interactive, and a controlled field would wipe it.
 *
 * A pasted name that a past player carries asks "Is this Danny, who played with you on Sep 13 at Kross
 * Padel?" first (the owner, 12 October 2026), and the button waits for the answers: Yes keeps that
 * record on the place, No holds it by name. Each answer stays on screen with "Change" until the place
 * is held, so a mis-tap on Yes shows before it attaches somebody's record (review, 12 October 2026).
 */
export function PasteNames({ code, namesHere, spots, past = [] }: { code: string; namesHere: readonly string[]; spots: number; past?: readonly PastView[] }) {
  const t = useTranslations();
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [held, setHeld] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [answers, setAnswers] = useState<Record<string, PastAnswer>>({});
  const plan = useMemo(() => planPaste(namesFromChat(text), namesHere, spots), [text, namesHere, spots]);
  // The names to be held that a past player carries, once each: a question until it has an answer, then
  // the answer with "Change", as on the create form (`PastAnswered`).
  const rows = [...new Map(plan.hold.map((n) => [answerKey(n), n])).values()].map((name) => ({ name, options: askFor(past, name), answer: answerFor(answers, name) })).filter((r) => r.options.length > 0);
  const asks = rows.filter((r) => r.answer === undefined);
  // Pasted before the page was interactive: the box kept it, so the preview reads it once on arrival.
  useEffect(() => {
    if (box.current?.value) setText(box.current.value);
  }, []);

  const hold = () => {
    const pasted = box.current?.value ?? text;
    const hold = planPaste(namesFromChat(pasted), namesHere, spots).hold;
    if (hold.length === 0) return;
    const waiting = hold.find((n) => askFor(past, n).length > 0 && answerFor(answers, n) === undefined);
    if (waiting) return setError(t("create.askPastFirst", { name: waiting }));
    // Only "Yes" travels, as the day and the club it showed; the server finds the record again.
    const picks = hold.map((n) => pickOf(n, answerFor(answers, n))).filter((p): p is PastPick => p !== null);
    start(async () => {
      setError(null);
      // One request for the whole list (`reserveManyAction`), which reads the names again on the server.
      const r = await reserveManyAction(code, pasted, picks);
      startTransition(() => {
        if (!r.ok) return setError(r.error === "too_many" ? t("errors.too_many") : r.error === "full" ? t("creator.noSpots") : t("errors.generic"));
        setHeld(r.data.held);
        setAnswers({});
        if (r.data.noSpot.length === 0) {
          if (box.current) box.current.value = "";
          setText("");
        }
      });
    });
  };

  const nothing = text.trim() !== "" && plan.hold.length + plan.already.length + plan.noSpot.length === 0;
  return (
    <details className="mt-4 border-t border-line pt-4" data-testid="paste-names">
      <summary className="cursor-pointer list-none font-bold">{t("creator.pasteTitle")}</summary>
      <p className="mt-1 text-sm text-muted">{t("creator.pasteHelp")}</p>
      <textarea
        ref={box}
        className="textarea mt-2"
        rows={4}
        maxLength={20000}
        placeholder={t("creator.pastePlaceholder")}
        onInput={(e) => setText(e.currentTarget.value)}
        data-testid="paste-names-box"
      />
      <div className="mt-2 flex flex-col gap-1 text-sm" aria-live="polite">
        {plan.hold.length > 0 && <p data-testid="paste-preview">{t("creator.pasteWillHold", { names: plan.hold.join(", ") })}</p>}
        {plan.already.length > 0 && <p className="text-muted">{t("creator.pasteAlreadyIn", { names: plan.already.join(", ") })}</p>}
        {plan.noSpot.length > 0 && <p className="font-semibold text-warn">{t("creator.pasteNoSpot", { names: plan.noSpot.join(", ") })}</p>}
        {nothing && <p className="text-muted">{t("creator.pasteNone")}</p>}
      </div>
      {rows.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {rows.map((r) =>
            r.answer === undefined ? (
              <PastAsk key={answerKey(r.name)} name={r.name} options={r.options} disabled={pending} onAnswer={(answer) => setAnswers((all) => ({ ...all, [answerKey(r.name)]: answer }))} />
            ) : (
              <PastAnswered key={answerKey(r.name)} name={r.name} answer={r.answer} disabled={pending} onChange={() => setAnswers((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k !== answerKey(r.name))))} />
            ),
          )}
        </div>
      )}
      <button type="button" className="btn-secondary btn-sm mt-2" disabled={pending || plan.hold.length === 0 || asks.length > 0} onClick={hold}>
        {pending ? t("common.working") : t("creator.pasteHold", { count: plan.hold.length })}
      </button>
      {held.length > 0 && (
        <p role="status" className="mt-2 text-sm font-semibold text-ok">
          {t("creator.pasteDone", { names: held.join(", ") })}
        </p>
      )}
      {error && <p className="mt-2 text-sm font-semibold text-danger">{error}</p>}
    </details>
  );
}
