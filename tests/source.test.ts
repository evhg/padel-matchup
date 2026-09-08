import { describe, expect, it } from "vitest";
import { cleanSource, taggedUrl } from "@/lib/source";

describe("link sources", () => {
  it("keeps short lowercase tokens and drops everything else", () => {
    expect(cleanSource("ig")).toBe("ig");
    expect(cleanSource(" IG ")).toBe("ig");
    expect(cleanSource("poster-2")).toBe("poster-2");
    expect(cleanSource("")).toBeNull();
    expect(cleanSource(undefined)).toBeNull();
    expect(cleanSource("<script>")).toBeNull();
    expect(cleanSource("a".repeat(17))).toBeNull();
  });
  it("tags a link for a story sticker", () => {
    expect(taggedUrl("https://kicksma.sh/PLAY", "ig")).toBe("https://kicksma.sh/PLAY?s=ig");
    expect(taggedUrl("https://kicksma.sh/PLAY?x=1", "ig")).toBe("https://kicksma.sh/PLAY?x=1&s=ig");
  });
});
