"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { joinAction, leaveAction } from "@/actions/slots";

export type JoinState = "join" | "join_waitlist" | "leave" | "leave_waitlist" | "member_live" | "full" | "cancelled" | "past";

export function JoinBar({
  code,
  state,
  hasIdentity,
  spotsLeft,
  waitlistPosition,
  isTournament,
}: {
  code: string;
  state: JoinState;
  hasIdentity: boolean;
  spotsLeft: number;
  waitlistPosition: number;
  isTournament: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [sheet, setSheet] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const join = (withName?: string) =>
    start(async () => {
      setError(null);
      const r = await joinAction(code, withName);
      if (!r.ok) {
        setError(r.error === "name_required" ? t("identity.nameRequired") : t(`errors.${r.error === "no_identity" ? "generic" : r.error}` as "errors.generic"));
        return;
      }
      setSheet(false);
      router.refresh();
    });

  const leave = () => {
    if (!confirm(t("event.leaveConfirm"))) return;
    start(async () => {
      const r = await leaveAction(code);
      if (!r.ok) setError(t(`errors.${r.error === "name_required" || r.error === "no_identity" ? "generic" : r.error}` as "errors.generic"));
      router.refresh();
    });
  };

  if (state === "cancelled" || state === "past") return null;

  const joinLabel = state === "join_waitlist" ? t("event.joinWaitlist") : isTournament ? t("event.joinTournament") : t("event.join");

  return (
    <>
      <div className="h-28" aria-hidden />
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/80" style={{ boxShadow: "var(--shadow-bar)" }}>
        <div className="mx-auto flex w-full max-w-xl items-center gap-3 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3">
          {(state === "join" || state === "join_waitlist") && (
            <div className="flex w-full flex-col gap-1">
              <button type="button" className="btn-primary w-full text-lg" disabled={pending} onClick={() => (hasIdentity ? join() : setSheet(true))}>
                {pending ? t("common.working") : joinLabel}
              </button>
              <div className="flex justify-between text-xs font-semibold text-muted">
                <span>{state === "join" ? t("event.spotsLeft", { count: spotsLeft }) : t("event.waitlistHelp")}</span>
                {error && <span className="text-danger">{error}</span>}
              </div>
            </div>
          )}
          {state === "leave" && (
            <>
              <div className="flex-1">
                <div className="text-base font-extrabold text-ok">✓ {t("event.youAreIn")}</div>
                {error && <div className="text-xs text-danger">{error}</div>}
              </div>
              <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={leave}>
                {t("event.leave")}
              </button>
            </>
          )}
          {state === "member_live" && <div className="flex-1 text-base font-extrabold text-court">● {t("event.inProgress")}</div>}
          {state === "leave_waitlist" && (
            <>
              <div className="flex-1">
                <div className="text-base font-extrabold">{t("event.youAreOnWaitlist", { position: waitlistPosition })}</div>
                <div className="text-xs text-muted">{t("event.waitlistHelp")}</div>
              </div>
              <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={leave}>
                {t("event.leaveWaitlist")}
              </button>
            </>
          )}
          {state === "full" && <div className="flex-1 text-base font-extrabold text-warn">{t("event.full")}</div>}
        </div>
      </div>

      {sheet && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/40 p-3 sm:items-center" onClick={() => setSheet(false)}>
          <form
            className="card w-full max-w-md animate-pop"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return setError(t("identity.nameRequired"));
              join(name);
            }}
          >
            <h2 className="text-xl font-extrabold tracking-tight">{t("identity.whatsYourName")}</h2>
            <p className="mt-1 text-sm text-muted">{t("identity.nameHelp")}</p>
            <input className="input mt-4" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("identity.namePlaceholder")} autoComplete="given-name" maxLength={40} enterKeyHint="go" />
            {error && <p className="mt-2 text-sm font-semibold text-danger">{error}</p>}
            <button type="submit" className="btn-primary mt-3 w-full text-lg" disabled={pending}>
              {pending ? t("common.working") : name.trim() ? t("event.joinAs", { name: name.trim() }) : joinLabel}
            </button>
            <button type="button" className="btn-ghost mt-2 w-full" onClick={() => setSheet(false)}>
              {t("common.cancel")}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
