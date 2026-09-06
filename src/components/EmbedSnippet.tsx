"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

/** A folded "Embed this board" row: one line closed, the iframe snippet and a copy button open. */
export function EmbedSnippet({ html }: { html: string }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(html);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="text-sm">
      <button type="button" className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {"</>"} {t("embed.title")}
      </button>
      {open && (
        <div className="mt-2 rounded-2xl bg-bg p-3 animate-pop">
          <p className="text-xs text-muted">{t("embed.help")}</p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-xl bg-ink p-3 text-[12px] leading-relaxed text-white">
            <code>{html}</code>
          </pre>
          <button type="button" className="btn-secondary btn-xs mt-2" onClick={copy}>
            {copied ? t("embed.copied") : t("embed.copy")}
          </button>
        </div>
      )}
    </div>
  );
}
