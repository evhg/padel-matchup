"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { enterPairAction, type EnteredView } from "@/actions/competitions";
import { ShareButtons } from "@/components/ShareSheet";

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
            <input className="input mt-1 w-full text-sm" readOnly value={done.claimLink} onFocus={(e) => e.currentTarget.select()} data-testid="claim-link" />
            {/* WhatsApp, Telegram or copy: the link goes where the partner already is, in one tap. */}
            <div className="mt-2">
              <ShareButtons url={done.claimLink} text={t("tournament.partnerShareText", { category: done.category })} size="sm" />
            </div>
            {done.claimTelegram && (
              <p className="mt-2 text-xs text-muted">
                {t("tournament.claimTelegram")}{" "}
                <a href={done.claimTelegram} className="break-all underline" data-testid="claim-telegram">
                  {done.claimTelegram}
                </a>
              </p>
            )}
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
