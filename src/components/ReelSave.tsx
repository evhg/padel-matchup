"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";

type State = { at: "idle" } | { at: "getting"; pct: number | null } | { at: "ready"; file: File } | { at: "failed" };

/**
 * Saving a reel the way a phone saves a video (the owner, 24 November 2026: "the saves are completely
 * broken, when I click on them on iphone its very clunky and buggy"). A link to the file opened the reel
 * host's own page, which offers "Open in WhatsApp" and "More…" but not "Save Video". Now the page gets the
 * file itself, with the share done on the button, and hands it to the phone's share sheet: "Save Video"
 * to Photos, Instagram, WhatsApp. Where a browser cannot share a file (a computer), the same file saves
 * as a download. The player never leaves the match page.
 *
 * A share needs a fresh tap, and fetching tens of megabytes takes longer than the tap stays fresh, so
 * when the sheet will not open after the fetch, the button says "Save video" and the next tap opens it.
 */
export function ReelSave({ url, name, primary, label }: { url: string; name: string; primary: boolean; label: string }) {
  const t = useTranslations("reel");
  const [state, setState] = useState<State>({ at: "idle" });
  const busy = useRef(false);

  const hand = async (file: File): Promise<boolean> => {
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
    if (nav.canShare?.({ files: [file] }) && nav.share) {
      try {
        await nav.share({ files: [file] });
        return true;
      } catch (e) {
        // The player closed the sheet: done. A tap that went stale: the next tap opens it.
        if ((e as DOMException)?.name === "AbortError") return true;
        return false;
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    return true;
  };

  const tap = async () => {
    if (busy.current) return;
    if (state.at === "ready") {
      if (await hand(state.file)) setState({ at: "idle" });
      return;
    }
    busy.current = true;
    try {
      setState({ at: "getting", pct: null });
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(String(res.status));
      const total = Number(res.headers.get("content-length")) || 0;
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (total) setState({ at: "getting", pct: Math.min(99, Math.floor((got / total) * 100)) });
      }
      const file = new File(parts as BlobPart[], name, { type: "video/mp4" });
      if (await hand(file)) setState({ at: "idle" });
      else setState({ at: "ready", file });
    } catch {
      setState({ at: "failed" });
    } finally {
      busy.current = false;
    }
  };

  const text = state.at === "getting" ? (state.pct === null ? t("saveGetting") : t("saveGettingPct", { pct: state.pct })) : state.at === "ready" ? t("saveNow") : state.at === "failed" ? t("saveAgain") : label;
  return (
    <button type="button" className={`${primary ? "btn-secondary" : "btn-ghost"} btn-sm w-full`} onClick={tap} disabled={state.at === "getting"} aria-live="polite" data-testid={primary ? "reel-save-tall" : "reel-save-wide"}>
      {text}
    </button>
  );
}
