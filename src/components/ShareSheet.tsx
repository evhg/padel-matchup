"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { telegramShareUrl, whatsappShareUrl } from "@/lib/share";

export function CopyButton({ value, label, className = "btn-ghost", copiedLabel }: { value: string; label: string; className?: string; copiedLabel?: string }) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button type="button" onClick={copy} className={className}>
      {copied ? (copiedLabel ?? t("common.copied")) : label}
    </button>
  );
}

export function ShareButtons({ url, text, phone, size = "lg" }: { url: string; text: string; phone?: string | null; size?: "lg" | "sm" }) {
  const t = useTranslations();
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);
  const sm = size === "sm" ? " btn-sm" : "";
  return (
    <div className={`grid gap-2 ${size === "sm" ? "grid-cols-3" : "grid-cols-2"}`}>
      <a href={whatsappShareUrl(text, phone)} target="_blank" rel="noopener noreferrer" className={`btn${sm} bg-[#25D366] text-white hover:brightness-95`}>
        <WhatsAppIcon /> {t("share.whatsapp")}
      </a>
      <a href={telegramShareUrl(url, text)} target="_blank" rel="noopener noreferrer" className={`btn${sm} bg-[#229ED9] text-white hover:brightness-95`}>
        <TelegramIcon /> {t("share.telegram")}
      </a>
      <CopyButton value={url} label={t("share.copyLink")} className={`btn-ghost${sm}${size === "sm" ? "" : " col-span-2"}`} />
      {canShare && size === "lg" && (
        <button
          type="button"
          className="btn-ghost col-span-2"
          onClick={() => navigator.share({ url, text: text.replace(url, "").trim() }).catch(() => {})}
        >
          {t("share.nativeShare")}
        </button>
      )}
    </div>
  );
}

export function QrPanel({ url, hint }: { url: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="rounded-3xl bg-white p-4 shadow-card border border-line">
        <QRCodeSVG value={url} size={220} level="M" bgColor="#ffffff" fgColor="#14161a" marginSize={1} />
      </div>
      {hint && <p className="text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function LinkBox({ url, display }: { url: string; display: string }) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-line-strong bg-bg px-4 py-3 text-center">
      <a href={url} className="block break-all text-xl font-extrabold tracking-tight">
        {display}
      </a>
    </div>
  );
}

function WhatsAppIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38c1.45.79 3.08 1.21 4.79 1.21 5.46 0 9.91-4.45 9.91-9.91C21.95 6.45 17.5 2 12.04 2m0 1.67c4.54 0 8.24 3.7 8.24 8.24 0 4.54-3.7 8.24-8.24 8.24-1.55 0-3.06-.43-4.37-1.25l-.31-.18-3.12.82.83-3.04-.2-.32a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.24-8.24m-3.3 4.3c-.18 0-.47.07-.72.34-.25.27-.95.93-.95 2.26s.97 2.62 1.11 2.8c.14.18 1.92 2.93 4.66 4.11 2.27.9 2.74.72 3.23.67.5-.05 1.6-.65 1.83-1.29.22-.63.22-1.17.16-1.29-.07-.11-.25-.18-.52-.32-.27-.13-1.6-.79-1.85-.88-.25-.09-.43-.13-.61.14-.18.27-.7.88-.86 1.06-.16.18-.32.2-.59.07-.27-.14-1.14-.42-2.17-1.34-.8-.72-1.34-1.6-1.5-1.87-.16-.27-.02-.42.12-.55.12-.12.27-.32.4-.48.14-.16.18-.27.27-.45.09-.18.05-.34-.02-.48-.07-.13-.61-1.47-.83-2.01-.22-.53-.44-.46-.61-.47h-.55Z" />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
    </svg>
  );
}
