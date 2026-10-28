"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { deviceHintAction, deviceHintNotMeAction, deviceHintYesAction } from "@/actions/deviceHints";
import type { HintAnswer } from "@/lib/domain/deviceHintAsk";
import { hintAskOnce, readDeviceSignals } from "@/lib/deviceSignals";
import type { BackInDoors } from "./BackInHelp";
import { requestBackIn } from "./backInBus";
import { OwnDoorList } from "./SeatedAsk";

/**
 * "Welcome back, Tim?" (the device hint's question, design B; the owner's decision of 28 October 2026,
 * DECIDING rule 40). The match page mounts this only for a browser that knows nobody, on a match not
 * called off and not started, where its one read found a remembered phone among the records it shows
 * (`anyHintAmong`). The server cannot know the browser's zone, so a European browser mounts this too:
 * `hintAskOnce` reads the zone first, and there nothing is written to the tab's storage and nothing is
 * sent. Elsewhere, once per match in a tab (`sessionStorage`), it sends what the browser tells every site
 * to `deviceHintAction`, and shows nothing until an answer comes back.
 *
 * The answer is a first name. For a record with nothing to prove, "It's me" signs in exactly as "That's
 * me" does (`deviceHintYesAction`); for a record that can prove itself, its own doors stand under the
 * question (`OwnDoorList`, the seated question's rule). "Not me" deletes that record's row of this key
 * (`deviceHintNotMeAction`), so this phone is not asked about that record until the record's own next join
 * or sign-in from a phone that gives the same key keeps it again (DECIDING rule 40). The browser never
 * holds an id, a key or which value matched: each tap sends the values again and the server decides again.
 */
export function WelcomeBack({ code, doors }: { code: string; doors: BackInDoors | null }) {
  const t = useTranslations();
  const [answer, setAnswer] = useState<HintAnswer | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    // The zone first, then the tab's note, then the values: in Europe nothing is written and nothing is sent.
    const values = hintAskOnce(code);
    if (!values) return;
    deviceHintAction(code, values)
      .then((r) => {
        if (r.ok && r.data) setAnswer(r.data);
      })
      .catch(() => undefined);
  }, [code]);

  if (!answer || gone) return null;

  const yes = () =>
    start(async () => {
      setError(null);
      const r = await deviceHintYesAction(code, readDeviceSignals());
      // Signed in: the page renders again for the record, and this question is no longer on it.
      if (r.ok) return;
      setError(r.error === "too_many" ? t("errors.too_many") : t("identity.hintFailed"));
      requestBackIn();
    });
  const no = () =>
    start(async () => {
      setGone(true);
      await deviceHintNotMeAction(code, readDeviceSignals()).catch(() => undefined);
    });

  return (
    <div data-testid="welcome-back" className="mt-4 rounded-2xl border border-court/30 bg-card px-3 py-3 animate-pop">
      <p className="text-base font-extrabold">{t("identity.hintAsk", { name: answer.name })}</p>
      <p className="mt-0.5 text-sm text-muted">{t("identity.hintWhy")}</p>
      {answer.doors ? (
        <>
          <OwnDoorList own={answer.doors} doors={doors} testid="hint" />
          <button type="button" className="link mt-3 block text-xs font-semibold" data-testid="hint-no" disabled={pending} onClick={no}>
            {t("identity.hintNo")}
          </button>
        </>
      ) : (
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn-primary btn-sm flex-1" data-testid="hint-yes" disabled={pending} onClick={yes}>
            {pending ? t("common.working") : t("identity.hintYes")}
          </button>
          <button type="button" className="btn-ghost btn-sm" data-testid="hint-no" disabled={pending} onClick={no}>
            {t("identity.hintNo")}
          </button>
        </div>
      )}
      {error && (
        <p role="status" className="mt-2 text-xs font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
