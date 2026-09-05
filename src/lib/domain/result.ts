import type { Score, Slot } from "@/db/schema";
import { tally } from "./scores";

export type MatchResult = {
  a: string[];
  b: string[];
  hasTeams: boolean;
  sets: { sideA: number; sideB: number }[];
  winner: "a" | "b" | "draw";
  score: string;
};

/** Names per side and who won, from the saved sets and the roster's team assignment. Null without a score. */
export function matchResult(scores: Pick<Score, "sideA" | "sideB" | "setNumber">[], roster: (Pick<Slot, "team" | "status"> & { name: string })[]): MatchResult | null {
  if (scores.length === 0) return null;
  const sets = [...scores].sort((x, y) => x.setNumber - y.setNumber).map((s) => ({ sideA: s.sideA, sideB: s.sideB }));
  const t = tally(sets);
  const inPlay = roster.filter((s) => s.status === "joined" || s.status === "confirmed");
  const a = inPlay.filter((s) => s.team === "a").map((s) => s.name);
  const b = inPlay.filter((s) => s.team === "b").map((s) => s.name);
  return {
    a,
    b,
    hasTeams: a.length > 0 && b.length > 0,
    sets,
    winner: t.a > t.b ? "a" : t.b > t.a ? "b" : "draw",
    score: sets.map((s) => `${s.sideA}-${s.sideB}`).join(" "),
  };
}
