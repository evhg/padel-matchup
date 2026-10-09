import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every word on a screen is readable.
 *
 * `--color-faint` was #8a919c: 2.9:1 on the page, under the 4.5:1 that WCAG AA asks of small text,
 * and it carried every hint, footnote and placeholder in the app. A colour is chosen by eye on a
 * good screen; this file reads the `@theme` block in `src/app/globals.css` and does the arithmetic
 * instead, so a later change cannot quietly drop a text colour below the line.
 */
const css = readFileSync(path.resolve(process.cwd(), "src/app/globals.css"), "utf8");
const theme = css.match(/@theme\s*{([^}]*)}/)?.[1] ?? "";
const tokens = Object.fromEntries([...theme.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2].toLowerCase()]));
const colour = (name: string) => (name === "white" ? "#ffffff" : tokens[name]);

/** WCAG 2 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2 contrast ratio, from 1 (the same colour) to 21 (black on white). */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The colours words are written in, straight on the page or on a card. `accent` is not here on
// purpose: it is a fill, and the only text in it sits on `bg-ink` (13.9:1), which the pairs below check.
const TEXT = ["ink", "ink-soft", "muted", "faint", "court", "danger", "ok", "warn"];
const AA = 4.5;

describe("text contrast", () => {
  it("reads the colour tokens from globals.css", () => {
    // A parser that found nothing would pass every check below.
    for (const name of ["bg", "card", ...TEXT]) expect(tokens[name], name).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("computes the ratio the way WCAG does", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrast("#ffffff", "#777777")).toBe(contrast("#777777", "#ffffff"));
  });

  for (const ground of ["bg", "card"]) {
    it(`keeps every text colour at ${AA}:1 or better on ${ground}`, () => {
      const low = TEXT.map((name) => ({ name, ratio: Math.round(contrast(tokens[name], tokens[ground]) * 100) / 100 })).filter((r) => r.ratio < AA);
      expect(low).toEqual([]);
    });
  }

  it("keeps the text readable on every coloured chip and button in globals.css", () => {
    // Each `@apply` that sets both a fill and a text colour (".chip-open", ".btn-danger", ".btn-secondary")
    // is a pair a reader meets. `hover:bg-…` and other variants are skipped: the lookbehind wants a bare class.
    const pairs = [...css.matchAll(/@apply ([^;]+);/g)]
      .map((m) => ({ bg: m[1].match(/(?<![\w:-])bg-([\w-]+)/)?.[1], text: m[1].match(/(?<![\w:-])text-([\w-]+)/g)?.map((t) => t.slice(5)).find((t) => colour(t)) }))
      .filter((p): p is { bg: string; text: string } => Boolean(p.bg && p.text && colour(p.bg)));
    expect(pairs.length).toBeGreaterThanOrEqual(8);
    const low = pairs.map((p) => ({ ...p, ratio: Math.round(contrast(colour(p.text), colour(p.bg)) * 100) / 100 })).filter((p) => p.ratio < AA);
    expect(low).toEqual([]);
  });
});
