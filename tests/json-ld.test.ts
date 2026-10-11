import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { jsonLdHtml } from "@/lib/jsonLd";

/**
 * The structured data on the public pages (src/lib/jsonLd.ts). Until 11 October 2026 the pages wrote
 * `JSON.stringify(jsonLd)` into a script tag. A competition name, a series name or a coach's name that
 * holds `</script>` then ended the tag, and the rest of the name ran as the page's own HTML for every
 * visitor: a script there reads the visitor's restore seal and personal link, and becomes them.
 */

/** A name that fits every limit it meets: 40 characters for a player's name, 80 for a competition's. */
const HOSTILE = "</script><img src=x onerror=alert(1)>";

const scriptTag = (html: string) => renderToString(createElement("script", { type: "application/ld+json", dangerouslySetInnerHTML: { __html: html } }));

describe("structured data in a script tag", () => {
  it("the old way lets a name end the tag (the reason for jsonLdHtml)", () => {
    expect(HOSTILE.length).toBeLessThanOrEqual(40);
    const page = scriptTag(JSON.stringify({ name: HOSTILE }));
    expect(page.split("</script>").length - 1).toBe(2);
    expect(page).toContain("<img src=x onerror=alert(1)>");
  });

  it("jsonLdHtml keeps the tag whole, and a reader gets the same value back", () => {
    const data = { "@type": "SportsEvent", name: HOSTILE, organizer: { name: "Ana & Bo <3" }, note: "line\u2028break\u2029here" };
    const html = jsonLdHtml(data);
    expect(html).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(html)).toEqual(data);
    const page = scriptTag(html);
    expect(page.split("</script>").length - 1).toBe(1);
    expect(page).not.toContain("<img");
  });

  it("every dangerouslySetInnerHTML in src/ goes through jsonLdHtml", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const raw: string[] = [];
    for (const f of files(path.resolve(process.cwd(), "src"))) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("dangerouslySetInnerHTML=")) return;
        if (!/dangerouslySetInnerHTML=\{\{ __html: jsonLdHtml\(/.test(line)) raw.push(`${path.relative(process.cwd(), f)}:${i + 1}`);
      });
    }
    expect(raw, "write the tag's text with jsonLdHtml (src/lib/jsonLd.ts)").toEqual([]);
  });
});
