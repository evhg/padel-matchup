"use client";

import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLocaleAction } from "@/actions/identity";

const COOKIE = "NEXT_LOCALE";

/**
 * Switches language with one round trip: the cookie is written in the
 * browser, the page re-renders once via router.refresh(), and the player's
 * preference is persisted in the background.
 */
export function LocaleToggle({ className = "" }: { className?: string }) {
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const set = (l: "en" | "ru") => {
    if (l === locale || pending) return;
    document.cookie = `${COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    start(() => router.refresh());
    void setLocaleAction(l);
  };
  return (
    <div className={`inline-flex rounded-full border border-line bg-white p-0.5 text-xs font-extrabold ${className}`} aria-label="Language" aria-busy={pending}>
      {(["en", "ru"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => set(l)}
          aria-pressed={locale === l}
          className={`min-h-8 min-w-10 rounded-full px-2 uppercase tracking-wide transition ${locale === l ? "bg-ink text-white" : "text-muted"} ${pending && locale !== l ? "animate-pulse" : ""}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
