import { describe, expect, it } from "vitest";
import { roundsIndex, sourceName } from "@/components/tournament/sourceName";
import { parseSetsText, scoreVerdict } from "@/lib/tournamentText";

/**
 * Two things the tournament rehearsal of 24 September 2026 found a real weekend would trip on.
 *
 * A player listed second typed his own games first ("6-3", he won), and the page gave the match to
 * the other pair; the form now reads the winner back by name before the save, from the same reader
 * the server saves with. And the whole afternoon of the order of play read "to be decided vs to be
 * decided"; a knockout side now says where it comes from.
 */

describe("reading a typed score", () => {
  it("reads sets as A then B, and nothing that is not that shape", () => {
    expect(parseSetsText(" 6-4 3-6, 10:8 ")).toEqual({ a: [6, 3, 10], b: [4, 6, 8] });
    for (const bad of ["", "abc", "6-4-2", "6", "6-x", "-1-6"]) expect(parseSetsText(bad)).toBeNull();
  });

  it("names the winner only for a whole score under the match's own rule", () => {
    expect(scoreVerdict("set6tb", "6-3")).toBe("A");
    expect(scoreVerdict("set6tb", "3-6")).toBe("B");
    expect(scoreVerdict("set6tb", "7-6")).toBe("A");
    expect(scoreVerdict("set6tb", "6-5")).toBeNull(); // not over under "one set to 6"
    expect(scoreVerdict("set9", "9-7")).toBe("A");
    expect(scoreVerdict("set9", "6-4")).toBeNull(); // a super set is not a set to 6
    expect(scoreVerdict("sets2stb", "6-4 3-6 8-10")).toBe("B");
    expect(scoreVerdict("sets2stb", "6-4")).toBeNull(); // one set of two is not a result
    expect(scoreVerdict("nonsense", "6-4")).toBeNull();
  });
});

describe("where a knockout side comes from", () => {
  const t = (key: string, values?: Record<string, string | number>) => `${key.replace("tournament.", "")}${values ? JSON.stringify(values) : ""}`;
  const three = () => 3; // quarter-finals, semi-finals, final

  it("names a group place, a match's winner or loser by its round, and a qualifier", () => {
    expect(sourceName(t, "G:A:1", three)).toBe('srcGroupWinner{"label":"A"}');
    expect(sourceName(t, "G:B:2", three)).toBe('srcGroupPlace{"label":"B","place":2}');
    expect(sourceName(t, "W:main:1:3", three)).toBe('srcWinner{"round":"roundQuarterOne","n":3}');
    expect(sourceName(t, "W:main:2:1", three)).toBe('srcWinner{"round":"roundSemiOne","n":1}');
    expect(sourceName(t, "L:main:1:2", three)).toBe('srcLoser{"round":"roundQuarterOne","n":2}');
    expect(sourceName(t, "W:main:1:5", () => 5)).toBe('srcWinner{"round":"roundOfOne{\\"of\\":32}","n":5}');
    expect(sourceName(t, "Q:2", three)).toBe('srcQualifier{"n":2}');
  });

  it("says nothing for no source or one it does not know, so the page falls back to 'to be decided'", () => {
    expect(sourceName(t, null, three)).toBeNull();
    expect(sourceName(t, "X:1", three)).toBeNull();
    expect(sourceName(t, "W:main", three)).toBeNull();
  });

  it("counts the rounds of each phase of each category from its matches", () => {
    const rounds = roundsIndex([
      { categoryId: "gold", phase: "main", round: 1 },
      { categoryId: "gold", phase: "main", round: 3 },
      { categoryId: "gold", phase: "consolation", round: 2 },
      { categoryId: "mixed", phase: "main", round: 2 },
    ]);
    expect([rounds("gold")("main"), rounds("gold")("consolation"), rounds("mixed")("main"), rounds("mixed")("group")]).toEqual([3, 2, 2, 0]);
  });
});
