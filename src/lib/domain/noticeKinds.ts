import { isValidTimeZone, wallClock } from "@/lib/dates";

/**
 * What a player may switch off, and when the app keeps quiet: the owner's decision D, 9 October 2026,
 * "A switch for each notice kind, quiet hours, and an inbox".
 *
 * Before this a player had one switch, `players.email_notifications`, and it was a switch on a
 * channel, not on a kind: it stopped the activity emails of about ten notices together and left their
 * Telegram, push and WhatsApp copies alone. So nobody could say "tell me when my match moves, not
 * when a spot opens somewhere", and nobody could say "not at night". The kinds below are the
 * sentences a player would use for that, grouped the way a player thinks, not one per code path.
 *
 * Every path that sends a player a notice names itself here (`SENDERS`), and the name says the kind.
 * `tell` and every fan-out take the name, so a new sender that forgets one fails the typecheck, and
 * `tests/notice-kinds.test.ts` fails on a file that sends without going through the gate. The pure
 * rules are here; the rows are `src/lib/domain/notices.ts`.
 */

export const NOTICE_KINDS = ["changes", "reminders", "spots", "clubMatches", "results", "crew", "coach"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/**
 * On unless switched off, with one exception: the club's new matches, which the owner's decision B
 * (9 October 2026) made an opt-in. Those went to up to forty of a club's recent players who never
 * asked for them, and /about promises mail only for things a player asked for.
 */
export const KIND_DEFAULTS: Readonly<Record<NoticeKind, boolean>> = { changes: true, reminders: true, spots: true, clubMatches: false, results: true, crew: true, coach: true };

/**
 * Every send path to a player, and its kind. The key is also the notice's inbox message
 * (`noticeItem.<sender>` in messages/*.json), so the inbox renders in the reader's language.
 */
export const SENDERS = {
  // Match changes: the time, the place, cancelled, the line-up, moved up or taken out.
  matchUpdated: "changes", // notifyEventUpdated, and the Telegram note beside it (postTelegramNotice)
  matchCancelled: "changes", // notifyEventCancelled, and the Telegram note beside it
  lineupComplete: "changes", // notifyLineupChange
  lineupOpen: "changes", // notifyLineupChange
  movedUp: "changes", // notifyPromotion: off the waiting list
  removed: "changes", // notifyRemoved: the organiser took them out, or the night went on without them
  requestApproved: "changes", // notifyRequestDecided: the organiser said yes
  requestDeclined: "changes", // notifyRequestDecided: the organiser said no
  organizerFeed: "changes", // notifyCreator: who joined or left the match you organise
  tournamentEntry: "changes", // tellOrganizerOfEntry
  tournamentIn: "changes", // tellMovedUp: the pair is in from the waiting list
  tournamentPartner: "changes", // tellPartnerClaimed
  tournamentDraw: "changes", // tellDrawPublished
  tournamentSchedule: "changes", // tellSchedule
  tournamentMoved: "changes", // tellMoved
  // Reminders: just before.
  matchReminder: "reminders", // the push an hour before (/api/cron/push)
  tournamentSoon: "reminders", // tellMatchSoon, fifteen minutes before
  lessonReminder: "reminders", // notifyLessonReminder, the evening before
  // Spots: a place you might want.
  spotOpen: "spots", // notifyRefill
  wanted: "spots", // notifyWanted: a match at the hour you asked for
  courtFree: "spots", // offerFreeCourts
  // The club's new matches (off by default, decision B).
  clubMatch: "clubMatches", // notifyClubMatch
  // Scores and results.
  scoreAsk: "results", // nudgeForScore
  result: "results", // sendWaResults
  moment: "results", // notifyMilestones
  podium: "results", // tellPodium
  levelConfirmed: "results", // notifyLevelCheckDecided, yes
  levelDeclined: "results", // notifyLevelCheckDecided, no
  // Your crew.
  crewMatch: "crew", // notifyGroupMatch
  groupAsk: "crew", // notifyGroupAsk, to the admins
  groupAskApproved: "crew", // notifyGroupAskDecided
  groupAskDeclined: "crew", // notifyGroupAskDecided
  groupHandover: "crew", // handOverGroupAction
  // Lessons, from either side of the coach's book.
  lessonBooked: "coach",
  lessonCancelled: "coach",
  lessonMoved: "coach",
  paidClaimed: "coach",
  paidConfirmed: "coach",
  studentJoined: "coach",
  packageTaken: "coach",
  studentAsked: "coach",
  studentAccepted: "coach",
  studentInvited: "coach",
  lessonOffer: "coach",
  offerLapsed: "coach",
  lessonRequest: "coach",
  lessonRequestAccepted: "coach",
  lessonRequestDeclined: "coach",
  lowPackage: "coach",
  managerJoined: "coach",
  levelCheckAsked: "coach", // notifyLevelCheckAsked, to the coach or the club
  coachListed: "coach", // tellCoachListed, to the players who asked for a coach
  wantersTold: "coach", // tellCoachListed, to the coach
} as const satisfies Record<string, NoticeKind>;
export type Sender = keyof typeof SENDERS;

/**
 * Messages that are not notices: the answer to something the person just did or asked for and is
 * waiting on. No switch holds them and the inbox does not keep them. Named, so a `tell` that skips
 * the gate says which of these it is.
 */
export const RECEIPTS = ["clubClaimDecision"] as const;
export type Receipt = (typeof RECEIPTS)[number];

export const noticeKey = (sender: Sender): `noticeItem.${Sender}` => `noticeItem.${sender}`;

/**
 * What a notice row may carry: plain facts the inbox turns into words in the reader's language. A
 * time is an instant and a zone, never a formatted day, because a formatted day is already one
 * language. Never a link: a personal link signs its reader in (rule 7), so `cleanParams` drops
 * anything shaped like one, whoever passed it.
 */
export type NoticeParams = { at?: string; tz?: string; venue?: string; name?: string; group?: string; club?: string; title?: string; count?: number; what?: string };
const PARAM_KEYS = ["at", "tz", "venue", "name", "group", "club", "title", "count", "what"] as const;

export function cleanParams(p: NoticeParams): NoticeParams {
  const out: Record<string, string | number> = {};
  for (const k of PARAM_KEYS) {
    const v = p[k];
    if (typeof v === "number") {
      if (Number.isFinite(v)) out[k] = v;
      continue;
    }
    if (typeof v !== "string") continue;
    const s = v.trim().slice(0, 120);
    if (!s || /:\/\/|^\/|\/p\/|www\./i.test(s)) continue;
    out[k] = s;
  }
  return out as NoticeParams;
}

/** A player's own settings, as the row stores them: only the kinds that differ from the default. */
export type StoredKinds = Partial<Record<NoticeKind, boolean>> | null | undefined;
export type NoticeSettings = { kinds: StoredKinds; quietFrom: number | null; quietTo: number | null; quietTz: string | null };

export function kindOn(stored: StoredKinds, kind: NoticeKind): boolean {
  const v = stored?.[kind];
  return typeof v === "boolean" ? v : KIND_DEFAULTS[kind];
}

/** The zone quiet hours are read in: the player's own (saved from their browser), else the match's, else Bangkok, where the app began. */
export const QUIET_FALLBACK_TZ = "Asia/Bangkok";
export const quietZone = (s: Pick<NoticeSettings, "quietTz">, matchTz?: string | null): string =>
  [s.quietTz, matchTz].find((z): z is string => Boolean(z) && isValidTimeZone(z!)) ?? QUIET_FALLBACK_TZ;

const DAY_MIN = 24 * 60;
const validMinute = (m: number | null | undefined): m is number => typeof m === "number" && Number.isInteger(m) && m >= 0 && m < DAY_MIN;
export const quietSet = (s: Pick<NoticeSettings, "quietFrom" | "quietTo">): boolean => validMinute(s.quietFrom) && validMinute(s.quietTo) && s.quietFrom !== s.quietTo;

/** Is this minute of the day inside quiet hours? From is inside, to is not; 22:00–08:00 wraps midnight. */
export function inQuiet(from: number, to: number, minute: number): boolean {
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** How long a notice about a match may still interrupt the night: a change this close to the start ignores quiet hours (the owner, decision D). */
export const URGENT_WITHIN_MS = 3 * 3600_000;
export const isUrgent = (startsAt: Date | null | undefined, now: Date): boolean => Boolean(startsAt) && startsAt!.getTime() >= now.getTime() && startsAt!.getTime() - now.getTime() <= URGENT_WITHIN_MS;

export type Release = "now" | "held" | "off";

/**
 * The gate, for one notice to one person. Off: kept in the inbox, never delivered, not even later.
 * Held: kept in the inbox until quiet hours end (`dueAt`), when the hourly job sends one short
 * message for all of them. Now: delivered on the person's channel as before.
 */
export function releaseOf(s: NoticeSettings, kind: NoticeKind, now: Date, about: { startsAt?: Date | null; tz?: string | null } = {}): { release: Release; dueAt: Date | null } {
  if (!kindOn(s.kinds, kind)) return { release: "off", dueAt: null };
  if (!quietSet(s) || isUrgent(about.startsAt, now)) return { release: "now", dueAt: null };
  const tz = quietZone(s, about.tz);
  const w = wallClock(now, tz);
  const minute = w.hour * 60 + w.minute;
  if (!inQuiet(s.quietFrom!, s.quietTo!, minute)) return { release: "now", dueAt: null };
  const wait = (s.quietTo! - minute + DAY_MIN) % DAY_MIN;
  const dueAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + wait * 60_000);
  return { release: "held", dueAt };
}

/** "22:00" from minutes after midnight. */
export const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Minutes after midnight from "22:00" or "22"; null for anything else, which is how "off" arrives. */
export function minuteOf(v: unknown): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * The form's answer as the row stores it: the kinds that differ from the default, and quiet hours
 * only when both ends are set and differ. A zone the browser sent that Intl does not know is dropped.
 */
export function cleanNoticeSettings(input: { on: readonly string[]; quietFrom?: unknown; quietTo?: unknown; tz?: unknown }): { kinds: Partial<Record<NoticeKind, boolean>>; quietFrom: number | null; quietTo: number | null; quietTz: string | null } {
  const on = new Set(input.on);
  const kinds: Partial<Record<NoticeKind, boolean>> = {};
  for (const k of NOTICE_KINDS) if (on.has(k) !== KIND_DEFAULTS[k]) kinds[k] = on.has(k);
  const from = minuteOf(input.quietFrom);
  const to = minuteOf(input.quietTo);
  const quiet = from !== null && to !== null && from !== to;
  const tz = typeof input.tz === "string" && input.tz && isValidTimeZone(input.tz) ? input.tz : null;
  return { kinds, quietFrom: quiet ? from : null, quietTo: quiet ? to : null, quietTz: quiet ? tz : null };
}

/** The one line the /me screen shows before the switches are opened: how many kinds are on, and the quiet hours. */
export function noticeSummary(s: NoticeSettings): { on: number; total: number; quiet: { from: string; to: string } | null } {
  return {
    on: NOTICE_KINDS.filter((k) => kindOn(s.kinds, k)).length,
    total: NOTICE_KINDS.length,
    quiet: quietSet(s) ? { from: hhmm(s.quietFrom!), to: hhmm(s.quietTo!) } : null,
  };
}

/** How long the inbox keeps a notice. The hourly job prunes older rows, a bounded batch at a time. */
export const INBOX_DAYS = 90;
