import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Every string in every locale: the three message files carry identical key sets and no empty strings. */
const LOCALES = ["en", "ru", "es"] as const;

function flatten(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      for (const [ck, cv] of flatten(v, prefix ? `${prefix}.${k}` : k)) out.set(ck, cv);
    }
  } else {
    out.set(prefix, value);
  }
  return out;
}

const messages = Object.fromEntries(LOCALES.map((l) => [l, flatten(JSON.parse(readFileSync(path.resolve(process.cwd(), "messages", `${l}.json`), "utf8")))])) as Record<(typeof LOCALES)[number], Map<string, unknown>>;

describe("messages", () => {
  it("ru and es carry exactly the keys en carries", () => {
    const en = [...messages.en.keys()].sort();
    for (const l of ["ru", "es"] as const) {
      const keys = [...messages[l].keys()].sort();
      const missing = en.filter((k) => !messages[l].has(k));
      const extra = keys.filter((k) => !messages.en.has(k));
      expect({ locale: l, missing, extra }).toEqual({ locale: l, missing: [], extra: [] });
    }
  });

  it("no message is empty", () => {
    for (const l of LOCALES) {
      const empty = [...messages[l]].filter(([, v]) => typeof v !== "string" || v.trim() === "").map(([k]) => k);
      expect({ locale: l, empty }).toEqual({ locale: l, empty: [] });
    }
  });
});
