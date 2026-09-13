import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";

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

const raw = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(readFileSync(path.resolve(process.cwd(), "messages", `${l}.json`), "utf8")) as Record<string, unknown>])) as Record<(typeof LOCALES)[number], Record<string, unknown>>;

const messages = Object.fromEntries(LOCALES.map((l) => [l, flatten(raw[l])])) as Record<(typeof LOCALES)[number], Map<string, unknown>>;

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

/**
 * Notifications are the one place a broken string is invisible until it is in somebody's hand: nothing
 * renders it on a screen first. next-intl answers a variable it was not given with the message key, so
 * `{spots}` — asked for by the club programme notice and supplied by nobody — went out as the literal
 * text "push.clubMatchBody". These two tests are the reason that cannot happen twice.
 */
describe("what a notification may say", () => {
  /** Exactly the bag `ctx()` in src/lib/notify.ts builds, plus the extras each sender adds by name. */
  const BAG = {
    day: "Mon 14 Sep",
    time: "18:00",
    venue: "Thanyapura · Court 3",
    names: "Ana, Bea",
    count: 2,
    capacity: 4,
    spots: "2 spots left",
    club: "Thanyapura",
    group: "Tuesday crew",
    organizer: "Ana",
    name: "Bea",
    title: "Padel Monday",
    app: "Kicksmash",
    code: "1234",
  };
  const PLACEHOLDER = /\{\s*([A-Za-z0-9_]+)\s*(?=[},])/g;
  const notifyKeys = (l: (typeof LOCALES)[number]) => [...messages[l].keys()].filter((k) => k.startsWith("push.") || k.startsWith("email."));

  it("asks for no variable the notifier does not supply", () => {
    for (const l of LOCALES) {
      const unknown: string[] = [];
      for (const key of notifyKeys(l)) {
        const value = messages[l].get(key);
        if (typeof value !== "string") continue;
        for (const [, v] of value.matchAll(PLACEHOLDER)) if (!(v in BAG)) unknown.push(`${key}: {${v}}`);
      }
      expect({ locale: l, unknown }).toEqual({ locale: l, unknown: [] });
    }
  });

  it("renders to real words in every language, never to its own key", () => {
    for (const l of LOCALES) {
      const t = createTranslator({ locale: l, messages: raw[l] as never, onError: () => undefined });
      const broken: string[] = [];
      for (const key of notifyKeys(l)) {
        const out = t(key as never, BAG as never) as string;
        if (out === key || out.includes("{")) broken.push(`${key} → ${out}`);
      }
      expect({ locale: l, broken }).toEqual({ locale: l, broken: [] });
    }
  });
});
