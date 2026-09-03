"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateMyEmail } from "@/actions/identity";
import { setCreatorEmailAction } from "@/actions/events";

/**
 * Decision 9: email is optional, never required, and always explained with the
 * reward note next to the field.
 */
export function EmailField({
  initial,
  mode,
  code,
  title,
  help,
  emailEnabled,
}: {
  initial: string | null;
  mode: "me" | "creator";
  code: string;
  title?: string;
  help?: string;
  emailEnabled: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [email, setEmail] = useState(initial ?? "");
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  if (!emailEnabled) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = mode === "creator" ? await setCreatorEmailAction(code, email) : await updateMyEmail(email, code);
      if (r.ok) {
        setSaved(true);
        router.refresh();
      }
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-0.5 inline-grid h-6 w-6 shrink-0 place-items-center rounded-full bg-court-soft text-court text-xs font-black">
          i
        </span>
        <div>
          {title && <div className="font-bold">{title}</div>}
          <p className="text-sm text-muted">{help ?? t("event.emailReward")}</p>
        </div>
      </div>
      <div className="flex gap-2">
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          className="input"
          placeholder={t("share.emailPlaceholder")}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setSaved(false);
          }}
        />
        <button type="submit" className="btn-secondary shrink-0" disabled={pending || (!email && !initial)}>
          {pending ? "…" : t("common.save")}
        </button>
      </div>
      {saved && <p className="text-sm font-semibold text-ok">{mode === "creator" ? t("share.emailSaved") : email ? t("event.emailSaved") : t("event.emailSavedNoMail")}</p>}
    </form>
  );
}
