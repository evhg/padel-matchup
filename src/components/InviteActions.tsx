"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { confirmInviteAction, declineInviteAction } from "@/actions/slots";

export function InviteActions({
  code,
  inviteCode,
  invitedName,
  hasIdentity,
  emailEnabled,
  autoDecline,
  reconfirm,
}: {
  code: string;
  inviteCode: string;
  invitedName: string;
  hasIdentity: boolean;
  emailEnabled: boolean;
  autoDecline: boolean;
  reconfirm: boolean;
}) {
  const t = useTranslations();
  const [name, setName] = useState(invitedName);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const confirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasIdentity && !name.trim()) return setError(t("identity.nameRequired"));
    start(async () => {
      const r = await confirmInviteAction(code, inviteCode, { name: hasIdentity ? undefined : name, email: email || undefined });
      if (!r.ok) setError(t(`errors.${r.error === "name_required" || r.error === "no_identity" ? "generic" : r.error}` as "errors.generic"));
    });
  };
  const decline = () =>
    start(async () => {
      const r = await declineInviteAction(code, inviteCode);
      if (!r.ok) setError(t(`errors.${r.error === "name_required" || r.error === "no_identity" ? "generic" : r.error}` as "errors.generic"));
    });

  return (
    <form onSubmit={confirm} className="flex flex-col gap-3">
      {!hasIdentity && (
        <div>
          <label className="label">{t("invitePage.nameLabel")}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="given-name" />
        </div>
      )}
      {emailEnabled && (
        <div>
          <div className="flex items-start gap-2">
            <span aria-hidden className="mt-0.5 inline-grid h-5 w-5 shrink-0 place-items-center rounded-full bg-court-soft text-court text-[10px] font-black">
              i
            </span>
            <p className="text-sm text-muted">{t("event.emailReward")}</p>
          </div>
          <input className="input mt-2" type="email" inputMode="email" autoComplete="email" placeholder={`${t("creator.email")} (${t("common.optional")})`} value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      )}
      {error && <p className="text-sm font-semibold text-danger">{error}</p>}
      <button type="submit" className="btn-primary w-full text-lg" disabled={pending}>
        {pending ? t("common.working") : reconfirm ? t("invitePage.confirmAnyway") : `✓ ${t("invitePage.confirm")}`}
      </button>
      {!reconfirm && (
        <button type="button" className={`${autoDecline ? "btn-danger" : "btn-ghost"} w-full`} disabled={pending} onClick={decline}>
          {t("invitePage.decline")}
        </button>
      )}
    </form>
  );
}
