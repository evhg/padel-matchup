"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { copiedValue, nativeShareData, tagForWhatsapp, tagMatchUrl, telegramShareFor, whatsappShareUrl } from "@/lib/share";

/** WhatsApp's and Telegram's own colours, white words on both themes: one place each (`tests/contrast.test.ts` counts them). */
export const WHATSAPP_COLOURS = "bg-[#25D366] text-white hover:brightness-95";
const TELEGRAM_COLOURS = "bg-[#229ED9] text-white hover:brightness-95";

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

/** The phone's own share sheet, with a picture when one is given; its link tagged `?s=share`, as every other button tags its own. */
async function shareNatively(url: string, text: string, imageUrl?: string) {
  const shared = nativeShareData(url, text);
  try {
    if (imageUrl && typeof navigator.canShare === "function") {
      const blob = await fetch(imageUrl).then((r) => r.blob());
      const file = new File([blob], "kicksmash.png", { type: blob.type || "image/png" });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: shared.textWithLink });
        return;
      }
    }
    await navigator.share({ url: shared.url, text: shared.text });
  } catch {
    /* the person closed the sheet */
  }
}

/**
 * WhatsApp and Telegram on one line, Copy under them at full width, at both sizes: three small buttons on one
 * line put the labels and icons outside the buttons at 390 px (`.btn` does not wrap). `copy` says what Copy
 * puts on the clipboard (`copiedValue`): the link alone, or the whole message, for a text that carries
 * links of its own ("Send all invites in one message", the owner's "I also fix the Copy bug", 6 November 2026).
 */
export function ShareButtons({ url, text, phone, size = "lg", imageUrl, copy = "link" }: { url: string; text: string; phone?: string | null; size?: "lg" | "sm"; /** A picture to attach in the phone's share sheet (Instagram Stories, WhatsApp, Telegram all take it). */ imageUrl?: string; copy?: "link" | "message" }) {
  const t = useTranslations();
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);
  // The narrowest place is the personal-link box at 390 px: 126 px a button, so "WhatsApp" and its icon need the tighter padding.
  const sm = size === "sm" ? " btn-sm px-3 gap-1.5" : "";
  const shareNative = () => shareNatively(url, text, imageUrl);
  return (
    <div className="grid grid-cols-2 gap-2">
      {/* A match link says which button sent it (`?s=wa`, `?s=tg`, `?s=link`, `?s=share`), so what starts from a tap in a group is counted as such. */}
      <WhatsAppShare url={url} text={text} phone={phone} className={sm} />
      {/* The link once: as the share's own address, never again inside the text (`telegramShareFor`). */}
      <a href={telegramShareFor(url, text)} target="_blank" rel="noopener noreferrer" className={`btn-brand${sm} ${TELEGRAM_COLOURS}`}>
        <TelegramIcon /> {t("share.telegram")}
      </a>
      <CopyButton value={copiedValue(url, text, copy)} label={copy === "message" ? t("share.copyMessage") : t("share.copyLink")} className={`btn-ghost${sm} col-span-2`} />
      {canShare && size === "lg" && (
        <button type="button" className="btn-ghost col-span-2" onClick={shareNative} data-testid="native-share">
          {imageUrl ? t("share.nativeShareImage") : t("share.nativeShare")}
        </button>
      )}
    </div>
  );
}

/**
 * The WhatsApp share in WhatsApp's own colour, the link tagged `?s=wa`: the first button of
 * `ShareButtons`, and, `quiet`, the one link of the organiser's "Kicksmash can't reach Tim" line, which
 * must not stand beside the page's own Share as a second green button (rule 3). `className` is the size
 * (" btn-sm") and anything the place adds.
 */
export function WhatsAppShare({ url, text, phone, label, className = "", testId, quiet = false }: { url: string; text: string; phone?: string | null; label?: string; className?: string; testId?: string; quiet?: boolean }) {
  const t = useTranslations();
  const href = whatsappShareUrl(tagForWhatsapp(text, url), phone);
  if (quiet)
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={`link inline-flex items-center gap-1.5 text-sm font-semibold${className}`} data-testid={testId}>
        <WhatsAppIcon /> {label ?? t("share.whatsapp")}
      </a>
    );
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`btn-brand${className} ${WHATSAPP_COLOURS}`} data-testid={testId}>
      <WhatsAppIcon /> {label ?? t("share.whatsapp")}
    </a>
  );
}

export function QrPanel({ url, hint }: { url: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-3">
      {/* White in both themes, never `bg-card`: a scanner wants dark squares on a light ground. */}
      <div className="rounded-3xl bg-white p-4 shadow-card border border-line">
        <QRCodeSVG value={url} size={220} level="M" bgColor="#ffffff" fgColor="#14161a" marginSize={1} />
      </div>
      {hint && <p className="text-sm text-muted">{hint}</p>}
    </div>
  );
}

