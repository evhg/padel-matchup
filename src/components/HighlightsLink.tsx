"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { removeHighlightsAction, setHighlightsAction } from "@/actions/highlights";
import { errorLine } from "@/lib/errorLine";

/**
 * "Watch highlights" once somebody in the match added the video; until then, one folded line that
 * takes the YouTube link. Only the match's own players and organiser get this (the page decides), and
 * the button only ever opens YouTube (`highlightsLinkOf`).
 */
export function HighlightsLink({ code, url, canRemove }: { code: string; url: string | null; canRemove: boolean }) {
  const t = useTranslations("card");
  const tr = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (url) {
    const remove = () => {
      if (!confirm(t("removeHighlightsConfirm"))) return;
      setError(null);
      start(async () => {
        const r = await removeHighlightsAction(code);
        if (!r.ok) return setError(tr(`errors.${errorLine(r.error)}`));
        router.refresh();
      });
    };
    return (
      <div className="flex flex-col gap-1">
        <a className="btn-secondary w-full text-center" href={url} target="_blank" rel="noopener noreferrer" data-testid="highlights-watch">
          ▶ {t("watchHighlights")}
        </a>
        {canRemove && (
          <button type="button" className="text-xs text-faint hover:text-muted" disabled={pending} onClick={remove} data-testid="highlights-remove">
            {t("removeHighlights")}
          </button>
        )}
        {error && <p className="text-xs font-semibold text-danger">{error}</p>}
      </div>
    );
  }

  const save = () => {
    setError(null);
    start(async () => {
      const r = await setHighlightsAction(code, text);
      if (!r.ok) return setError(r.error === "invalid" ? t("highlightsNotYoutube") : tr(`errors.${errorLine(r.error)}`));
      setText("");
      router.refresh();
    });
  };
  return (
    <details className="text-sm" data-testid="highlights-add">
      <summary className="cursor-pointer font-semibold text-muted">▶ {t("addHighlights")}</summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="text-xs text-faint">{t("highlightsHelp")}</p>
        <input
          className="input"
          inputMode="url"
          autoComplete="off"
          placeholder="https://youtu.be/…"
          aria-label={t("addHighlights")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="highlights-input"
        />
        <button type="button" className="btn-secondary" disabled={pending || !text.trim()} onClick={save} data-testid="highlights-save">
          {pending ? "…" : t("saveHighlights")}
        </button>
        {error && <p className="text-xs font-semibold text-danger">{error}</p>}
        <p className="text-xs text-faint">{t("filmTips")}</p>
      </div>
    </details>
  );
}
