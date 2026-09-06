import type { Score, Slot } from "@/db/schema";
import { tally } from "./scores";

export type MatchResult = {
  a: string[];
  b: string[];
  hasTeams: boolean;
  /** Empty when only the winner is known. */
  sets: { sideA: number; sideB: number }[];
  winner: "a" | "b" | "draw";
  /** "6-3 6-4", or "" when only the winner is known. */
  score: string;
  /** Recorded with one tap (who won), no set scores: stored as a single 1-0 set, which padel never produces. */
  winnerOnly: boolean;
};

export const WINNER_ONLY_SETS = { a: [{ setNumber: 1, sideA: 1, sideB: 0 }], b: [{ setNumber: 1, sideA: 0, sideB: 1 }] } as const;
export const isWinnerOnly = (sets: Pick<Score, "sideA" | "sideB">[]) => sets.length === 1 && sets[0].sideA + sets[0].sideB === 1;

/** Names per side and who won, from the saved sets and the roster's team assignment. Null without a score. */
export function matchResult(scores: Pick<Score, "sideA" | "sideB" | "setNumber">[], roster: (Pick<Slot, "team" | "status"> & { name: string })[]): MatchResult | null {
  if (scores.length === 0) return null;
  const sets = [...scores].sort((x, y) => x.setNumber - y.setNumber).map((s) => ({ sideA: s.sideA, sideB: s.sideB }));
  const t = tally(sets);
  const winnerOnly = isWinnerOnly(sets);
  const inPlay = roster.filter((s) => s.status === "joined" || s.status === "confirmed");
  const a = inPlay.filter((s) => s.team === "a").map((s) => s.name);
  const b = inPlay.filter((s) => s.team === "b").map((s) => s.name);
  return {
    a,
    b,
    hasTeams: a.length > 0 && b.length > 0,
    sets: winnerOnly ? [] : sets,
    winner: t.a > t.b ? "a" : t.b > t.a ? "b" : "draw",
    score: winnerOnly ? "" : sets.map((s) => `${s.sideA}-${s.sideB}`).join(" "),
    winnerOnly,
  };
}
