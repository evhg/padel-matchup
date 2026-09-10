"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { setClubTimezoneAction } from "@/actions/clubWeek";

/**
 * A club claimed without a time zone: the week cannot make matches until it
 * has one. One tap takes the club's city's zone when the city is known, else
 * this device's. The device's zone is read after mount, so the server and the
 * first client render agree.
 */
export function ClubTimezoneFix({ token, cityTz = null }: { token: string; cityTz?: string | null }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [tz, setTz] = useState<string>(cityTz ?? "");
  useEffect(() => {
    if (!cityTz) setTz(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "");
  }, [cityTz]);
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
        {pending ? t("common.working") : t("club.week.tzUse", { tz: tz || "…" })}
      </button>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
