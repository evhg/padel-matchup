import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { htmlTextAttr, TEXT_SIZE_COOKIE, textSizeCookie, textSizeOf } from "@/lib/textSize";

/**
 * "Bigger text": the cookie, the attribute the root layout puts on <html>, and the stylesheet rule
 * that answers it. The three live in three files and only work together, so this file checks the
 * seams: a renamed attribute or a chip back in px would leave the switch working and the text small.
 */
const css = readFileSync(path.resolve(process.cwd(), "src/app/globals.css"), "utf8");

describe("bigger text", () => {
  it("reads only the word it writes", () => {
    expect(textSizeOf("big")).toBe("big");
    for (const v of [undefined, null, "", "BIG", "huge", "normal", "big; path=/"]) expect(textSizeOf(v), String(v)).toBe("normal");
  });

  it("marks <html> only when the text is bigger", () => {
    expect(htmlTextAttr("big")).toBe("big");
    expect(htmlTextAttr("normal")).toBeUndefined();
  });

  it("writes a cookie the layout can read back, and deletes it when switched off", () => {
    const on = textSizeCookie("big");
    expect(on.startsWith(`${TEXT_SIZE_COOKIE}=big;`)).toBe(true);
    expect(on).toContain("path=/");
    expect(on).toContain("max-age=31536000");
    expect(on).toContain("samesite=lax");
    // What the switch writes is what the layout reads: the value between "=" and ";".
    expect(textSizeOf(on.split(";")[0].split("=")[1])).toBe("big");
    const off = textSizeCookie("normal");
    expect(off).toContain("max-age=0");
    expect(textSizeOf(off.split(";")[0].split("=")[1])).toBe("normal");
  });

  it("raises the root to 18px and the chips to 13px or more in globals.css", () => {
    const rule = css.match(/html\[data-text="big"\]\s*{([^}]*)}/)?.[1] ?? "";
    const root = Number(rule.match(/font-size:\s*(\d+)px/)?.[1]);
    expect(root).toBe(18);
    // The chip's size is the --text-2xs token in rem, so the chip grows with the root.
    expect(css).toMatch(/@utility chip\s*{[^}]*\btext-2xs\b/);
    const chipRem = Number(rule.match(/--text-2xs:\s*([\d.]+)rem/)?.[1]);
    expect(root * chipRem).toBeGreaterThanOrEqual(13);
  });
});
