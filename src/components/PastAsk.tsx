"use client";

import { useLocale, useTranslations } from "next-intl";
import { formatDayMonth } from "@/lib/dates";
import type { PastAnswer, PastView } from "@/lib/domain/pastAsk";

/** "Sep 13" in the reader's language, from the day the browser was given (that match's own day). */
const dayLabel = (day: string, locale: string) => formatDayMonth(new Date(`${day}T12:00:00Z`), "UTC", locale);

/**
 * The question a typed name gets before its place is held, when a past player carries the name (the
 * owner, 12 October 2026: "if manually typed and it matches a previously played person it should ask
 * if its this person to avoid creating dupes"). One past player: "Is this Danny, who played with you
 * on Sep 13 at Kross Padel?" with "Yes, that's Danny" and "No, someone new". Two or more: "Which Danny
 * is it?", a button for each with the day and the club, and "No, someone new". The answer goes back
 * as the day and the club it showed; the server finds the record again (`recordForAnswer`).
 */
export function PastAsk({ name, options, onAnswer, disabled = false }: { name: string; options: readonly PastView[]; onAnswer: (answer: PastAnswer) => void; disabled?: boolean }) {
  const t = useTranslations("create");
  const locale = useLocale();
  const button = "min-h-10 rounded-xl px-3 text-left text-sm font-bold ring-1 transition whitespace-normal leading-snug";
  const no = (
    <button type="button" className={`${button} bg-card text-ink ring-line-strong`} disabled={disabled} onClick={() => onAnswer("new")} data-testid="past-ask-new">
      {t("askPastNew")}
    </button>
  );
  if (options.length === 0) return null;
  if (options.length === 1) {
    const o = options[0];
    const day = dayLabel(o.day, locale);
    return (
      <div className="rounded-2xl bg-accent-soft px-3 py-2.5" data-testid="past-ask" role="group" aria-label={name}>
        <p className="text-sm font-semibold">{o.club ? t("askPastOne", { name, day, club: o.club }) : t("askPastOneNoClub", { name, day })}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={`${button} bg-ink text-on-ink ring-ink`} disabled={disabled} onClick={() => onAnswer({ day: o.day, club: o.club })} data-testid="past-ask-yes">
            {t("askPastYes", { name })}
          </button>
          {no}
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl bg-accent-soft px-3 py-2.5" data-testid="past-ask" role="group" aria-label={name}>
      <p className="text-sm font-semibold">{t("askPastMany", { name })}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((o) => {
          const day = dayLabel(o.day, locale);
          return (
            <button key={`${o.day}|${o.club ?? ""}`} type="button" className={`${button} bg-card text-ink ring-line-strong`} disabled={disabled} onClick={() => onAnswer({ day: o.day, club: o.club })} data-testid="past-ask-option">
              {o.club ? t("askPastOption", { day, club: o.club }) : t("askPastOptionNoClub", { day })}
            </button>
          );
        })}
        {no}
      </div>
    </div>
  );
}