/**
 * The code, folded away until somebody wants it.
 *
 * On a phone the open panel is 220px of square plus its box: a quarter of the screen, for the one
 * case where two people are standing on the same court. The match page already folded it and the
 * share screen did not, so this is that shape in one place rather than two that drift.
 *
 * The poster keeps the open panel: a printed sheet is the case where the code IS the point.
 */
export function QrFold({ url, label }: { url: string; label: string }) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-sm link">QR · {label}</summary>
      <div className="mt-3">
        <QrPanel url={url} />
      </div>
    </details>
  );
}

/** The phone's own share sheet, as one quiet button, where the browser has one (`navigator.share`). */
export function NativeShare({ url, text, image, className = "btn-ghost btn-sm" }: { url: string; text: string; image?: string; className?: string }) {
  const t = useTranslations();
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);
  if (!canShare) return null;
  return (
    <button type="button" className={className} onClick={() => shareNatively(url, text, image)} data-testid="native-share">
      {image ? t("share.nativeShareImage") : t("share.nativeShare")}
    </button>
  );
}

/**
 * "Other ways to share" (the owner, 9 November 2026: "Telegram, Copy, QR and the story image go under one
 * 'Other ways to share' line"). The one WhatsApp share lives in the bottom bar for the organiser and every
 * seated player; this fold is one line in the page that opens the rest, with the same message. A viewer
 * the bar gives no share (nobody seated, or a match over) gets WhatsApp here too (`whatsapp`), so the
 * page always has one way to send the link. `story` is the 9:16 picture's address; `extra` is the
 * WhatsApp hand-off line where a number is set.
 */
export function OtherShares({ url, text, story = null, whatsapp = false, image, extra = null }: { url: string; text: string; story?: string | null; whatsapp?: boolean; /** The result card's picture, for the phone's own share sheet. */ image?: string; extra?: ReactNode }) {
  const t = useTranslations();
  return (
    <details className="card group" data-testid="other-shares">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block font-bold">{t("share.otherWays")}</span>
          <span className="block truncate text-xs text-muted">{t(story ? "share.otherWaysSummary" : "share.otherWaysSummaryShort")}</span>
        </span>
        <span className="shrink-0 text-faint transition group-open:rotate-180" aria-hidden>
          ⌄
        </span>
      </summary>
      <div className="mt-4 flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2">
          {whatsapp && <WhatsAppShare url={url} text={text} className=" btn-sm col-span-2" />}
          {/* The link once: as the share's own address, never again inside the text (`telegramShareFor`). */}
          <a href={telegramShareFor(url, text)} target="_blank" rel="noopener noreferrer" className={`btn-brand btn-sm ${TELEGRAM_COLOURS}`}>
            <TelegramIcon /> {t("share.telegram")}
          </a>
          <CopyButton value={copiedValue(url, text, "link")} label={t("share.copyLink")} className="btn-ghost btn-sm" />
          <NativeShare url={url} text={text} image={image} className="btn-ghost btn-sm col-span-2" />
        </div>
        <QrFold url={url} label={t("share.qrHint")} />
        {story && (
          <div>
            <div className="text-sm font-bold">📸 {t("share.story")}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <a href={story} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm">
                {t("share.storyOpen")}
              </a>
              <CopyButton value={tagMatchUrl(url, "ig")} label={t("share.storyCopy")} className="btn-ghost btn-sm" />
            </div>
          </div>
        )}
        {extra}
      </div>
    </details>
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

export function WhatsAppIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="shrink-0">
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38c1.45.79 3.08 1.21 4.79 1.21 5.46 0 9.91-4.45 9.91-9.91C21.95 6.45 17.5 2 12.04 2m0 1.67c4.54 0 8.24 3.7 8.24 8.24 0 4.54-3.7 8.24-8.24 8.24-1.55 0-3.06-.43-4.37-1.25l-.31-.18-3.12.82.83-3.04-.2-.32a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.24-8.24m-3.3 4.3c-.18 0-.47.07-.72.34-.25.27-.95.93-.95 2.26s.97 2.62 1.11 2.8c.14.18 1.92 2.93 4.66 4.11 2.27.9 2.74.72 3.23.67.5-.05 1.6-.65 1.83-1.29.22-.63.22-1.17.16-1.29-.07-.11-.25-.18-.52-.32-.27-.13-1.6-.79-1.85-.88-.25-.09-.43-.13-.61.14-.18.27-.7.88-.86 1.06-.16.18-.32.2-.59.07-.27-.14-1.14-.42-2.17-1.34-.8-.72-1.34-1.6-1.5-1.87-.16-.27-.02-.42.12-.55.12-.12.27-.32.4-.48.14-.16.18-.27.27-.45.09-.18.05-.34-.02-.48-.07-.13-.61-1.47-.83-2.01-.22-.53-.44-.46-.61-.47h-.55Z" />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="shrink-0">
      <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
    </svg>
  );
}
