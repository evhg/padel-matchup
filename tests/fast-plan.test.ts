import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { FAST_MAX_CLIPS, FAST_MAX_SECONDS, pickStretches } from "@/lib/reel/fastPlan";

describe("the stretches of film a fast reel sends", () => {
  it("takes the first list first, in the order of the film, and joins what overlaps", () => {
    const best = [{ start: 100, end: 120 }, { start: 10, end: 30 }];
    const reactions = [{ start: 115, end: 126 }, { start: 300, end: 310 }];
    expect(pickStretches([best, reactions])).toEqual([{ start: 10, end: 30 }, { start: 100, end: 126 }, { start: 300, end: 310 }]);
  });

  it("stops at the number of clips and at the seconds a player waits for, and keeps the first clip whatever its length", () => {
    expect(FAST_MAX_CLIPS).toBe(12);
    expect(FAST_MAX_SECONDS).toBe(200);
    const many = Array.from({ length: 30 }, (_, i) => ({ start: i * 100, end: i * 100 + 10 }));
    expect(pickStretches([many])).toHaveLength(12);
    const long = [{ start: 0, end: 150 }, { start: 200, end: 260 }, { start: 300, end: 340 }];
    expect(pickStretches([long])).toEqual([{ start: 0, end: 150 }, { start: 300, end: 340 }]);
    expect(pickStretches([[{ start: 0, end: 500 }]])).toEqual([{ start: 0, end: 500 }]);
  });

  it("drops a stretch with no length or no number", () => {
    expect(pickStretches([[{ start: 5, end: 5 }, { start: 9, end: 2 }, { start: Number.NaN, end: 4 }, { start: 1, end: 3 }]])).toEqual([{ start: 1, end: 3 }]);
  });
});

describe("the Rally Finder's core as a file", () => {
  it("is what the page's core gives: public/lab/rf-core.js is generated, never written by hand", () => {
    expect(execFileSync("node", ["scripts/gen-rf-core.mjs", "--check"], { encoding: "utf8" })).toContain("is the page's core");
  });
});
