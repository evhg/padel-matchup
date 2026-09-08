"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

/** One quiet line under a screen that opens the explanation in place. Nobody should need to ask a person. */
export function HowThisWorks({ text }: { text: string }) {
  const t = useTranslations("coach");
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-faint">
      <button type="button" className="hover:text-muted" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} {t("how")}
      </button>
      {open && <p className="mt-2 max-w-prose text-muted animate-pop">{text}</p>}
    </div>
  );
}
