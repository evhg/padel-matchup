/**
 * What the player who sends a match's video chooses for its reel, while the phone works (the agreed
 * screens 4 and 6, the owner, 24 November 2026: "Once everything works like we discussed before including
 * all the UI screens and player reel inputs"): the two team names, the crowd's cheers, the card of the
 * match's numbers at the end, and the music.
 *
 * The choices go with the video to the reel host (`POST /u/<token>/finish`, in `meta.json` beside the
 * film) and the reel's job reads them there, so no row of Kicksmash holds them. The host cleans them
 * again (`clean_choices` in `scripts/highlights/modal/serve.py`): a page is never trusted.
 */

/** The tracks of a reel, in the order the page lists them. "none": the player adds a song in Instagram or TikTok. */
export const REEL_MUSIC = ["bounce", "dnb", "bigscreen", "sunrise", "none"] as const;
export type ReelMusic = (typeof REEL_MUSIC)[number];

/** A team's name on the reel's opening card: short enough for one line of the tall reel. */
export const TEAM_NAME_MAX = 32;

export type ReelChoices = { teams: [string, string]; crowd: boolean; numbers: boolean; music: ReelMusic };

/** One team's name as the opening card shows it: one line, no control characters, at most `TEAM_NAME_MAX`. */
export function cleanTeamName(raw: unknown, fallback: string): string {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  return (s || fallback).slice(0, TEAM_NAME_MAX);
}

/** The pair's names as the page writes them: "Ana & Bo". A pair with nobody named is "Team A" or "Team B". */
export function pairName(names: readonly string[], fallback: string): string {
  const named = names.map((n) => n.trim()).filter(Boolean);
  return cleanTeamName(named.join(" & "), fallback);
}

/** The choices a page sent, or the defaults for each one that is not a choice: every option on, Bounce. */
export function cleanChoices(raw: unknown, teams: readonly [string, string]): ReelChoices {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const t = Array.isArray(o.teams) ? o.teams : [];
  const music = REEL_MUSIC.find((m) => m === o.music) ?? "bounce";
  return { teams: [cleanTeamName(t[0], teams[0]), cleanTeamName(t[1], teams[1])], crowd: o.crowd !== false, numbers: o.numbers !== false, music };
}
