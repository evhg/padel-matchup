export const APP_NAME = "Kicksmash";
export const APP_TAGLINE = "Padel match-up. No app, no account.";

export function baseUrl(): string {
  const raw = process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_BASE_URL || "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

/** Short public host shown in the UI (kicksma.sh). */
export function shortHost(): string {
  try {
    return new URL(baseUrl()).host;
  } catch {
    return "kicksma.sh";
  }
}

export const emailEnabled = () => Boolean(process.env.RESEND_API_KEY);

export const MATCH_CAPACITY = 4;
export const MAX_TOURNAMENT_CAPACITY = 64;
/** Matches are considered finished this long after their start time. */
export const EVENT_DURATION_MS = 2 * 60 * 60 * 1000;
/** Single organizer score reminder fires this long after start. */
export const SCORE_REMINDER_DELAY_MS = 2 * 60 * 60 * 1000;
/** Unconfirmed invitees with an email are reminded at this interval. */
export const INVITE_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
