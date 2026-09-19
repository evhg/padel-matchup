"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setStreamUrlAction } from "@/actions/competitions";

/** The organiser pastes where the match is streamed; the page and the screen show "Watch live". */
export function StreamForm({ slug, matchId, url }: { slug: string; matchId: string; url: string | null }) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [value, setValue] = useState(url ?? "");
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(true)}>
        ▶ {t("tournament.stream")}
      </button>
    );
  }
  return (
    <form
      className="mt-1 flex flex-wrap items-center gap-2"
      data-testid={`stream-${matchId}`}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await setStreamUrlAction(slug, matchId, value);
          if (r.ok) {
            setOpen(false);
            router.refresh();
          } else setError(r.error === "invalid" ? t("tournament.errUrl") : t("common.somethingWrong"));
        });
      }}
    >
      <input className="input min-w-0 flex-1 py-1 text-sm" type="url" inputMode="url" placeholder="https://" value={value} onChange={(e) => setValue(e.target.value)} aria-label={t("tournament.stream")} />
      <button type="submit" className="btn-primary btn-sm" disabled={pending}>
        {t("common.save")}
      </button>
      <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>
        {t("common.cancel")}
      </button>
      <span className="w-full text-xs text-muted">{t("tournament.streamHelp")}</span>
      {error && <span className="w-full text-sm font-semibold text-warn">{error}</span>}
    </form>
  );
}
