import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODE_ALPHABET, isValidShareCode, newShareCode } from "@/lib/codes";

describe("match codes and page names", () => {
  it("makes a code of four characters from the alphabet with no look-alikes", () => {
    for (let i = 0; i < 50; i++) expect(isValidShareCode(newShareCode())).toBe(true);
    for (const c of "0O1lI") expect(CODE_ALPHABET).not.toContain(c);
  });

  // A match is at /{code} and a page is at /{name}: a page wins, so a match whose code spelled a page's name
  // could never be opened. /play and /film are safe only because the alphabet has no "l". A new page of four
  // characters needs one of 0, O, 1, l, I in its name, and this test says so before a player finds out.
  it("has no page of four characters whose name could be a match code", () => {
    const pages = readdirSync("src/app", { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.length === 4 && /^[A-Za-z0-9]+$/.test(d.name))
      .map((d) => d.name);
    expect(pages).toContain("film");
    expect(pages.filter(isValidShareCode)).toEqual([]);
  });
});
