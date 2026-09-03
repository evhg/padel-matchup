export const APP_NAME = "Kicksmash";
export const APP_TAGLINE = "Padel match-up. No app, no account.";

export function baseUrl(): string {
  const raw =
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_BASE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    "http://localhost:3000";
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

/** Apex host without a leading www (kicksma.sh). */
export function apexHost(): string {
  return shortHost().replace(/^www\./, "");
}

/**
 * Sender for all email. EMAIL_FROM wins; otherwise "Kicksmash <matches@<apex>>",
 * which works as soon as the domain is verified in Resend. Localhost falls back
 * to Resend's sandbox sender.
 */
export function emailFrom(): string {
  if (process.env.EMAIL_FROM) return process.env.EMAIL_FROM;
  const host = apexHost();
  if (!host || host.startsWith("localhost") || /^\d+\.\d+\.\d+\.\d+/.test(host)) return `${APP_NAME} <onboarding@resend.dev>`;
  return `${APP_NAME} <matches@${host}>`;
}

export const MATCH_CAPACITY = 4;
export const MAX_TOURNAMENT_CAPACITY = 64;
/** Matches are considered finished this long after their start time. */
export const EVENT_DURATION_MS = 2 * 60 * 60 * 1000;
/** Single organizer score reminder fires this long after start. */
export const SCORE_REMINDER_DELAY_MS = 2 * 60 * 60 * 1000;
/** Unconfirmed invitees with an email are reminded at this interval. */
export const INVITE_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
