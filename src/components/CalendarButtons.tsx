"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

/**
 * Two ways in: Google Calendar (web/app) and a downloadable .ics for Apple /
 * Outlook. On phones both open in the same tab: a popup that gets cancelled on
 * iOS otherwise leaves a dead blank tab behind and the button seems broken.
 */
export function CalendarButtons({ googleHref, icsHref, className = "" }: { googleHref: string; icsHref: string; className?: string }) {
  const t = useTranslations();
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    setMobile(/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
  }, []);
  const ext = mobile ? {} : { target: "_blank", rel: "noopener noreferrer" };
  return (
    <div className={className}>
      <div className="mb-1.5 text-xs font-bold uppercase tracking-wider text-faint">📅 {t("calendar.title")}</div>
      <div className="grid grid-cols-2 gap-2">
        <a href={googleHref} {...ext} className="btn-ghost">
          {t("calendar.google")}
        </a>
        <a href={icsHref} className="btn-ghost">
          {t("calendar.apple")}
        </a>
      </div>
    </div>
  );
}
