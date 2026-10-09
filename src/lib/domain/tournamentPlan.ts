import type { TournamentFormat } from "@/db/schema";
import { maxCourtsFor } from "./americano";
import { firstRoundRefusal } from "./formats";

/**
 * The shape of a social tournament night, before anybody plays it: how many courts, how many rest
 * each round, how many rounds make the full rotation, how long a round takes at the chosen score, and
 * so how many rounds the booking holds.
 *
 * A player deciding whether to join a Friday americano wants the night at a glance — how full, which
 * format, to how many points, how many rounds, how many courts, when it ends — and an organiser
 * choosing 16 players at 32 points wants to hear before the night that it does not fit in two hours.
 * The match page's chips, the panel's sample before round 1 and the create form's line all read this
 * one function. The page computes the plan once, from `nightField`, and hands the same object to the
 * panel, so the chips and the sample cannot disagree.
 *
 * Pure and a leaf: the create form imports it, so it must not reach the database.
 */

/** About forty seconds a point in social padel, serve to serve, the walk to the ball included. */
export const SECONDS_PER_POINT = 40;
/** About four minutes a game. */
export const MINUTES_PER_GAME = 4;
/** Changing courts and partners between rounds. */
export const CHANGEOVER_MINUTES = 2;
/** A race to N games: the winner takes N and the loser about 0.6 N, so about 1.6 N games are played. */
const GAMES_PER_RACE = 1.6;

/**
 * Minutes one round takes at the chosen score, the changeover included: 16 at 21 points, 28 at first
 * to 4 games. Null with free scoring, where the organiser keeps the time and the score follows it.
 */
export function roundMinutes(score: { pointsPerMatch?: number | null; gamesTo?: number | null }): number | null {
  if (score.gamesTo) return Math.ceil(score.gamesTo * GAMES_PER_RACE * MINUTES_PER_GAME + CHANGEOVER_MINUTES);
  if (score.pointsPerMatch) return Math.ceil((score.pointsPerMatch * SECONDS_PER_POINT) / 60 + CHANGEOVER_MINUTES);
  return null;
}

/** Courts a round fills: one per four players, never more than the organiser gave. The engine's own rule (`planRound`). */
export function courtsUsed(players: number, courts?: number | null): number {
  if (players < 4) return 0;
  const max = maxCourtsFor(players);
  return Math.max(1, Math.min(courts ?? max, max));
}

/**
 * Rounds until everyone has partnered everyone once. Each player needs players − 1 partners, gets one
 * in every round they play, and only 4 × courts of them play a round. For a field in fours on every
 * court that is players − 1, the exact circle schedule (`rotationLength`); with rests it is the
 * fewest rounds that could do it, which is what an organiser plans the night around.
 */
export function rotationRounds(players: number, courts?: number | null): number | null {
  const c = courtsUsed(players, courts);
  if (c === 0) return null;
  return Math.ceil((players * (players - 1)) / (4 * c));
}

export type NightPlan = {
  players: number;
  courts: number;
  /** Players who sit out each round, in turn. */
  resting: number;
  /** Americano only: rounds until everyone has partnered everyone once. */
  rotation: number | null;
  /** Minutes a round takes at the chosen score; null with free scoring. */
  roundMinutes: number | null;
  /** Americano with a score: how long the full rotation takes. */
  rotationMinutes: number | null;
  /** Rounds that fit in the booking, when the score says how long a round is. */
  fits: number | null;
  /** About how many rounds the night has: the rotation cut to what fits, or for mexicano and king what fits. */
  rounds: number | null;
  /** The full rotation runs past the booking. */
  tooLong: boolean;
};

/**
 * How many players the night is planned for, so the hero's chips and the panel's sample give one
 * number. From round 1 on, the names that play. Before it, the names in now when round 1 could start
 * with them (that is the field Generate would draw), else the field the organiser opened: three names
 * of eight, or a king night of five, still reads as a night of eight.
 */
export function nightField(input: { format: TournamentFormat; names: number; capacity: number; roundsDrawn: number }): number {
  if (input.roundsDrawn > 0) return input.names;
  return firstRoundRefusal(input.format, input.names) ? input.capacity : input.names;
}

/** The night for this many players, or null below four, where there is no round to draw. */
export function nightPlan(input: { players: number; courts?: number | null; format: TournamentFormat; pointsPerMatch?: number | null; gamesTo?: number | null; durationMinutes: number }): NightPlan | null {
  const courts = courtsUsed(input.players, input.courts);
  if (courts === 0) return null;
  const minutes = roundMinutes(input);
  const rotation = input.format === "americano" ? rotationRounds(input.players, input.courts) : null;
  const rotationMinutes = rotation && minutes ? rotation * minutes : null;
  const fits = minutes ? Math.max(1, Math.floor(input.durationMinutes / minutes)) : null;
  const rounds = rotation ? (fits ? Math.min(rotation, fits) : rotation) : fits;
  return {
    players: input.players,
    courts,
    resting: input.players - courts * 4,
    rotation,
    roundMinutes: minutes,
    rotationMinutes,
    fits,
    rounds,
    tooLong: rotationMinutes != null && rotationMinutes > input.durationMinutes,
  };
}

/** Whole hours and the minutes left over, for "about 1h 52m". */
export const hoursAndMinutes = (minutes: number) => ({ h: Math.floor(minutes / 60), m: minutes % 60 });
