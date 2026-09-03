"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { QRCodeSVG } from "qrcode.react";
import { rotatePersonalLinkAction } from "@/actions/identity";
import { whatsappShareUrl } from "@/lib/share";
import { CopyButton } from "./ShareSheet";

export function PersonalLinkCard({ url }: { url: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [qr, setQr] = useState(false);
  const display = url.replace(/^https?:\/\//, "");

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
        <a href={whatsappShareUrl(t("identity.sendToMeText", { url }))} target="_blank" rel="noopener noreferrer" className="btn-secondary btn-sm">
          {t("identity.sendToMe")}
        </a>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setQr((q) => !q)}>
          QR
        </button>
        <button type="button" className="btn-ghost btn-sm text-muted" disabled={pending} onClick={reset}>
          {pending ? t("common.working") : t("identity.resetLink")}
        </button>
      </div>
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
