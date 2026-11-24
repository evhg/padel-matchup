import { describe, expect, it } from "vitest";
import { cleanChoices, cleanTeamName, pairName, TEAM_NAME_MAX } from "@/lib/domain/reelChoices";

const PAIRS = ["Ana & Bo", "Cy & Di"] as const;

describe("what the player chooses for the reel", () => {
  it("keeps every option on and plays Bounce when the page sent nothing", () => {
    expect(cleanChoices(undefined, PAIRS)).toEqual({ teams: ["Ana & Bo", "Cy & Di"], crowd: true, numbers: true, music: "bounce" });
  });

  it("takes the choices that are choices, and the default for the rest", () => {
    expect(cleanChoices({ teams: ["Smash Bros", ""], crowd: false, numbers: "no", music: "dnb" }, PAIRS)).toEqual({ teams: ["Smash Bros", "Cy & Di"], crowd: false, numbers: true, music: "dnb" });
    expect(cleanChoices({ music: "<script>" }, PAIRS).music).toBe("bounce");
  });

  it("writes a team name on one line, and short enough for the tall reel", () => {
    expect(cleanTeamName("  The\n\tWall  ", "x")).toBe("The Wall");
    expect(cleanTeamName("x".repeat(80), "y")).toHaveLength(TEAM_NAME_MAX);
    expect(cleanTeamName(42, "Team A")).toBe("Team A");
  });

  it("names a pair by its players, or by the fallback when nobody is named", () => {
    expect(pairName(["Ana", " Bo "], "Team A")).toBe("Ana & Bo");
    expect(pairName(["", " "], "Team B")).toBe("Team B");
  });
});
