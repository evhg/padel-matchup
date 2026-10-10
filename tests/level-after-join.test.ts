import { describe, expect, it } from "vitest";
import { QUICK_BANDS, askLevelAfterJoin, bandLevel, levelAskSkipKey } from "@/lib/domain/levelAsk";
import { bandOf, fromScale } from "@/lib/domain/levels";

/**
 * "Your level?" under the join confirmation: most players have no level, so the roster's chips stay
 * empty and a level range has nothing to work with. The card asks once, at the moment of joining,
 * and stays away wherever the level was already asked or nobody joined.
 */
const joined = { seated: true, level: null, ranged: false, organiser: false, open: true };

describe("the level card after joining", () => {
  it("asks a player who just joined and has no level", () => {
    expect(askLevelAfterJoin(joined)).toBe(true);
  });

  it("never asks a player who has a level, whatever it is", () => {
    expect(askLevelAfterJoin({ ...joined, level: 3 })).toBe(false);
    // Zero is a level ("just starting"), not a missing one.
    expect(askLevelAfterJoin({ ...joined, level: 0 })).toBe(false);
  });

  it("stays away from a ranged match, which asked for the level at the join itself", () => {
    expect(askLevelAfterJoin({ ...joined, ranged: true })).toBe(false);
  });

  it("asks only somebody who joined, never a visitor or the organiser", () => {
    expect(askLevelAfterJoin({ ...joined, seated: false })).toBe(false);
    expect(askLevelAfterJoin({ ...joined, organiser: true })).toBe(false);
  });

  it("is gone once the match is over or cancelled", () => {
    expect(askLevelAfterJoin({ ...joined, open: false })).toBe(false);
  });
});

describe("the quick picks", () => {
  it("are three named bands, each saving the middle of its band", () => {
    expect(QUICK_BANDS).toEqual(["beginner", "intermediate", "advanced"]);
    expect(QUICK_BANDS.map(bandLevel)).toEqual([2, 3, 4]);
    // The saved number reads back as the band the player tapped, on /levels and on My matches.
    for (const b of QUICK_BANDS) expect(bandOf(bandLevel(b))).toBe(b);
  });

  it("take a Playtomic number as it is, on the same 0–7 scale", () => {
    expect(fromScale("playtomic", 3.25)).toBe(3.25);
    expect(fromScale("playtomic", 8)).toBeNull();
  });

  it("remember a skip per player, so a second person on the same phone is still asked", () => {
    expect(levelAskSkipKey("a")).not.toBe(levelAskSkipKey("b"));
  });
});
