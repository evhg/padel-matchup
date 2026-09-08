import { describe, expect, it } from "vitest";
import { GROUP_NAMES, groupNameSuggestions, suggestGroupName } from "@/lib/domain/groupNames";

describe("default group names", () => {
  it("each language has its own dozen, all distinct, and the pick is stable per match", () => {
    for (const pool of Object.values(GROUP_NAMES)) {
      expect(pool.length).toBeGreaterThanOrEqual(12);
      expect(new Set(pool).size).toBe(pool.length);
    }
    expect(suggestGroupName("en", "XNX5")).toBe(suggestGroupName("en", "XNX5"));
    expect(GROUP_NAMES.en).toContain(suggestGroupName("en", "XNX5"));
    expect(GROUP_NAMES.ru).toContain(suggestGroupName("ru", "XNX5"));
    expect(GROUP_NAMES.es).toContain(suggestGroupName("es", "XNX5"));
    expect(GROUP_NAMES.en).toContain(suggestGroupName("de", "XNX5"));
    const six = groupNameSuggestions("en", "PLAY");
    expect(six).toHaveLength(6);
    expect(new Set(six).size).toBe(6);
    expect(six[1]).toBe(suggestGroupName("en", "PLAY", 1));
  });
});
