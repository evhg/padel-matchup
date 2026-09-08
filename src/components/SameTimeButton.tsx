"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { createGroupFromEventAction } from "@/actions/groups";

/** Under a result: one tap turns the crew into a group with this match's weekly slot. */
export function SameTimeButton({ code, when }: { code: string; when: string }) {
  const t = useTranslations("card");
  const locale = useLocale();
  const [pending, start] = useTransition();
  const [done, setDone] = useState<{ code: string; name: string; created: boolean } | null>(null);
  void locale;
  if (done) {
    return (
      <div className="rounded-2xl bg-ok-soft px-4 py-3 text-sm font-semibold text-ok" data-testid="same-time-done">
        {done.created ? t("sameTimeDone", { name: done.name, when }) : t("sameTimeExists", { name: done.name })}{" "}
        <Link href={`/g/${done.code}`} prefetch={false} className="underline underline-offset-4">
          →
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <button type="button" className="btn-secondary w-full" disabled={pending} data-testid="same-time" onClick={() => start(async () => { const r = await createGroupFromEventAction(code, undefined, true); if (r.ok) setDone({ code: r.data.code, name: r.data.name, created: r.data.created }); })}>
        {pending ? "…" : `🔁 ${t("sameTime")}`}
      </button>
      <p className="text-xs text-faint">{t("sameTimeHelp")}</p>
    </div>
  );
}
