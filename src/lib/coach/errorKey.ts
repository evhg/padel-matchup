/**
 * The message under `coach.errors` for an action's error code. Pure and safe in a browser.
 *
 * Each screen of the book used to keep its own list and fall back to "That time just got taken" for
 * any code not in it, so a lapsed offer, a lesson moved by somebody else and a failed "I've paid" all
 * said a time was taken. And `too_late` was asked for by name with no message behind it, so a student
 * read the key itself. Every code here has its own words; anything else says only that it did not work.
 */
export const COACH_ERROR_CODES = ["slot_taken", "not_student", "blocked", "not_taking_bookings", "outside_hours", "too_soon", "too_late", "no_coach", "past", "has_package", "already_paid", "cancelled", "forbidden", "not_found"] as const;
export type CoachErrorCode = (typeof COACH_ERROR_CODES)[number];

export const coachErrorKey = (code: string | null | undefined): `errors.${CoachErrorCode | "generic"}` =>
  (COACH_ERROR_CODES as readonly string[]).includes(code ?? "") ? (`errors.${code}` as `errors.${CoachErrorCode}`) : "errors.generic";
