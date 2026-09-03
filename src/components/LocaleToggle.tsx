"use client";

import { useLocale } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLocaleAction } from "@/actions/identity";

export function LocaleToggle({ className = "" }: { className?: string }) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const set = (l: "en" | "ru") => {
    if (l === locale) return;
    start(async () => {
      await setLocaleAction(l, pathname);
      router.refresh();
    });
  };
  return (
    <div className={`inline-flex rounded-full border border-line bg-white p-0.5 text-xs font-extrabold ${className}`} aria-label="Language" style={{ opacity: pending ? 0.6 : 1 }}>
      {(["en", "ru"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => set(l)}
          aria-pressed={locale === l}
          className={`min-h-8 min-w-10 rounded-full px-2 uppercase tracking-wide transition ${locale === l ? "bg-ink text-white" : "text-muted"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
