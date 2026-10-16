"use client";

import { useTranslations } from "next-intl";
import { startTransition, useState, useTransition } from "react";
import type { ActionResult } from "@/actions/shared";

/**
 * The 6-digit code box: "Code sent to …", the code, one button, and "Use a different email". The
 * restore (`RestoreWithEmail`) and every save of an address by a session by name (the owner's decision
 * of 16 October 2026, D3: `StayUpdated`, `CalendarEmail`, `EmailField`) show this one box, so a code
 * reads and behaves the same wherever it is asked for.
 *
 * It owns no `<form>`: the restore stands inside the landing page's create form, and a form inside a
 * form is invalid HTML (see `RestoreWithEmail`). Enter sends from the input's own key handler.
 */
export function EmailCodeStep({
  email,
  verifyLabel,
  onVerify,
  onDone,
  onChangeEmail,
}: {
  email: string;
  /** The button's words: "Restore" for the restore, "Confirm" for an address being proved. */
  verifyLabel: string;
  /** Sends the code; the box shows the error a refusal names. */
  onVerify: (code: string) => Promise<ActionResult<unknown>>;
  /** After a code that worked, inside the same transition. */
  onDone: () => void;
  onChangeEmail: () => void;
}) {
  const t = useTranslations();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const verify = () => {
    setError(null);
    if (code.replace(/\D/g, "").length !== 6) return setError(t("identity.codeWrong"));
    start(async () => {
      const r = await onVerify(code.replace(/\D/g, ""));
      startTransition(() => {
        if (!r.ok) {
          setError(r.error === "too_many" ? t("identity.tooMany") : r.error === "invalid" || r.error === "not_found" ? t("identity.codeWrong") : t("common.somethingWrong"));
          return;
        }
        onDone();
      });
    });
  };

  return (
    <div className="flex flex-col gap-2" data-testid="email-code">
      <p className="text-sm text-muted">{t("identity.codeSent", { email })}</p>
      <div className="flex gap-2">
        <input
          className="input tracking-[0.3em] text-center text-xl font-extrabold tabular-nums"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          placeholder="••••••"
          aria-label={t("identity.codeLabel")}
          value={code}
          autoFocus
          enterKeyHint="go"
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (code.length === 6) verify();
            }
          }}
        />
        <button type="button" onClick={verify} className="btn-primary shrink-0" disabled={pending || code.length !== 6}>
          {pending ? t("common.working") : verifyLabel}
        </button>
      </div>
      {error && <p className="text-sm font-semibold text-danger">{error}</p>}
      <button
        type="button"
        className="self-start text-sm link"
        onClick={() => {
          setCode("");
          setError(null);
          onChangeEmail();
        }}
      >
        {t("identity.changeEmail")}
      </button>
    </div>
  );
}
