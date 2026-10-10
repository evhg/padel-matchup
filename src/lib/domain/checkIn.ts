import type { TournamentFormat } from "@/db/schema";
import { pairsRefusal, seatUnits, unitCounts } from "./fixedPairs";
import { firstRoundRefusal } from "./formats";

/**
 * "Who is here?" — the social tournament's check-in before round 1 (October 2026).
 *
 * On the night, the list the organiser opened a week ago is never the list on court: somebody is
 * stuck in traffic, somebody's friend turned up with a racket. Before this, the only way to draw the
 * people actually standing there was to remove each absent name by hand (which moved the waiting
 * list up and offered the freed spot to strangers) and then press "Generate round 1".
 *
 * The check-in is a tick per name. Everyone on the list starts ticked; whoever is on the waiting list
 * starts unticked, because round 1 has always drawn the list and never the queue behind it, and
 * ticking them is how the organiser says "they came, let them play". Walk-ins are added as reserved
 * names (the same row "Open spot" makes), so they are on the list, ticked, like anyone else.
 *
 * The state is the two exceptions, never the ticks themselves: names unticked from the list and names
 * ticked from the waiting list. A name that arrives after the screen opened (a walk-in, a late join)
 * then takes its default without anybody storing it.
 */

export type CheckInNames = {
  /** Named spots on the list (joined, confirmed, reserved), in order. */
  listed: readonly string[];
  /** Waiting-list spots, in order. */
  waiting: readonly string[];
};

export type CheckInChoice = {
  /** Listed spots the organiser unticked. */
  away: ReadonlySet<string>;
  /** Waiting-list spots the organiser ticked. */
  waitingIn: ReadonlySet<string>;
};

/** The spots round 1 will draw: the ticked list in its order, then the ticked waiting list in its order. */
export function presentSpots(names: CheckInNames, choice: CheckInChoice): string[] {
  return [...names.listed.filter((id) => !choice.away.has(id)), ...names.waiting.filter((id) => choice.waitingIn.has(id))];
}

/**
 * Who hears "We started without you": every name the check-in left out, except the person who pressed
 * Start. An organiser who unticks their own name has chosen to sit out, and an email telling them the
 * night went on without them is noise. A reserved name with no player has nobody to tell.
 */
export function absentToTell<T extends { playerId: string | null }>(absent: readonly T[], actorPlayerId: string | null): T[] {
  return absent.filter((a) => a.playerId !== null && a.playerId !== actorPlayerId);
}

export type StartAdvice =
  | { kind: "ready"; count: number }
  /** Fewer than four ticked: `more` is how many to tick or add. */
  | { kind: "need_4"; count: number; more: number }
  /** King of the Court with a count outside fours: tick or add `up`, or untick `down`. */
  | { kind: "fours"; count: number; up: number; down: number };

/**
 * Whether "Start with N players" may be pressed, and if not, what would let it. The refusal itself is
 * `firstRoundRefusal`, the rule `generateRound` enforces, so the button and the write cannot disagree.
 * For king, `down` is offered only while unticking leaves four or more, which `firstRoundRefusal`
 * already guarantees: a count of five or more outside fours always keeps a multiple of four below it.
 */
export function startAdvice(format: TournamentFormat, count: number): StartAdvice {
  const refusal = firstRoundRefusal(format, count);
  if (refusal === "need_4_players") return { kind: "need_4", count, more: 4 - count };
  if (refusal === "multiple_of_4") return { kind: "fours", count, up: 4 - (count % 4), down: count % 4 };
  return { kind: "ready", count };
}

export type PairStartAdvice =
  | { kind: "ready"; count: number }
  /** Fewer than two complete pairs ticked: `more` is how many pairs to tick or add. */
  | { kind: "need_pairs"; count: number; more: number }
  /** A ticked name without a ticked partner: pair them, or untick them. */
  | { kind: "partner_needed"; count: number; singles: number };

/**
 * "Who is here?" on a fixed-pairs night, where the tick is the pair's: unticking one partner unticks
 * the pair, because the night draws pairs (the owner's decision F). A pair of which only one came is
 * split first ("Split"), so that partner shows as a single; a ticked single then holds Start until
 * the organiser pairs them or unticks them, which is `pairsRefusal`, the rule `generateRound` keeps.
 * `names` are the check-in's names in list order with their pair keys; `present` the ids round 1 would draw.
 */
export function pairStartAdvice(names: readonly { id: string; pairId: string | null }[], present: readonly string[]): PairStartAdvice {
  const ticked = new Set(present);
  const { pairs, singles } = unitCounts(seatUnits(names.filter((n) => ticked.has(n.id)).map((n, position) => ({ ...n, status: "joined", position }))));
  const refusal = pairsRefusal(pairs, singles);
  if (refusal === "partner_needed") return { kind: "partner_needed", count: pairs, singles };
  if (refusal === "need_2_pairs") return { kind: "need_pairs", count: pairs, more: 2 - pairs };
  return { kind: "ready", count: pairs };
}
