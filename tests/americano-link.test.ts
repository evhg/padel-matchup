import { describe, expect, it } from "vitest";
import { maxCourtsFor, parseGenLink, rotationLength } from "@/lib/domain/americano";

/**
 * A shared americano link. The organiser's schedule had no address of its own, so it could not be
 * sent to the eight people in it. Everything here arrives from a stranger's URL.
 */
describe("a shared americano link", () => {
  it("says nothing for a plain visit", () => {
    expect(parseGenLink({})).toBeNull();
    expect(parseGenLink({ seed: "7" })).toBeNull();
    // Three names are not a field; the engine starts at four.
    expect(parseGenLink({ names: "Ana,Pim,Noi" })).toBeNull();
  });

  it("reads the eight names an organiser shared", () => {
    const link = parseGenLink({ names: "Kristina,Pim,Noi,Jakob,Marcus,Ana,Tom,Lena", courts: "2", rounds: "7", seed: "3" });
    expect(link).toEqual({ n: 8, courts: 2, rounds: 7, seed: 3, names: ["Kristina", "Pim", "Noi", "Jakob", "Marcus", "Ana", "Tom", "Lena"] });
  });

  it("lets the names decide how many play, over any n in the link", () => {
    expect(parseGenLink({ n: "20", names: "A,B,C,D" })?.n).toBe(4);
  });

  it("fills the rounds a perfect rotation gives when the link names none", () => {
    // Eight players on two courts partner everyone exactly once in seven rounds.
    expect(rotationLength(8)).toBe(7);
    expect(maxCourtsFor(8)).toBe(2);
    expect(parseGenLink({ n: "8" })).toEqual({ n: 8, courts: 2, rounds: 7, seed: 1, names: [] });
  });

  it("clamps every number a stranger can send", () => {
    expect(parseGenLink({ n: "999" })?.n).toBe(64);
    expect(parseGenLink({ n: "1" })?.n).toBe(4);
    // Four players fill one court, whatever the link asks for.
    expect(parseGenLink({ n: "4", courts: "9" })?.courts).toBe(1);
    expect(parseGenLink({ n: "8", rounds: "500" })?.rounds).toBe(40);
    expect(parseGenLink({ n: "8", rounds: "0" })?.rounds).toBe(1);
    expect(parseGenLink({ n: "8", seed: "99999" })?.seed).toBe(1);
  });

  it("ignores what is not a number, and takes the first of a repeated key", () => {
    expect(parseGenLink({ n: "8", seed: "abc" })?.seed).toBe(1);
    expect(parseGenLink({ n: "8", seed: "-3" })?.seed).toBe(1);
    expect(parseGenLink({ n: ["8", "64"] })?.n).toBe(8);
  });

  it("cuts a pasted club list to the sixty-four the browser can draw", () => {
    const many = Array.from({ length: 200 }, (_, i) => `P${i}`).join(",");
    const link = parseGenLink({ names: many });
    expect(link?.names).toHaveLength(64);
    expect(link?.n).toBe(64);
  });
});
