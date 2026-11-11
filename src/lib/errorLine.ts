/**
 * The line a refused action shows: the code of `errors.<code>` in `messages/*.json`, or "generic" for a
 * code with no line of its own. Pure and free of the catalogue, so a client component can use it.
 *
 * A button whose action failed and said nothing looked like a button that did nothing (the owner, 9
 * November 2026: "check all the buttons in the app so they are actually doing what they are supposed
 * to do"). `tests/error-line.test.ts` proves every code here has its line in the three languages.
 */
export const ERROR_LINES = [
  "not_found",
  "cancelled",
  "past",
  "full",
  "closed",
  "already_in",
  "not_member",
  "forbidden",
  "invalid",
  "locked",
  "not_started",
  "not_participant",
  "generic",
  "email_disabled",
  "too_many",
  "slot_taken",
  "level_required",
  "scores_missing",
  "format_locked",
  "no_result",
  "roster_changed",
  "partner_needed",
  "need_2_pairs",
  "pairs_locked",
  "taken",
  "already_paired",
  "not_fixed_pairs",
  "pairs_waiting",
  "name_held",
  "held_record",
  "name_seated",
  "name_unreached",
  "proof_required",
] as const;

export type ErrorLine = (typeof ERROR_LINES)[number];

const KNOWN: ReadonlySet<string> = new Set(ERROR_LINES);

/** `errors.<this>` for an action's error code: its own line where the catalogue has one, else "generic". */
export const errorLine = (code: string): ErrorLine => (KNOWN.has(code) ? (code as ErrorLine) : "generic");
