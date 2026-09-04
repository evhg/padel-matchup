"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { updateMyEmail } from "@/actions/identity";

/**
 * "Add to your calendar" = give us an email. The invite we send is a real
 * calendar invitation that updates itself on changes and cancellation,
 * unlike a copy created through a Google/Apple button. With an email on file
 * the invite already went out, so only a confirmation line is shown.
 */
export function CalendarEmail({ code, email, emailEnabled, className = "" }: { code: string; email: string | null; emailEnabled: boolean; className?: string }) {
  const t = useTranslations();
  const [value, setValue] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(email);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!emailEnabled) return null;

  if (sentTo) {
    return (
      <div className={`rounded-2xl bg-bg px-4 py-3 text-sm ${className}`}>
        <span className="font-semibold text-ok">📅 {t("calendar.sentTo", { email: sentTo })}</span>
      </div>
    );
  }

  return (
    <form
      className={`rounded-2xl border border-court/30 bg-court-soft/40 p-4 ${className}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        start(async () => {
          setError(null);
          const r = await updateMyEmail(value, code);
          if (!r.ok || !r.data.email) {
            setError(t("common.somethingWrong"));
            return;
          }
          setSentTo(r.data.email);
        });
      }}
    >
      <div className="font-bold">📅 {t("calendar.emailTitle")}</div>
      <p className="mt-0.5 text-sm text-muted">{t("calendar.emailHelp")}</p>
      <div className="mt-2 flex gap-2">
        <input type="email" inputMode="email" autoComplete="email" className="input" placeholder={t("share.emailPlaceholder")} value={value} onChange={(e) => setValue(e.target.value)} required />
        <button type="submit" className="btn-primary shrink-0" disabled={pending || !value.trim()}>
          {pending ? t("common.working") : t("calendar.send")}
        </button>
      </div>
      {error && <p className="mt-1 text-sm font-semibold text-danger">{error}</p>}
    </form>
  );
}
