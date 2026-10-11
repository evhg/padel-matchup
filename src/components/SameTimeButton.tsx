"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { createGroupFromEventAction } from "@/actions/groups";

/**
 * "Make it weekly", under "Play again" on the score panel: one tap turns the crew into a group with this
 * match's weekly slot. Its own words and the quieter weight, so the one primary action stays "Play
 * again" (one next game) and nobody taps this one for next week's game (DECIDING rules 1 and 37). The
 * label wraps: `.btn` keeps a label on one line, and a long one runs off both edges at 390 px.
 */
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
      <button type="button" className="btn-ghost w-full whitespace-normal text-center leading-tight" disabled={pending} data-testid="same-time" onClick={() => start(async () => { const r = await createGroupFromEventAction(code, undefined, true); if (r.ok) setDone({ code: r.data.code, name: r.data.name, created: r.data.created }); })}>
        {pending ? "…" : `🔁 ${t("makeWeekly")}`}
      </button>
      <p className="text-center text-xs text-faint">{t("sameTimeHelp")}</p>
    </div>
  );
}
