import { useTranslations } from "next-intl";

/**
 * Subscribing to the player's own feed (src/lib/calendarFeed.ts), in the two ways that work, and one
 * short line on where it does not. `webcal:` makes the phone or the Mac subscribe instead of importing
 * one copy; Google takes the address on a computer. The Google Calendar app on Android cannot subscribe
 * at all, so the line says so, and for a chat player says what carries the changes there instead.
 * The same block serves the match page and the page a chat button opens.
 */
export function CalendarSubscribe({ webcal, google, chat }: { webcal: string; google: string; chat: boolean }) {
  const t = useTranslations("calendar");
  return (
    <div className="mt-2" data-testid="calendar-subscribe">
      <div className="flex flex-wrap gap-2">
        <a href={webcal} className="btn-secondary btn-sm whitespace-normal text-left leading-snug">
          📅 {t("subscribe")}
        </a>
        <a href={google} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm whitespace-normal text-left leading-snug">
          {t("subscribeGoogle")}
        </a>
      </div>
      <p className="mt-1.5 text-xs text-muted">{t(chat ? "subscribeNoteChat" : "subscribeNote")}</p>
    </div>
  );
}
