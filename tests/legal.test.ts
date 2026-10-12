import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import { LOCALE_COOKIE } from "@/i18n/config";
import { BACKUP_KEEP_DAYS } from "@/lib/backup";
import { DISPOSABLE_AFTER_DAYS } from "@/lib/domain/disposable";
import { RATE_ROWS_KEEP_DAYS } from "@/lib/domain/ratelimit";
import { LEGAL_OPERATOR, legalDate, legalValues } from "@/lib/legal";
import { hintCookieOptions } from "@/lib/hintCookie";
import { BY_NAME_COOKIE, HAS_ID_COOKIE, manageCookieName, ONE_YEAR, PLAYER_COOKIE } from "@/lib/session";
import { COACH_SOURCE_COOKIE, SOURCE_COOKIE, SOURCE_MAX_AGE } from "@/lib/source";
import { TEXT_SIZE_COOKIE, textSizeCookie } from "@/lib/textSize";
import { CHALLENGE_COOKIE, challengeCookie } from "@/lib/passkeys/webauthn";

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
    const cookies = [PLAYER_COOKIE, HAS_ID_COOKIE, BY_NAME_COOKIE, LOCALE_COOKIE, manageCookieName(""), SOURCE_COOKIE, COACH_SOURCE_COOKIE, notMineCookie!, TEXT_SIZE_COOKIE, CHALLENGE_COOKIE];
    for (const l of LOCALES) {
      const text = render(l, "privacy.cookiesBody");
      expect({ locale: l, missing: cookies.filter((c) => !text.includes(c)) }).toEqual({ locale: l, missing: [] });
    }
  });

  it("gives each cookie the lifetime the code sets, in every language", () => {
    // The words for a lifetime, per language. A lifetime that is not here has no words on the page
    // yet: change the copy first, then add it here.
    const WORDS: Record<number, Record<(typeof LOCALES)[number], string>> = {
      [365 * 24 * 3600]: { en: "One year", ru: "Один год", es: "Un año" },
      [24 * 3600]: { en: "One day", ru: "Один день", es: "Un día" },
      [5 * 60]: { en: "Five minutes", ru: "Пять минут", es: "Cinco minutos" },
    };
    const textSizeAge = Number(/max-age=(\d+)/.exec(textSizeCookie("big"))?.[1]);
    const lifetimes: [string, number][] = [
      [PLAYER_COOKIE, ONE_YEAR],
      [BY_NAME_COOKIE, ONE_YEAR],
      [manageCookieName(""), ONE_YEAR],
      [HAS_ID_COOKIE, hintCookieOptions().maxAge],
      [SOURCE_COOKIE, SOURCE_MAX_AGE],
      [COACH_SOURCE_COOKIE, SOURCE_MAX_AGE],
      [TEXT_SIZE_COOKIE, textSizeAge],
      [CHALLENGE_COOKIE, challengeCookie().maxAge],
    ];
    for (const l of LOCALES) {
      const lines = render(l, "privacy.cookiesBody").split("\n");
      for (const [cookie, seconds] of lifetimes) {
        const words = WORDS[seconds]?.[l];
        expect(words, `${cookie} lasts ${seconds} s, which the page has no words for`).toBeDefined();
        expect(lines.find((x) => x.includes(cookie)), `${l}: ${cookie}`).toContain(words);
      }
    }
  });

  it("gives the figures the code enforces, in every language", () => {
    for (const l of LOCALES) {
      const keep = render(l, "privacy.keepBody");
      for (const n of [DISPOSABLE_AFTER_DAYS, RATE_ROWS_KEEP_DAYS, BACKUP_KEEP_DAYS]) expect(keep, `${l}: ${n}`).toMatch(new RegExp(`(^|\\D)${n}\\s`));
      expect(render(l, "privacy.ipBody")).toMatch(new RegExp(`(^|\\D)${RATE_ROWS_KEEP_DAYS}\\s`));
    }
  });

  it("gives a deleted account about the days the backups keep, never an exact date", () => {
    // Until 10 October 2026 an old day left the backup folder but not the repository's history, so the
    // page promised no end at all. Since the owner's decision of that day, runBackup rebuilds the history
    // each night with only BACKUP_KEEP_DAYS of files (tests/backup-history.test.ts), and GitHub removes
    // the older, unreachable copies at a time it does not give. So the page says "about" and names GitHub.
    const ABOUT = { en: "about", ru: "примерно", es: "unos" } as const;
    for (const l of LOCALES) {
      expect(messagesOf(l).privacy.deleteBody, l).toContain("{backupDays");
      const del = render(l, "privacy.deleteBody");
      expect(del, l).toMatch(new RegExp(`${ABOUT[l]}\\D*${BACKUP_KEEP_DAYS}\\s`));
      expect(del, l).toContain("GitHub");
      expect(render(l, "privacy.keepBody"), l).toContain("GitHub");
    }
  });

  it("says the backups keep about the kept days, not exactly, and that GitHub deletes the older copies later", () => {
    // The prune keeps the cutoff day (src/lib/backup.ts), so the folder holds BACKUP_KEEP_DAYS + 1 nights,
    // and an old commit stays readable by its id until GitHub removes it, at a time it does not give.
    // Until 11 October 2026 the line said "only the last 60 days".
    const ABOUT = { en: "about the last", ru: "примерно", es: "aproximadamente" } as const;
    const LATER = { en: "GitHub deletes them later, and it does not say when", ru: "GitHub удаляет их позже и не говорит когда", es: "GitHub las borra más adelante y no dice cuándo" } as const;
    for (const l of LOCALES) {
      const backups = render(l, "privacy.keepBody").split("\n").find((x) => x.includes("GitHub"))!;
      expect(backups, l).toMatch(new RegExp(`${ABOUT[l]}\\D*${BACKUP_KEEP_DAYS}\\s`));
      expect(backups, l).not.toMatch(/only the last|только последн|solo guarde/);
      expect(backups, l).toContain(LATER[l]);
    }
  });

  it("says what a phone that remembers you keeps, never a face, a fingerprint or a password, and that deletion takes it", () => {
    // Passkeys, the owner's decision of 12 October 2026 (DECIDING rule 39): the passkeys table keeps a
    // public key, a label and two dates (src/db/schema/players.ts), and `anonymizePlayer` drops them.
    const KEEPS = {
      en: ["public key", "the phone and the browser", "the day you saved it", "the day you last used it", "Never your face, your fingerprint or a password"],
      ru: ["открытый ключ", "телефон и браузер", "день сохранения", "день последнего входа", "Никогда — ваше лицо, отпечаток пальца или пароль"],
      es: ["clave pública", "el teléfono y el navegador", "el día en que la guardaste", "el día en que la usaste por última vez", "Nunca tu cara, tu huella ni una contraseña"],
    } as const;
    const DELETED = { en: "the phones that remember you", ru: "телефоны, которые вас помнят", es: "los teléfonos que te recuerdan" } as const;
    for (const l of LOCALES) {
      const line = render(l, "privacy.storeBody").split("\n").find((x) => x.includes("passkey"));
      expect(line, l).toBeDefined();
      for (const words of KEEPS[l]) expect(line, `${l}: ${words}`).toContain(words);
      expect(render(l, "privacy.deleteBody"), l).toContain(DELETED[l]);
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
