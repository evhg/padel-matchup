"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { confirmInviteAction, declineInviteAction } from "@/actions/slots";
import { readDeviceSignals } from "@/lib/deviceSignals";

export function InviteActions({
  code,
  inviteCode,
  invitedName,
  hasIdentity,
  emailEnabled,
  autoDecline,
  reconfirm,
  knownEmail = null,
  asRecord = false,
  askEmail = true,
}: {
  code: string;
  inviteCode: string;
  invitedName: string;
  hasIdentity: boolean;
  emailEnabled: boolean;
  autoDecline: boolean;
  reconfirm: boolean;
  /** The viewer's saved email: shown instead of asking again. */
  knownEmail?: string | null;
  /**
   * The place keeps a past player's record, and this browser knows nobody: "I'm in" signs it in as that
   * record (the owner, 11 October 2026). No name to type, and no email asked: the session is by name.
   */
  asRecord?: boolean;
  /**
   * False for a session by name that proved nothing (the owner's decision of 16 October 2026, D3): the tap
   * keeps no address it would type, so none is asked; the confirmed page asks for one with a code first.
   */
  askEmail?: boolean;
}) {
  const t = useTranslations();
  const [name, setName] = useState(invitedName);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const confirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasIdentity && !asRecord && !name.trim()) return setError(t("identity.nameRequired"));
    start(async () => {
      const r = await confirmInviteAction(code, inviteCode, asRecord ? { hint: readDeviceSignals() } : { name: hasIdentity ? undefined : name, email: email || undefined, hint: readDeviceSignals() });
      // A place that keeps another record (a forwarded link): the server's own words for it.
      if (!r.ok) setError(r.detail === "held_record" ? t("errors.held_record") : t(`errors.${r.error === "name_required" || r.error === "no_identity" ? "generic" : r.error}` as "errors.generic"));
    });
  };
  const decline = () =>
    start(async () => {
      const r = await declineInviteAction(code, inviteCode);
      if (!r.ok) setError(t(`errors.${r.error === "name_required" || r.error === "no_identity" ? "generic" : r.error}` as "errors.generic"));
    });

  return (
    <form onSubmit={confirm} className="flex flex-col gap-3">
      {asRecord && (
        <p className="text-sm text-muted" data-testid="invite-as-record">
          {t("invitePage.asRecord", { name: invitedName })}
        </p>
      )}
      {!hasIdentity && !asRecord && (
        <div>
          <label className="label">{t("invitePage.nameLabel")}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="given-name" />
        </div>
      )}
      {emailEnabled && knownEmail && <p className="text-sm text-muted">✉️ {knownEmail}</p>}
      {emailEnabled && !knownEmail && !asRecord && askEmail && (
        <div>
          <div className="flex items-start gap-2">
            <span aria-hidden className="mt-0.5 inline-grid h-5 w-5 shrink-0 place-items-center rounded-full bg-court-soft text-court text-[0.625rem] font-black">
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
