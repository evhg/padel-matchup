"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FeedbackForm } from "@/components/FeedbackForm";

/** The feedback door where players already are: one quiet line or a small card that opens the form in place. No navigation, no popup. */
export function FeedbackInline({ signedInVia, variant, help, shipped }: { signedInVia: "telegram" | "none"; variant: "line" | "card"; help?: string; /** Player ideas already in the app. Passed only by a page that reads the database anyway, and only from three. */ shipped?: number }) {
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
    // Visible without being a box: one bold line and its promise, opening in place.
    return (
      <p className="text-center">
        <button type="button" className="text-sm font-bold text-muted underline decoration-dotted underline-offset-4 hover:text-ink" onClick={() => setOpen(true)}>
          💬 {t("title")}
        </button>
        <span className="mt-1 block text-xs text-faint">{help ?? t("lineHelp")}</span>
      </p>
    );
  }
  // Not a suggestion box at the foot of the page. The app is built out of what people say here, so
  // the card says that first, and then proves it with the number of ideas that are already in.
  return (
    <section className="card">
      <h2 className="text-lg font-extrabold">💬 {t("builtTitle")}</h2>
      <p className="mt-1 text-sm text-muted">{t("builtBody")}</p>
      {shipped !== undefined && (
        <p className="mt-1 text-sm font-bold text-court" data-testid="feedback-shipped">
          {t("builtCount", { count: shipped })}
        </p>
      )}
      <button type="button" className="btn-secondary mt-3 self-start" onClick={() => setOpen(true)}>
        {t("title")} →
      </button>
    </section>
  );
}
