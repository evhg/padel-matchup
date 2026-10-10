"use client";

import { useTranslations } from "next-intl";
import { startTransition, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { reserveAction } from "@/actions/slots";
import { namesFromChat, planPaste } from "@/lib/domain/pasteNames";

/**
 * "Paste the names from the group", for the organiser: the replies copied out of the crew's WhatsApp
 * group become one reserved spot per name, so a player who said "in" there never leaves the group.
 * The names show before anything is held; a name already in the match is skipped. Each spot goes
 * through `reserveAction`, one after another, with the rate limit every reserved spot has.
 *
 * The box is uncontrolled and read when the button is pressed: a person can paste before the page is
 * interactive, and a controlled field would wipe it.
 */
export function PasteNames({ code, namesHere, spots }: { code: string; namesHere: readonly string[]; spots: number }) {
  const t = useTranslations();
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [held, setHeld] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const plan = useMemo(() => planPaste(namesFromChat(text), namesHere, spots), [text, namesHere, spots]);
  // Pasted before the page was interactive: the box kept it, so the preview reads it once on arrival.
  useEffect(() => {
    if (box.current?.value) setText(box.current.value);
  }, []);

  const hold = () => {
    const now = planPaste(namesFromChat(box.current?.value ?? text), namesHere, spots);
    if (now.hold.length === 0) return;
    start(async () => {
      setError(null);
      const done: string[] = [];
      for (const name of now.hold) {
        const r = await reserveAction(code, { name });
        if (!r.ok) {
          startTransition(() => setError(r.error === "too_many" ? t("errors.too_many") : r.error === "full" ? t("creator.noSpots") : t("errors.generic")));
          break;
        }
        done.push(r.data.name);
      }
      startTransition(() => {
        setHeld(done);
        if (done.length === now.hold.length) {
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
        maxLength={2000}
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
      <button type="button" className="btn-secondary btn-sm mt-2" disabled={pending || plan.hold.length === 0} onClick={hold}>
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
