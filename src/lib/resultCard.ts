import type { EventDetail } from "@/lib/domain/queries";
import { matchResult } from "@/lib/domain/result";
import { fnv1a } from "@/lib/hash";

/**
 * The result card's picture, named the same way on every screen that shows it: the card page, the
 * match page, and the player's Telegram chat, where the score nudge turns into this picture.
 *
 * The version sits in the URL, so a corrected score or a new court photo is never served from a cache
 * of the old picture — by our CDN, by a phone, or by Telegram, which fetches a URL it has seen once.
 */

type T = (key: string, values?: Record<string, string | number>) => string;
type Versioned = Pick<EventDetail, "scores" | "event" | "roster"> & { creator?: { banter?: boolean } | null };

/** Changes exactly when what the picture shows changes: the recorded sets, the match state, and who stands on which side under what name. */
export const resultVersion = (detail: { scores: unknown; event: { status: string }; roster: { status: string; team: string | null; player: { displayName: string } | null; invitedName: string | null }[] }) =>
  fnv1a(JSON.stringify(detail.scores) + detail.event.status + JSON.stringify(detail.roster.map((s) => [s.status, s.team, s.player?.displayName ?? s.invitedName ?? ""])));

/**
 * The result's version plus the photo's, when there is one, and a mark when the organiser switched
 * banter off: the picture then drops its line, so it must not be served from a cache that has it.
 */
export const cardVersion = (detail: Versioned, photo: { createdAt: Date } | null) => `${resultVersion(detail)}${photo ? `-p${photo.createdAt.getTime().toString(36)}` : ""}${detail.creator?.banter === false ? "-q" : ""}`;

export const cardImagePath = (code: string, version: string) => `/${code}/card/opengraph-image?v=${version}`;

/** "Ana & Bo beat Cy & Di 6-4 6-3", from the winners' side; null while there is no score. `winners` is set only when both sides are known and somebody won. */
export function matchLine(t: T, detail: Pick<EventDetail, "scores" | "roster">): { line: string; winners: string | null } | null {
  const r = matchResult(
    detail.scores,
    detail.roster.map((s) => ({ team: s.team, status: s.status, name: s.player?.displayName ?? s.invitedName ?? "?" })),
  );
  if (!r) return null;
  const a = r.hasTeams ? r.a.join(" & ") : t("card.teamA");
  const b = r.hasTeams ? r.b.join(" & ") : t("card.teamB");
  const line = (r.winner === "draw" ? `${t("card.draw", { a, b })} ${r.score}` : r.winner === "a" ? `${t("card.won", { a, b })} ${r.score}` : `${t("card.won", { a: b, b: a })} ${r.sets.map((s) => `${s.sideB}-${s.sideA}`).join(" ")}`).trim();
  return { line, winners: r.hasTeams && r.winner !== "draw" ? (r.winner === "a" ? r.a : r.b).join(" & ") : null };
}
