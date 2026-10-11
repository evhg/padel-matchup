import type { SlotWithPlayer } from "@/lib/domain/queries";

/**
 * What the match page hands its client components about the people in it. A seat's own id stands for
 * the player everywhere a browser sees: a player id is the one thing that used to sign a browser in as
 * that player (`restoreIdentity` until 11 October 2026), and the page goes to every viewer of the match.
 * The actions take the seat ids back and find the players on the server (`playersOfSeats`).
 */
type Seat = Pick<SlotWithPlayer, "id" | "playerId" | "invitedName" | "team"> & { player: { displayName: string; level: number | null } | null };

/** One player in the score panel: the seat id, the name, the side and the level the teams are balanced on. */
export type ScorePlayer = { id: string; name: string; team: "a" | "b" | null; level: number | null };

export const scorePlayers = (seats: readonly Seat[]): ScorePlayer[] =>
  seats.map((s) => ({ id: s.id, name: s.player?.displayName ?? s.invitedName ?? "", team: s.team, level: s.player?.level ?? null }));

/** The seat id of each seated player, for a row the page keys by player (a table of standings). */
export const seatOfPlayer = (seats: readonly Seat[]): Map<string, string> => new Map(seats.flatMap((s) => (s.playerId ? [[s.playerId, s.id] as const] : [])));

/** The players behind the seat ids a browser sent, for this match's seats only: an id from anywhere else finds nobody. */
export function playersOfSeats(seats: readonly Pick<SlotWithPlayer, "id" | "playerId">[], seatIds: readonly unknown[]): string[] {
  const asked = new Set(seatIds.filter((x): x is string => typeof x === "string"));
  return seats.flatMap((s) => (asked.has(s.id) && s.playerId ? [s.playerId] : []));
}
