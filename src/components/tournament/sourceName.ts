import { roundKey } from "@/lib/domain/draw";

/** The translator, typed loosely, as in DrawView: every key here is proven by the message files. */
type T = (key: string, values?: Record<string, string | number>) => string;

/**
 * Where a knockout side comes from, in words: "Winner of group A", "Group B, place 2", "Winner of
 * quarter-final 3". The rehearsal of 24 September 2026 read "to be decided vs to be decided" down
 * the whole afternoon of the order of play; a player could not tell that winning their group put
 * them on court 3 at 13:00. The codes are the draw's own (`planDraw` in src/lib/domain/draw.ts):
 * `G:<group>:<place>`, `W:<phase>:<round>:<n>` and `L:…` for the winner and the loser of a match,
 * `Q:<n>` for a qualifier. `roundsOf` gives the number of rounds in a phase, which names the round.
 */
export function sourceName(t: T, source: string | null | undefined, roundsOf: (phase: string) => number): string | null {
  if (!source) return null;
  const [kind, a, b, c] = source.split(":");
  if (kind === "G" && a && b) return Number(b) === 1 ? t("tournament.srcGroupWinner", { label: a }) : t("tournament.srcGroupPlace", { label: a, place: Number(b) });
  if (kind === "Q" && a) return t("tournament.srcQualifier", { n: Number(a) });
  if ((kind === "W" || kind === "L") && a && b && c) {
    const round = Number(b);
    const k = roundKey(round, Math.max(round, roundsOf(a)));
    const name = k.key === "final" ? t("tournament.roundFinalOne") : k.key === "semi" ? t("tournament.roundSemiOne") : k.key === "quarter" ? t("tournament.roundQuarterOne") : t("tournament.roundOfOne", { of: k.of ?? 0 });
    return t(kind === "W" ? "tournament.srcWinner" : "tournament.srcLoser", { round: name, n: Number(c) });
  }
  return null;
}

/** The number of rounds in each phase of each category, from any list of its matches. */
export function roundsIndex(matches: readonly { categoryId: string; phase: string; round: number }[]): (categoryId: string) => (phase: string) => number {
  const max = new Map<string, number>();
  for (const m of matches) {
    const key = `${m.categoryId}:${m.phase}`;
    max.set(key, Math.max(max.get(key) ?? 0, m.round));
  }
  return (categoryId) => (phase) => max.get(`${categoryId}:${phase}`) ?? 0;
}
