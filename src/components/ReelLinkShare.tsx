"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ShareIcon } from "./ShareIcon";

/**
 * "Share the reel" on a computer (the owner, 25 November 2026: "on desktop, there is just a download, no share?").
 * A computer shares the link of the reel's own page (`/<code>/reel`), not the file: the computer's share menu
 * opens at once on the tap, where a file of 100 MB made Chrome refuse the tap after the download. A browser with
 * no share menu copies the link. A phone shares the file itself (`ReelSave`), so this renders nothing there.
 */
export function ReelLinkShare({ url, text }: { url: string; text: string }) {
  const t = useTranslations("reel");
  const [desk, setDesk] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const touch = window.matchMedia?.("(pointer: coarse)").matches && navigator.maxTouchPoints > 0;
    setDesk(!touch);
  }, []);
  if (!desk) return null;
  const share = async () => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: text, text, url });
        return;
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt(t("linkCopyPrompt"), url);
    }
  };
  return (
    <button type="button" className="btn-secondary btn-sm inline-flex w-full items-center justify-center gap-1.5" onClick={() => void share()} data-testid="reel-share-link">
      <ShareIcon />
      {copied ? t("linkCopied") : t("shareTall")}
    </button>
  );
}
