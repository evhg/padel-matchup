"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { setShareHeartRateAction } from "@/actions/identity";

/** My stats: "Keep my heart rate", on by default. Off deletes the heart rates the player had. */
export function HeartRateSwitch({ initial }: { initial: boolean }) {
  const t = useTranslations("stats");
  const [on, setOn] = useState(initial);
  const [pending, start] = useTransition();
  const toggle = (next: boolean) => {
    setOn(next);
    start(async () => {
      const r = await setShareHeartRateAction(next);
      if (!r.ok) setOn(!next);
    });
  };
  return (
    <label className="flex items-start gap-3 text-sm">
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-ink" checked={on} disabled={pending} onChange={(e) => toggle(e.target.checked)} data-testid="heart-rate-switch" />
      <span>
        <span className="font-semibold">
          {t("heartTitle")} · {on ? t("heartOn") : t("heartOff")}
        </span>
        <span className="block text-xs text-faint">{t("heartHelp")}</span>
      </span>
    </label>
  );
}
