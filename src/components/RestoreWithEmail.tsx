"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { startTransition, useState, useTransition } from "react";
import { requestRestoreCode, verifyRestoreCode } from "@/actions/identity";

/**
 * Email → 6-digit code → every identity with that email is merged into one and
 * this device signs in as it.
 */
export function RestoreWithEmail({ initialEmail = "", title, compact = false, onRestored }: { initialEmail?: string; title?: string; compact?: boolean; onRestored?: () => void }) {
  const t = useTranslations();
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code" | "done">("email");
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const sendCode = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!email.trim()) return;
    start(async () => {
      const r = await requestRestoreCode(email);
      startTransition(() => {
        if (!r.ok) {
          setError(r.error === "too_many" ? t("identity.tooMany") : r.error === "email_disabled" ? t("identity.emailDisabled") : r.error === "invalid" ? t("errors.invalid") : t("common.somethingWrong"));
          return;
        }
        if (!r.data.known) {
          setInfo(t("identity.notKnown"));
          return;
        }
        if (!r.data.sent) {
          setError(t("common.somethingWrong"));
          return;
        }
        setStep("code");
      });
    });
  };

  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (code.replace(/\D/g, "").length !== 6) return setError(t("identity.codeWrong"));
    start(async () => {
      const r = await verifyRestoreCode(email, code.replace(/\D/g, ""));
      startTransition(() => {
        if (!r.ok) {
          setError(r.error === "too_many" ? t("identity.tooMany") : r.error === "invalid" || r.error === "not_found" ? t("identity.codeWrong") : t("common.somethingWrong"));
          return;
        }
        setName(r.data.name);
        setStep("done");
        onRestored?.();
        router.refresh();
      });
    });
  };

  if (step === "done") {
    return <p className={`font-semibold text-ok ${compact ? "text-sm" : ""}`}>✓ {t("identity.restored", { name })}</p>;
  }

  return (
    <div className={compact ? "" : "flex flex-col gap-2"}>
      {!compact && (
        <div>
          <h2 className="font-extrabold">{title ?? t("identity.restoreTitle")}</h2>
          <p className="mt-0.5 text-sm text-muted">{t("identity.restoreHelp")}</p>
        </div>
      )}
      {step === "email" ? (
        <form onSubmit={sendCode} className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input type="email" inputMode="email" autoComplete="email" className="input" placeholder={t("share.emailPlaceholder")} value={email} onChange={(e) => setEmail(e.target.value)} required />
            <button type="submit" className="btn-secondary shrink-0" disabled={pending || !email.trim()}>
              {pending ? t("identity.sending") : t("identity.sendCode")}
            </button>
          </div>
          {info && <p className="text-sm text-muted">{info}</p>}
          {error && <p className="text-sm font-semibold text-danger">{error}</p>}
        </form>
      ) : (
        <form onSubmit={verify} className="flex flex-col gap-2">
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
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
            <button type="submit" className="btn-primary shrink-0" disabled={pending || code.length !== 6}>
              {pending ? t("common.working") : t("identity.verify")}
            </button>
          </div>
          {error && <p className="text-sm font-semibold text-danger">{error}</p>}
          <button
            type="button"
            className="self-start text-sm link"
            onClick={() => {
              setStep("email");
              setCode("");
              setError(null);
            }}
          >
            {t("identity.changeEmail")}
          </button>
        </form>
      )}
    </div>
  );
}
