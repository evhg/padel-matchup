import { describe, expect, it } from "vitest";
import { EMBED_SIZES, embedHtml, embedPath, parseEmbedTarget } from "@/lib/embed";

const BASE = "https://kicksma.sh";

describe("embeds", () => {
  it("recognises match and board links on the own host and the short domain, nothing else", () => {
    expect(parseEmbedTarget("https://kicksma.sh/Ab9Z", BASE)).toEqual({ kind: "match", code: "Ab9Z" });
    expect(parseEmbedTarget("https://kicksma.sh/v/club-nine", BASE)).toEqual({ kind: "board", slug: "club-nine" });
    expect(parseEmbedTarget("https://kicksma.sh/v/club-nine/ranking", BASE)).toEqual({ kind: "board", slug: "club-nine" });
    expect(parseEmbedTarget("https://kicksma.sh/embed/match/Ab9Z", BASE)).toEqual({ kind: "match", code: "Ab9Z" });
    expect(parseEmbedTarget("http://localhost:3001/Q2wE", "http://localhost:3001")).toEqual({ kind: "match", code: "Q2wE" });
    expect(parseEmbedTarget("https://evil.example/Ab9Z", BASE)).toBeNull();
    expect(parseEmbedTarget("https://kicksma.sh/developers", BASE)).toBeNull();
    expect(parseEmbedTarget("https://kicksma.sh/v/Not Valid", BASE)).toBeNull();
    expect(parseEmbedTarget("not a url", BASE)).toBeNull();
  });
  it("builds a safe iframe snippet", () => {
    const html = embedHtml(BASE, { kind: "board", slug: "club-nine" }, 'Padel at <Club "Nine"> & co');
    expect(html).toContain(`src="${BASE}/embed/board/club-nine"`);
    expect(html).toContain(`width="${EMBED_SIZES.board.width}"`);
    expect(html).not.toMatch(/[<>"]Nine/);
    expect(html).toContain('title="Padel at Club Nine  co"');
    expect(embedPath({ kind: "match", code: "Ab9Z" })).toBe("/embed/match/Ab9Z");
  });
});
