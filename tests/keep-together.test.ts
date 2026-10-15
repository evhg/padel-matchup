import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { KeepTogether } from "@/components/KeepTogether";
import { renderIn } from "./helpers/render";

/**
 * The share page's line and the match page's venue line at 390 px: "Court 3" broke into "Court" and "3"
 * on two lines (15 October 2026). Each short part is one inline block, and the words read as the joined line.
 */
describe("a line of parts kept whole", () => {
  const html = renderIn("en", createElement(KeepTogether, { parts: ["Thu, Oct 15", "05:46", "", "Club Padel Test", "Court 3"] }));
  const text = html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

  it("reads as the joined line, an empty part left out", () => {
    expect(text).toBe("Thu, Oct 15 · 05:46 · Club Padel Test · Court 3");
  });

  it("holds each short part in one inline block, never wider than the line, so a line breaks between parts, never inside a short one", () => {
    expect(html.match(/<span class="inline-block max-w-full">([^<]*)<\/span>/g)?.map((s) => s.replace(/<[^>]+>/g, ""))).toEqual(["Thu, Oct 15", "05:46", "Club Padel Test", "Court 3"]);
  });

  it("leaves a long part as plain words, so it wraps, a long word breaks, and a line clamp counts its lines", () => {
    // As a block, "PadelhausSukhumvit39Bangkok" kept its whole width: cut with no ellipsis on the match
    // page, and the share page wider than 390 px (review, 15 October 2026).
    const long = renderIn("en", createElement(KeepTogether, { parts: ["PadelhausSukhumvit39Bangkok", "Court 2"] }));
    expect(long.replace(/<!-- -->/g, "")).toBe('PadelhausSukhumvit39Bangkok · <span class="inline-block max-w-full">Court 2</span>');
    const club = renderIn("en", createElement(KeepTogether, { parts: ["Padel Phuket @ Blue Tree", "Court 12"] }));
    expect(club.replace(/<!-- -->/g, "")).toBe('Padel Phuket @ Blue Tree · <span class="inline-block max-w-full">Court 12</span>');
  });
});
