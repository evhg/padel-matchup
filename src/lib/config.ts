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

/**
 * The Telegram bot's public name.
 *
 * It is printed on the site and in the API's own documentation, so it is not a secret. It was a
 * Vercel variable *and* five hard-coded strings in this repository at the same time, and nothing
 * kept the two in step. The value lives here; the variable still wins, so a rename needs no
 * deployment, and `tests/config-one-home.test.ts` fails when a hard-coded copy drifts from it.
 *
 * `TELEGRAM_MINIAPP_SLUG` deliberately has no default here. A bot follows from its token, but a
 * Mini App exists only once somebody creates one in BotFather. A default turned "there is no Mini
 * App" into a link, and the bot's cards started pointing at a page that need not exist.
 */
export const TELEGRAM_BOT = "kicksmash_bot";

export const emailEnabled = () => Boolean(process.env.RESEND_API_KEY);

/**
 * The owner's Telegram id: the single route everything the owner has to see travels down —
 * feedback, the listening desk, uptime, production errors. It lives here rather than in the
 * listening desk because the health check has to be able to ask without pulling that desk in.
 */
export const ownerTelegramId = () => (process.env.TELEGRAM_OWNER_ID ? Number(process.env.TELEGRAM_OWNER_ID) : null);

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
/** The second and last ask: the morning after, when the first one was missed in the evening. */
export const SECOND_SCORE_REMINDER_DELAY_MS = 18 * 60 * 60 * 1000;
/** Unconfirmed invitees with an email are reminded at this interval. */
export const INVITE_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * A spot that opens inside this window is worth telling people about. Further out the crew fills it
 * themselves and a push is only noise; the pain this answers is the drop-out nobody has time to replace.
 */
export const REFILL_WINDOW_MS = 48 * 60 * 60 * 1000;
/** …and not inside this, where nobody can reasonably get to the court in time. */
export const REFILL_MIN_NOTICE_MS = 90 * 60 * 1000;
/** How many people one freed spot may reach. Filling a court is not running a mailing list. */
export const REFILL_FANOUT_MAX = 40;
/**
 * Of those, how many may go by email. Resend's free tier sends a hundred emails a day
 * (docs/OPERATING.md), and one freed spot must not spend a tenth of it. The bot and push cost
 * nothing, so they keep the whole cap; past this, somebody who has only an address is not told.
 */
export const REFILL_EMAIL_MAX = 10;
/**
 * Of those, how many may go by WhatsApp. Each is a template Meta bills when it lands outside an open
 * window, so one freed spot pays for ten at most, as it spends ten emails at most. The day's own cap
 * (`WHATSAPP_TEMPLATES_PER_DAY`, src/lib/whatsapp/templates.ts) stands over this one.
 */
export const REFILL_WHATSAPP_MAX = 10;
