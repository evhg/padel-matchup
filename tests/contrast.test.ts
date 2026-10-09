import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every word on a screen is readable, in the light theme and in the dark one.
 *
 * `--color-faint` was #8a919c: 2.9:1 on the page, under the 4.5:1 that WCAG AA asks of small text,
 * and it carried every hint, footnote and placeholder in the app. A colour is chosen by eye on a
 * good screen; this file reads the `@theme` block in `src/app/globals.css` (the light set) and the
 * `prefers-color-scheme: dark` block after it (the dark set, which gives the same names new values),
 * and does the arithmetic instead, so a later change cannot quietly drop a text colour below the line.
 */
const css = readFileSync(path.resolve(process.cwd(), "src/app/globals.css"), "utf8");
const readTokens = (block: string) => Object.fromEntries([...block.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2].toLowerCase()]));
const light: Record<string, string> = readTokens(css.match(/@theme\s*{([^}]*)}/)?.[1] ?? "");
// The dark block only names what changes; a name it leaves out keeps its light value.
const darkOnly: Record<string, string> = readTokens(css.match(/@media screen and \(prefers-color-scheme: dark\)\s*{\s*:root[^{]*{([^}]*)}/)?.[1] ?? "");
const dark: Record<string, string> = { ...light, ...darkOnly };
const THEMES = { light, dark };
const colourIn = (tokens: Record<string, string>) => (name: string) => (name === "white" ? "#ffffff" : tokens[name]);

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
// purpose: it is a fill, and the text in it is `night`, which the fills below check.
const TEXT = ["ink", "ink-soft", "muted", "faint", "court", "danger", "ok", "warn"];
const AA = 4.5;
/** Fills with words on them that no `@apply` names: the picked chip, the avatar, the step done, the lime button and score. */
const FILLS: [text: string, ground: string][] = [
  ["on-ink", "ink"],
  ["on-ink", "ink-soft"],
  ["on-ink", "ok"],
  ["night", "accent"],
  ["night", "accent-deep"],
];
const rounded = <T extends { ratio: number }>(r: T) => ({ ...r, ratio: Math.floor(r.ratio * 100) / 100 });

describe("text contrast", () => {
  it("reads the colour tokens from globals.css, light and dark", () => {
    // A parser that found nothing would pass every check below.
    for (const name of ["bg", "card", "on-ink", "night", ...TEXT]) expect(light[name], name).toMatch(/^#[0-9a-f]{6}$/);
    // The dark set must really redefine the ground and every text colour, or "dark" is the light set again.
    for (const name of ["bg", "card", "on-ink", ...TEXT]) expect(darkOnly[name], `dark ${name}`).toMatch(/^#[0-9a-f]{6}$/);
    expect(darkOnly.night, "night is the same in both themes").toBeUndefined();
  });

  it("computes the ratio the way WCAG does", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrast("#ffffff", "#777777")).toBe(contrast("#777777", "#ffffff"));
  });

  for (const [theme, tokens] of Object.entries(THEMES)) {
    for (const ground of ["bg", "card"]) {
      it(`keeps every text colour at ${AA}:1 or better on ${ground} (${theme})`, () => {
        const low = TEXT.map((name) => ({ name, ratio: contrast(tokens[name], tokens[ground]) })).filter((r) => r.ratio < AA).map(rounded);
        expect(low).toEqual([]);
      });
    }

    it(`keeps the words on every fill readable (${theme})`, () => {
      const low = FILLS.map(([text, bg]) => ({ text, bg, ratio: contrast(tokens[text], tokens[bg]) })).filter((r) => r.ratio < AA).map(rounded);
      expect(low).toEqual([]);
    });

    it(`keeps the text readable on every coloured chip and button in globals.css (${theme})`, () => {
      // Each `@apply` that sets both a fill and a text colour (".chip-open", ".btn-danger", ".btn-secondary")
      // is a pair a reader meets. `hover:bg-…` and other variants are skipped: the lookbehind wants a bare class.
      const colour = colourIn(tokens);
      const pairs = [...css.matchAll(/@apply ([^;]+);/g)]
        .map((m) => ({ bg: m[1].match(/(?<![\w:-])bg-([\w-]+)/)?.[1], text: m[1].match(/(?<![\w:-])text-([\w-]+)/g)?.map((t) => t.slice(5)).find((t) => colour(t)) }))
        .filter((p): p is { bg: string; text: string } => Boolean(p.bg && p.text && colour(p.bg)));
      expect(pairs.length).toBeGreaterThanOrEqual(8);
      const low = pairs.map((p) => ({ ...p, ratio: contrast(colour(p.text), colour(p.bg)) })).filter((p) => p.ratio < AA).map(rounded);
      expect(low).toEqual([]);
    });
  }
});

/**
 * White that does not turn with the theme. `bg-white` was the card in thirty-four files and
 * `text-white` the words on every ink fill; in the dark theme the first is a white box on a navy page
 * and the second white on a light grey. Each is `bg-card` or `text-on-ink` now. The few that stay
 * are white on purpose: a QR code a scanner must read, the WhatsApp and Telegram buttons in their own
 * colours, the code blocks on `bg-night`, the owner's status dots. Anything new must say why here.
 */
const KEEP_WHITE: Record<string, number> = {
  "src/components/ShareSheet.tsx": 3, // the QR box, and the WhatsApp and Telegram buttons
  "src/components/PersonalLinkCard.tsx": 1, // the QR box
  "src/components/coach/CoachStudents.tsx": 1, // the QR box
  "src/components/coach/PromptPayQr.tsx": 2, // the bank's QR picture and our QR box
  "src/components/EmbedSnippet.tsx": 1, // code on bg-night
  "src/app/developers/page.tsx": 2, // code on bg-night
  "src/app/admin/page.tsx": 2, // words on the fixed status colours
};
// Pictures, mail and the club's TV draw their own colours and never follow the theme.
const OWN_COLOURS = /opengraph-image|\/story\/|\/api\/icon\/|apple-icon|\/tv\/|\/email\//;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.tsx$/.test(e.name) ? [p] : [];
  });
}

describe("colours that follow the theme", () => {
  it("uses bg-white and text-white only where white is meant in both themes", () => {
    const root = process.cwd();
    const found: Record<string, number> = {};
    for (const file of sources(path.join(root, "src"))) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (OWN_COLOURS.test(rel)) continue;
      const n = (readFileSync(file, "utf8").match(/(?<![\w-])(bg|text)-white\b/g) ?? []).length;
      if (n) found[rel] = n;
    }
    expect(found).toEqual(KEEP_WHITE);
  });
});
