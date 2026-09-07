import { describe, expect, it } from "vitest";
import { localeAlternates, localePath } from "@/lib/seo";

describe("language paths", () => {
  it("English stays plain, the others get a prefix, the root has no trailing slash", () => {
    expect(localePath("/levels", "en")).toBe("/levels");
    expect(localePath("/levels", "ru")).toBe("/ru/levels");
    expect(localePath("/", "es")).toBe("/es");
    expect(localePath("/", "en")).toBe("/");
  });
  it("the canonical is the variant being served and the alternates name every language plus x-default", () => {
    expect(localeAlternates("/phuket", "ru")).toEqual({ canonical: "/ru/phuket", languages: { en: "/phuket", ru: "/ru/phuket", es: "/es/phuket", "x-default": "/phuket" } });
    expect(localeAlternates("/phuket", "en").canonical).toBe("/phuket");
    expect(localeAlternates("/phuket", "de").canonical).toBe("/phuket");
  });
});
