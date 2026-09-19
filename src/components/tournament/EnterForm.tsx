"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { enterPairAction, type EnteredView } from "@/actions/competitions";

/**
 * One category's door: a name (when the visitor has none yet), the partner's name, one button.
 * Done, it shows where the pair landed and the link the partner confirms with.
 */
export function EnterForm({ slug, categoryId, categoryName, hasIdentity, full }: { slug: string; categoryId: string; categoryName: string; hasIdentity: boolean; full: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<EnteredView | null>(null);
  const [copied, setCopied] = useState(false);
  const [yourName, setYourName] = useState("");
  const [partnerName, setPartnerName] = useState("");

  if (done) {
    return (
      <div className="mt-3 rounded-2xl border border-line p-3" data-testid="entered">
        <p className="font-bold text-ok">{done.status === "waiting" ? t("tournament.enteredWaiting", { category: done.category, n: done.position }) : t("tournament.entered", { category: done.category })}</p>
        {done.claimLink && (
          <div className="mt-2">
            <div className="text-sm font-bold">{t("tournament.claimLink")}</div>
            <p className="text-xs text-muted">{t("tournament.partnerHelp")}</p>
            <div className="mt-1 flex items-center gap-2">
              <input className="input min-w-0 flex-1 text-sm" readOnly value={done.claimLink} onFocus={(e) => e.currentTarget.select()} data-testid="claim-link" />
              <button
                type="button"
                className="btn-ghost btn-sm shrink-0"
                onClick={() => {
                  navigator.clipboard?.writeText(done.claimLink!).then(() => setCopied(true)).catch(() => undefined);
                }}
              >
                {copied ? t("common.copied") : t("common.copy")}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }
  if (!open) {
    return (
      <button type="button" className={`${full ? "btn-ghost" : "btn-primary"} btn-sm mt-3`} onClick={() => setOpen(true)} data-testid={`enter-${categoryId}`}>
        {full ? t("event.joinWaitlist") : t("tournament.enter")}
      </button>
    );
  }
  return (
    <form
      className="mt-3 flex flex-col gap-3 rounded-2xl border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await enterPairAction(slug, categoryId, { yourName: hasIdentity ? undefined : yourName, partnerName });
          if (r.ok) {
            setDone(r.data);
            router.refresh();
          } else {
            const who = r.detail === "partner" ? t("tournament.partner") : t("tournament.you");
            setError(
              r.error === "closed"
                ? t("tournament.errClosed")
                : r.error === "already_in"
                  ? t("tournament.errAlreadyIn", { who })
                  : r.error === "too_many"
                    ? t("tournament.errTooMany", { who, n: 2 })
                    : r.error === "invalid" && r.detail === "level"
                      ? t("tournament.errLevel")
                      : r.error === "invalid" && r.detail === "same_player"
                        ? t("tournament.errSame")
                        : r.error === "name_required"
                          ? t("identity.nameRequired")
                          : t("common.somethingWrong"),
            );
          }
        });
      }}
    >
      <div className="font-bold">{t("tournament.enterTitle", { category: categoryName })}</div>
      {!hasIdentity && (
        <label className="block">
          <span className="text-sm font-bold">{t("tournament.yourName")}</span>
          <input className="input mt-1" value={yourName} maxLength={40} required onChange={(e) => setYourName(e.target.value)} autoComplete="given-name" />
        </label>
      )}
      <div>
        <label className="block">
          <span className="text-sm font-bold">{t("tournament.partnerName")}</span>
          <input className="input mt-1" value={partnerName} maxLength={40} required onChange={(e) => setPartnerName(e.target.value)} autoComplete="off" />
        </label>
        <span className="mt-1 block text-xs text-muted">{t("tournament.partnerHelp")}</span>
      </div>
      {error && <p className="text-sm font-semibold text-warn">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary btn-sm" disabled={pending}>
          {t("tournament.enterButton")}
        </button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}
