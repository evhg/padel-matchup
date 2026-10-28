/**
 * How long a browser's sign-in lives, what ends it, and what it may not do (the owner, 28 October 2026).
 * Pure: the cookies' values and the clock in, the answer out. `src/lib/session.ts` reads and writes the
 * cookies by these rules.
 *
 * - "May a sign-in last one year after the last visit, and may every browser get 'Not you? Sign out'?"
 *   "Yes, both (Recommended)". A full sign-in gets a new year at most once in 30 days (`renewDue`), from
 *   the day that `km_has_id` carries, so it costs no read and one cookie write a month at most. A sign-in
 *   by name ("That's me", DECIDING rule 34) still ends one year after it began (`byNameOver`), also
 *   through the restore seal. "Not you? Sign out" stamps the browser with the moment it signed out, and
 *   every credential the browser held from before that moment opens nothing (`predatesSignOut`): the
 *   restore seal in its storage and the manage cookie of a match.
 * - "A session by name ('That's me') can delete that player's account today, and the deletion cancels
 *   that player's upcoming matches. Close this gap?" "Close it (Recommended)" (`deletionRefusal` in
 *   `thatsMe.ts`, beside the rest of what a session by name may not do).
 */

/** A full sign-in gets a new year at most once in this many days. */
export const RENEW_EVERY_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC day of an instant, as `km_has_id` carries it: "2026-10-28". */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** The day `km_has_id` says the session's year last began (a sign-in or a renewal); null for "1", the value before 28 October 2026, or anything else. */
export const renewedOnOf = (value: string | null | undefined): string | null => (value && ISO_DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null);

/**
 * Whether this browser's sign-in gets a new year now. Only a full sign-in, never one by name; only when
 * its year began 30 days ago or more, or on a day nobody wrote (the value before this rule) or a day still
 * to come, which only a hand on the cookie makes.
 */
export function renewDue(o: { signedIn: boolean; byName: boolean; renewedOn: string | null; today: string }): boolean {
  if (!o.signedIn || o.byName) return false;
  if (!o.renewedOn) return true;
  const days = (Date.parse(`${o.today}T00:00:00Z`) - Date.parse(`${o.renewedOn}T00:00:00Z`)) / DAY_MS;
  return days >= RENEW_EVERY_DAYS || days < 0;
}

/**
 * Whether a credential this browser was given opens nothing, because the browser signed out after it was
 * made. `minted` is the sign-out the credential was made after (0: none), `signedOutAt` the browser's
 * last sign-out (0: never). A credential made after the last sign-out works; a browser that lost all its
 * cookies lost the sign-out mark with them, and with it everything the mark refused.
 */
export const predatesSignOut = (minted: number, signedOutAt: number): boolean => minted < signedOutAt;

/** Whether a sign-in by name is over: `until` is its end (milliseconds), 0 where nobody wrote one. */
export const byNameOver = (until: number, now: number): boolean => until > 0 && now >= until;
