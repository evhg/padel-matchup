import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import { LOCALE_COOKIE } from "@/i18n/config";
import { BACKUP_KEEP_DAYS } from "@/lib/backup";
import { DISPOSABLE_AFTER_DAYS } from "@/lib/domain/disposable";
import { RATE_ROWS_KEEP_DAYS } from "@/lib/domain/ratelimit";
import { LEGAL_OPERATOR, legalDate, legalValues } from "@/lib/legal";
import { HAS_ID_COOKIE, manageCookieName, PLAYER_COOKIE } from "@/lib/session";
import { COACH_SOURCE_COOKIE, SOURCE_COOKIE } from "@/lib/source";

/**
 * /privacy promises things about the code: which cookies it sets, how long it keeps what. A promise
 * in a message file and a constant in the code drift apart the day somebody changes one of them, and
 * nothing on the screen says so. These tests render the pages' copy in every language, with the
 * values the pages pass, and look for each cookie the code sets and each figure the code enforces.
 */
const LOCALES = ["en", "ru", "es"] as const;
const messagesOf = (l: string) => JSON.parse(readFileSync(path.resolve(process.cwd(), "messages", `${l}.json`), "utf8"));
const render = (l: (typeof LOCALES)[number], key: string) => createTranslator({ locale: l, messages: messagesOf(l) })(key as never, legalValues(l) as never) as string;

/** The "Not me" cookie's name, read from the component that owns it (a client-side cookie, set by its buttons). */
const notMineCookie = readFileSync(path.resolve(process.cwd(), "src/components/SameNameCard.tsx"), "utf8").match(/NOT_MINE_COOKIE = "([^"]+)"/)?.[1];

describe("the privacy page tells the truth about the code", () => {
  it("names every cookie the app sets, in every language", () => {
    expect(notMineCookie).toBe("ks_notmine");
    const cookies = [PLAYER_COOKIE, HAS_ID_COOKIE, LOCALE_COOKIE, manageCookieName(""), SOURCE_COOKIE, COACH_SOURCE_COOKIE, notMineCookie!];
    for (const l of LOCALES) {
      const text = render(l, "privacy.cookiesBody");
      expect({ locale: l, missing: cookies.filter((c) => !text.includes(c)) }).toEqual({ locale: l, missing: [] });
    }
  });

  it("gives the figures the code enforces, in every language", () => {
    for (const l of LOCALES) {
      const keep = render(l, "privacy.keepBody");
      for (const n of [DISPOSABLE_AFTER_DAYS, RATE_ROWS_KEEP_DAYS, BACKUP_KEEP_DAYS]) expect(keep, `${l}: ${n}`).toMatch(new RegExp(`(^|\\D)${n}\\s`));
      expect(render(l, "privacy.ipBody")).toMatch(new RegExp(`(^|\\D)${RATE_ROWS_KEEP_DAYS}\\s`));
    }
  });

  it("promises no end date for a backup, because the repository's history keeps every copy", () => {
    // runBackup prunes an old day with the GitHub contents API, and that is a new commit: the file
    // leaves the folder, not the history (src/lib/backup.ts). Until 9 October 2026 the page said the
    // copies "expire". The days a file stays are fine to give; a date when you are gone from them is not.
    for (const l of LOCALES) {
      const m = messagesOf(l).privacy;
      expect(m.deleteBody, l).not.toContain("{backupDays");
      expect(render(l, "privacy.keepBody"), l).toContain("GitHub");
    }
  });

  it("names the operator and the date, and no personal address", () => {
    for (const l of LOCALES) {
      for (const key of ["privacy.whoBody", "terms.whoBody"]) expect(render(l, key)).toContain(LEGAL_OPERATOR);
      expect(render(l, "privacy.updated")).toContain(legalDate(l));
      // The contact is the feedback form (owner's decision, 9 October 2026): no email address anywhere on either page.
      const m = messagesOf(l);
      const all = JSON.stringify([m.privacy, m.terms]);
      expect(all).not.toMatch(/@/);
    }
  });
});

describe("the date on the pages", () => {
  it("reads in the reader's language, whatever the machine's time zone", () => {
    expect(legalDate("en", "2026-10-09")).toBe("9 October 2026");
    expect(legalDate("ru", "2026-10-09")).toBe("9 октября 2026 г.");
    expect(legalDate("es", "2026-10-09")).toBe("9 de octubre de 2026");
    // An unknown locale falls back to English rather than to the machine's own.
    expect(legalDate("xx", "2026-01-01")).toBe("1 January 2026");
  });
});
