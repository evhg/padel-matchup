"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { confirmClaimCodeAction, sendClaimCodeAction } from "@/actions/clubs";

/**
 * The claim's own proof: a 6-digit code sent to a work email at the club's domain. Shown on the done
 * screen and on the manage page while the claim waits, so the person can come back to it.
 */
export function ClaimCodeForm({ token, email, initialConfirmed = false }: { token: string; email: string; initialConfirmed?: boolean }) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [code, setCode] = useState("");
  const [confirmed, setConfirmed] = useState(initialConfirmed);
  const [note, setNote] = useState<string | null>(null);
  const confirm = () => {
    setNote(null);
    start(async () => {
      const r = await confirmClaimCodeAction(token, code.trim());
      if (r.ok) setConfirmed(true);
      else setNote(t("club.codeWrong"));
    });
  };
  const again = () => {
    setNote(null);
    start(async () => {
      const r = await sendClaimCodeAction(token);
      setNote(r.ok && r.data.sentTo ? t("club.codeSentTo", { email: r.data.sentTo }) : t("common.somethingWrong"));
    });
  };
  if (confirmed) {
    return (
      <p className="rounded-2xl bg-bg px-4 py-3 text-sm font-bold text-ok" data-testid="claim-verified">
        ✓ {t("club.codeConfirmed")}
      </p>
    );
  }
  return (
    <div className="rounded-2xl border border-line px-4 py-3" data-testid="claim-code">
      <p className="font-bold">{t("club.codeTitle")}</p>
      <p className="mt-1 text-xs text-muted">{t("club.codeSentTo", { email })}</p>
      <div className="mt-2 flex gap-2">
        <input className="input min-w-0 flex-1 tabular-nums" inputMode="numeric" autoComplete="one-time-code" maxLength={6} aria-label={t("club.codeLabel")} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        <button type="button" className="btn-primary btn-sm shrink-0" onClick={confirm} disabled={pending || code.length !== 6}>
          {pending ? t("common.working") : t("club.codeConfirm")}
        </button>
      </div>
      <button type="button" className="mt-2 text-xs link" onClick={again} disabled={pending}>
        {t("club.codeAgain")}
      </button>
      {note && <p className="mt-2 text-sm font-bold text-muted">{note}</p>}
    </div>
  );
}
