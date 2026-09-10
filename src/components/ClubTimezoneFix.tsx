"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setClubTimezoneAction } from "@/actions/clubWeek";

/** A club claimed without a time zone: the week cannot make matches until it has one. One tap takes this device's. */
export function ClubTimezoneFix({ token }: { token: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";
  return (
    <section className="card border-warn/40 bg-warn-soft" data-testid="club-tz-fix">
      <p className="text-sm font-semibold">{t("club.week.tzMissing")}</p>
      <button
        type="button"
        className="btn-primary mt-3 w-full"
        disabled={pending || !tz}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await setClubTimezoneAction(token, tz);
            if (!r.ok) setError(t("common.somethingWrong"));
            else router.refresh();
          })
        }
      >
        {pending ? t("common.working") : t("club.week.tzUse", { tz })}
      </button>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
