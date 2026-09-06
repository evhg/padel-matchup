"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { setPublicProfileAction } from "@/actions/identity";
import { CopyButton } from "@/components/ShareSheet";

/** My matches → Passport: the public page switch (off by default), the signed level, the export. One card, three lines. */
export function PassportCard({ publicOn, slug, base }: { publicOn: boolean; slug: string | null; base: string }) {
  const t = useTranslations();
  const [on, setOn] = useState(publicOn);
  const [publicSlug, setPublicSlug] = useState(slug);
  const [pending, start] = useTransition();
  const url = publicSlug ? `${base}/u/${publicSlug}` : null;
  const toggle = (next: boolean) => {
    setOn(next);
    start(async () => {
      const r = await setPublicProfileAction(next);
      if (r.ok) setPublicSlug(r.data.slug);
      else setOn(!next);
    });
  };
  return (
    <section className="card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-extrabold">🪪 {t("passport.title")}</h2>
          <p className="mt-1 text-xs text-muted">{t("passport.sub")}</p>
        </div>
      </div>
      <label className="mt-3 flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-ink" checked={on} disabled={pending} onChange={(e) => toggle(e.target.checked)} />
        <span>
          <span className="font-semibold">
            {t("passport.publicProfile")} · {on ? t("passport.publicOn") : t("passport.publicOff")}
          </span>
          <span className="block text-xs text-faint">{t("passport.publicHelp")}</span>
        </span>
      </label>
      {on && url && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl bg-bg px-3 py-2 text-sm">
          <a href={url} className="link min-w-0 truncate font-mono text-xs">
            {url.replace(/^https?:\/\//, "")}
          </a>
          <CopyButton value={url} label={t("common.copy")} copiedLabel={t("common.copied")} className="btn-ghost btn-sm" />
          <a href={`${url}/passport.json`} className="btn-ghost btn-sm" title={t("passport.signedHelp")}>
            🔏 {t("passport.signed")}
          </a>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <a href="/api/me/export" className="link" download>
          ⬇ {t("passport.export")}
        </a>
        <span className="text-xs text-faint">{t("passport.exportHelp")}</span>
      </div>
    </section>
  );
}
