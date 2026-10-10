import { LEVEL_BANDS, LEVEL_MAX, LEVEL_MIN, normalizeLevel, type BandKey } from "./levels";

/**
 * "Your level?" — the one optional card a player meets on the match page right after they join,
 * while they have no level.
 *
 * Most players never set one ("Not set yet" on My matches), so the roster's level chips stay empty
 * and a level range has nothing to work with. The moment of joining is when a player is already
 * tapping, so the question goes there, as three named bands and the Playtomic number, one tap each.
 * It never blocks anything: Skip hides it on this device, and the join is already done.
 *
 * It stays away where the level was already asked: a ranged match asks for it at the join itself
 * (JoinInline, LevelSelect), so a seat there always carries one. The organiser is not asked either:
 * they created the match rather than joined it, and their page already carries the organiser's tools.
 */

/** The quick picks, in the order the card shows them. The rest of 0–7 stays on My matches. */
export const QUICK_BANDS: readonly BandKey[] = ["beginner", "intermediate", "advanced"];

/** The middle of a named band, in quarter steps: beginner 2.0, intermediate 3.0, advanced 4.0. */
export function bandLevel(key: BandKey): number {
  const b = LEVEL_BANDS.find((x) => x.key === key)!;
  return normalizeLevel((b.min + b.max) / 2)!;
}

/** Whether the card shows. `seated` covers the waitlist too: a waitlisted player joined as well. */
export function askLevelAfterJoin(o: { seated: boolean; level: number | null; ranged: boolean; organiser: boolean; open: boolean }): boolean {
  return o.seated && o.open && o.level == null && !o.ranged && !o.organiser;
}

/** The device's "Skip", per player, so a second person on a shared phone is still asked. */
export const levelAskSkipKey = (playerId: string): string => `km_level_ask_skip:${playerId}`;

/**
 * The levels a chat offers for a match with a range, as buttons: the range's bottom, middle and top,
 * or, with one end open, that end and the two half-steps beyond it. Each is a quarter step inside the
 * range, so a tap can only say "I fit", and the number tapped is the number saved. Never the fixed
 * bands above: for a range of 4.5–7 none of them would let anybody in, and saving the middle of a band
 * would put a 3.5 player at 3.0, below a range of 3.5–4.5. Pure; at most three, no repeats.
 */
export function rangeChoices(min: number | null, max: number | null): number[] {
  const picks = min != null && max != null ? [min, (min + max) / 2, max] : min != null ? [min, min + 0.5, min + 1] : max != null ? [max - 1, max - 0.5, max] : [];
  const levels = picks.map((n) => normalizeLevel(n)).filter((n): n is number => n != null && n >= LEVEL_MIN && n <= LEVEL_MAX);
  return [...new Set(levels)];
}
