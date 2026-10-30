import { BACKUP_KEEP_DAYS } from "@/lib/backup";
import { DISPOSABLE_AFTER_DAYS } from "@/lib/domain/disposable";
import { RATE_ROWS_KEEP_DAYS } from "@/lib/domain/ratelimit";
import { INBOX_DAYS } from "@/lib/domain/noticeKinds";
import { PARTNER_WINDOW_MS } from "@/lib/domain/refill";
import { RENEW_EVERY_DAYS } from "@/lib/domain/browserSession";

/**
 * What /privacy and /terms say where the code decides it.
 *
 * Every figure on the privacy page comes from the constant that enforces it, so the page cannot
 * promise two days while the cron keeps three: the messages carry placeholders, and the pages fill
 * them from here. `tests/legal.test.ts` renders both pages' copy in every language and checks that
 * each figure and each cookie name is really there.
 *
 * The operator and the date are the owner's (decision of 9 October 2026): Kicksmash, Phuket,
 * Thailand, with the feedback form as the contact, and no personal name or address on either page.
 */
export const LEGAL_OPERATOR = "Kicksmash, Phuket, Thailand";

/** The day /privacy or /terms last changed. Move it in the same commit as the words. */
export const LEGAL_UPDATED = "2026-10-30";

/** That day in the reader's language: "9 October 2026", "9 октября 2026 г.", "9 de octubre de 2026". */
export function legalDate(locale: string, iso: string = LEGAL_UPDATED): string {
  const tag = locale === "ru" || locale === "es" ? locale : "en-GB";
  return new Intl.DateTimeFormat(tag, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
}

/** The values the two pages' messages ask for, in one bag. */
export function legalValues(locale: string) {
  return {
    operator: LEGAL_OPERATOR,
    date: legalDate(locale),
    disposableDays: DISPOSABLE_AFTER_DAYS,
    rateDays: RATE_ROWS_KEEP_DAYS,
    backupDays: BACKUP_KEEP_DAYS,
    inboxDays: INBOX_DAYS,
    // How far back a past partner reaches: the organiser's "Kicksmash can't reach Tim" line (DECIDING rule 7).
    partnerDays: PARTNER_WINDOW_MS / (24 * 60 * 60 * 1000),
    // How often a full sign-in gets its new year at most: the km_player line (the owner, 28 October 2026).
    renewDays: RENEW_EVERY_DAYS,
  };
}
