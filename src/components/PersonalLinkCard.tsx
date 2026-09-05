"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { QRCodeSVG } from "qrcode.react";
import { emailPersonalLinkAction, rotatePersonalLinkAction, updateMyEmail } from "@/actions/identity";
import { CopyButton } from "./ShareSheet";

/**
 * The player's personal link: copy it, email it to yourself (the one place
 * it will still be next year), share it natively, show a QR, or reset it.
 */
export function PersonalLinkCard({ url, email, emailEnabled }: { url: string; email: string | null; emailEnabled: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [qr, setQr] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [mailTo, setMailTo] = useState<string | null>(null);
  const [askEmail, setAskEmail] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const display = url.replace(/^https?:\/\//, "");
  useEffect(() => setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function"), []);

  const emailMe = () =>
    start(async () => {
      setError(null);
      const r = await emailPersonalLinkAction();
      if (!r.ok) return setError(t("common.somethingWrong"));
      if (!r.data.email) return setAskEmail(true);
      if (!r.data.sent) return setError(t("common.somethingWrong"));
      setMailTo(r.data.email);
    });

  const saveEmailAndSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    start(async () => {
      setError(null);
      // No match code: the personal-link email goes out on its own.
      const r = await updateMyEmail(draft);
      if (!r.ok || !r.data.email) return setError(t("common.somethingWrong"));
      setMailTo(r.data.email);
      setAskEmail(false);
      router.refresh();
    });
  };

  const reset = () => {
    if (!confirm(t("identity.resetConfirm"))) return;
    start(async () => {
      const r = await rotatePersonalLinkAction();
      if (r.ok) router.refresh();
    });
  };

  return (
    <section className="card">
      <h2 className="font-extrabold">🔑 {t("identity.personalLinkTitle")}</h2>
      <p className="mt-0.5 text-sm text-muted">{t("identity.personalLinkHelp")}</p>
      <div className="mt-2 flex items-center gap-2">
        <a href={url} className="min-w-0 flex-1 truncate rounded-xl bg-bg px-3 py-2.5 font-mono text-xs">
          {display}
        </a>
        <CopyButton value={url} label={t("identity.copyLink")} className="btn-ghost btn-sm" />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {emailEnabled && (
          <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={emailMe}>
            ✉️ {t("identity.emailMeLink")}
          </button>
        )}
        {canShare && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => navigator.share({ title: t("identity.personalLinkTitle"), url }).catch(() => {})}>
            {t("share.nativeShare")}
          </button>
        )}
        <button type="button" className="btn-ghost btn-sm" onClick={() => setQr((q) => !q)}>
          QR
        </button>
        <button type="button" className="btn-ghost btn-sm text-muted" disabled={pending} onClick={reset}>
          {pending ? t("common.working") : t("identity.resetLink")}
        </button>
      </div>
      {mailTo && <p className="mt-2 text-sm font-semibold text-ok">✓ {t("identity.linkEmailed", { email: mailTo })}</p>}
      {askEmail && !mailTo && (
        <form onSubmit={saveEmailAndSend} className="mt-2 flex gap-2 animate-pop">
          <input type="email" inputMode="email" autoComplete="email" className="input" placeholder={t("share.emailPlaceholder")} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus required />
          <button type="submit" className="btn-primary shrink-0" disabled={pending || !draft.trim()}>
            {pending ? t("common.working") : t("identity.sendToEmail")}
          </button>
        </form>
      )}
      {error && <p className="mt-1 text-sm font-semibold text-danger">{error}</p>}
      {!email && emailEnabled && !askEmail && !mailTo && <p className="mt-2 text-xs text-faint">{t("identity.noEmailYet")}</p>}
      {qr && (
        <div className="mt-3 flex justify-center animate-pop">
          <div className="rounded-2xl border border-line bg-white p-3">
            <QRCodeSVG value={url} size={160} level="M" bgColor="#ffffff" fgColor="#14161a" marginSize={1} />
          </div>
        </div>
      )}
    </section>
  );
}
