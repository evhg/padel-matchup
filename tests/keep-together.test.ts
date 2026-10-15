import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { KeepTogether } from "@/components/KeepTogether";
import { renderIn } from "./helpers/render";

/**
 * The share page's line and the match page's venue line at 390 px: "Court 3" broke into "Court" and "3"
 * on two lines (15 October 2026). Each part is one inline block, and the words read as the joined line.
 */
describe("a line of parts kept whole", () => {
  const html = renderIn("en", createElement(KeepTogether, { parts: ["Thu, Oct 15", "05:46", "", "Club Padel Test", "Court 3"] }));
  const text = html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

  it("reads as the joined line, an empty part left out", () => {
    expect(text).toBe("Thu, Oct 15 · 05:46 · Club Padel Test · Court 3");
  });

  it("holds each part in one inline block, so a line breaks between parts, never inside a short one", () => {
    expect(html.match(/<span class="inline-block">([^<]*)<\/span>/g)?.map((s) => s.replace(/<[^>]+>/g, ""))).toEqual(["Thu, Oct 15", "05:46", "Club Padel Test", "Court 3"]);
  });
});
