"use client";

import { useSyncExternalStore } from "react";
import { htmlTextAttr, textSizeCookie, type TextSize } from "@/lib/textSize";

/**
 * The "Bigger text" switch, on /me and in the header's ⋯ menu. A tap writes the cookie and sets
 * `data-text` on <html> at once, so the page grows in place: no server round trip, no reload. The
 * root layout reads the same cookie on the next page, so the size holds from the first paint.
 *
 * The state is the attribute on <html> itself, read through useSyncExternalStore, so the two
 * switches on one screen can never disagree. The server snapshot is what the server knew (the
 * cookie on /me; nothing in the menu, which is closed until somebody opens it).
 */
const EVENT = "km:textsize";

function current(): boolean {
  return document.documentElement.dataset.text === "big";
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}

export function TextSizeSwitch({ label, help, initial = false, compact = false }: { label: string; help?: string; initial?: boolean; /** The menu row: smaller, no help line. */ compact?: boolean }) {
  const big = useSyncExternalStore(subscribe, current, () => initial);

  const toggle = () => {
    const next: TextSize = big ? "normal" : "big";
    const attr = htmlTextAttr(next);
    if (attr) document.documentElement.dataset.text = attr;
    else delete document.documentElement.dataset.text;
    document.cookie = textSizeCookie(next);
    window.dispatchEvent(new Event(EVENT));
  };

  return (
    <div className={`flex items-center justify-between gap-3 ${compact ? "px-1" : ""}`}>
      <div className="min-w-0">
        <div className={compact ? "text-sm font-bold" : "font-bold"}>{label}</div>
        {help && <p className="text-sm text-muted">{help}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={big}
        aria-label={label}
        onClick={toggle}
        data-testid={compact ? "text-size-menu" : "text-size-switch"}
        className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${big ? "bg-ink" : "bg-line-strong"}`}
      >
        <span className={`inline-block h-5 w-5 rounded-full bg-on-ink shadow transition ${big ? "translate-x-6" : "translate-x-1"}`} />
      </button>
    </div>
  );
}
