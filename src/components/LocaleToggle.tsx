"use client";

import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setLocaleAction } from "@/actions/identity";

const COOKIE = "NEXT_LOCALE";

/**
 * Switches language with one round trip: the cookie is written in the
 * browser, the page re-renders once via router.refresh(), and the player's
 * preference is persisted in the background.
 *
 * On a phone it is one pill, the current language, and a tap on it opens the other two: three pills
 * beside the doors pushed the brand to "Kick…" on an iPhone. From the `sm` breakpoint up all three show.
 */
export function LocaleToggle({ className = "" }: { className?: string }) {
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const set = (l: "en" | "ru" | "es") => {
    if (l === locale) {
      setOpen((o) => !o);
      return;
    }
    if (pending) return;
    setOpen(false);
    document.cookie = `${COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    start(() => router.refresh());
    void setLocaleAction(l);
  };
  return (
    <div className={`inline-flex rounded-full border border-line bg-white p-0.5 text-xs font-extrabold ${className}`} aria-label="Language" aria-busy={pending}>
      {(["en", "ru", "es"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => set(l)}
          aria-pressed={locale === l}
          aria-expanded={locale === l ? open : undefined}
          className={`min-h-8 min-w-9 rounded-full px-1.5 uppercase tracking-wide transition ${locale === l ? "bg-ink text-white" : `text-muted ${open ? "" : "max-sm:hidden"}`} ${pending && locale !== l ? "animate-pulse" : ""}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
