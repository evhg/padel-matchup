/**
 * Which stretches of the film a fast reel sends (the owner, 23 November 2026: the faster way, for a
 * player with no time to upload the whole film). The phone finds the points by sound; this file decides
 * which of them go up. Pure, and safe in a browser.
 *
 * The lists come in the order of their worth: the first list's clips are taken first. A clip that
 * overlaps one already taken is joined to it, so no second of the film is sent twice. The engine makes
 * the reel from what it gets, so it gets more than a reel holds, and not more than a player waits for.
 */
export type Stretch = { start: number; end: number };

/** At most this many clips, and this many seconds of film in all (about 1.5 GB of a 4K film at 60 pictures a second). */
export const FAST_MAX_CLIPS = 12;
export const FAST_MAX_SECONDS = 200;

export function pickStretches(lists: readonly (readonly Stretch[])[], maxClips = FAST_MAX_CLIPS, maxSeconds = FAST_MAX_SECONDS): Stretch[] {
  const taken: Stretch[] = [];
  const total = () => taken.reduce((n, s) => n + (s.end - s.start), 0);
  for (const list of lists) {
    for (const c of list) {
      if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start) continue;
      const touching = taken.filter((s) => s.start <= c.end && c.start <= s.end);
      const joined = { start: Math.min(c.start, ...touching.map((s) => s.start)), end: Math.max(c.end, ...touching.map((s) => s.end)) };
      const added = joined.end - joined.start - touching.reduce((n, s) => n + (s.end - s.start), 0);
      if (touching.length === 0 && taken.length >= maxClips) continue;
      if (taken.length > 0 && total() + added > maxSeconds) continue;
      for (const s of touching) taken.splice(taken.indexOf(s), 1);
      taken.push(joined);
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}
