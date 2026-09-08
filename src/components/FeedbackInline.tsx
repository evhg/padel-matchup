"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FeedbackForm } from "@/components/FeedbackForm";

/** The feedback door where players already are: one quiet line or a small card that opens the form in place. No navigation, no popup. */
export function FeedbackInline({ signedInVia, variant }: { signedInVia: "telegram" | "none"; variant: "line" | "card" }) {
  const t = useTranslations("feedback");
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <div className="animate-pop">
        <FeedbackForm signedInVia={signedInVia} />
      </div>
    );
  }
  if (variant === "line") {
    return (
      <p className="text-center text-xs text-faint">
        <button type="button" className="hover:text-muted" onClick={() => setOpen(true)}>
          💬 {t("title")} →
        </button>
      </p>
    );
  }
  return (
    <section className="card">
      <h2 className="text-lg font-extrabold">💬 {t("title")}</h2>
      <p className="mt-1 text-xs text-muted">{t("sub")}</p>
      <button type="button" className="btn-secondary mt-3 self-start" onClick={() => setOpen(true)}>
        {t("footerLink")} →
      </button>
    </section>
  );
}
