import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import { LOCALE_COOKIE } from "@/i18n/config";
import { BACKUP_KEEP_DAYS } from "@/lib/backup";
import { DISPOSABLE_AFTER_DAYS } from "@/lib/domain/disposable";
import { RATE_ROWS_KEEP_DAYS } from "@/lib/domain/ratelimit";
import { PARTNER_WINDOW_MS } from "@/lib/domain/refill";
import { LEGAL_OPERATOR, legalDate, legalValues } from "@/lib/legal";
import { hintCookieOptions } from "@/lib/hintCookie";
import { BY_NAME_COOKIE, HAS_ID_COOKIE, manageCookieName, ONE_YEAR, PLAYER_COOKIE, SIGNED_OUT_COOKIE } from "@/lib/session";
import { RENEW_EVERY_DAYS } from "@/lib/domain/browserSession";
import { COACH_SOURCE_COOKIE, SOURCE_COOKIE, SOURCE_MAX_AGE } from "@/lib/source";
import { TEXT_SIZE_COOKIE, textSizeCookie } from "@/lib/textSize";
import { CHALLENGE_COOKIE, challengeCookie } from "@/lib/passkeys/webauthn";
import { KIND_DEFAULTS, SENDERS } from "@/lib/domain/noticeKinds";

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
    const cookies = [PLAYER_COOKIE, HAS_ID_COOKIE, BY_NAME_COOKIE, SIGNED_OUT_COOKIE, LOCALE_COOKIE, manageCookieName(""), SOURCE_COOKIE, COACH_SOURCE_COOKIE, notMineCookie!, TEXT_SIZE_COOKIE, CHALLENGE_COOKIE];
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
      [SIGNED_OUT_COOKIE, ONE_YEAR],
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

  it("says that each phone that starts to remember you is told to you, and on your channel only while match changes are on", () => {
    // The owner, 28 October 2026, with the autofill on the own name field: a saved passkey sends the
    // notice "A phone now signs you in: <label>. Not you? Remove it on My matches." through the gate
    // (`notifyPasskeySaved`, sender `passkeySaved`): the inbox always keeps it, and the record's own
    // channel gets it while the kind "changes" is on. The sentence once promised the channel with no
    // condition, while the switch "Match changes" silenced it (review, 28 October 2026), and the phone and
    // the browser with no condition, while a label the code cannot read sends the line without them.
    const TELLS = {
      en: ["Each time a phone starts to remember you, we tell you in your inbox", "on your own channel while notices about match changes are on", "when we can tell them", "remove it"],
      ru: ["Каждый раз, когда новый телефон начинает вас помнить, мы сообщаем об этом в ваших входящих", "в вашем канале — пока включены уведомления об изменениях матча", "Если мы можем определить телефон и браузер", "удалить телефон"],
      es: ["Cada vez que un teléfono empieza a recordarte, te lo decimos en tu bandeja", "en tu propio canal mientras tengas activados los avisos de cambios del partido", "cuando podemos identificarlos", "lo quites"],
    } as const;
    for (const l of LOCALES) {
      const line = render(l, "privacy.storeBody").split("\n").find((x) => x.includes("passkey"));
      for (const words of TELLS[l]) expect(line, `${l}: ${words}`).toContain(words);
    }
    // The switch the sentence names is the one the code reads: the sender's kind is "changes", on by
    // default, and the settings line of that switch names the new phone, so a player who turns it off knows.
    expect(SENDERS.passkeySaved).toBe("changes");
    expect(KIND_DEFAULTS[SENDERS.passkeySaved]).toBe(true);
    const PHONE = { en: "a new phone that signs you in", ru: "новый телефон, который вас помнит", es: "un teléfono nuevo que te recuerda" } as const;
    for (const l of LOCALES) expect(render(l, `notices.line_${SENDERS.passkeySaved}`), l).toContain(PHONE[l]);
    expect(readFileSync(path.resolve(process.cwd(), "src/actions/passkeys.ts"), "utf8")).toMatch(/later\(\(\) => notifyPasskeySaved\(db, me, label\)\)/);
  });

  it("says that an organiser can see a past partner Kicksmash cannot reach, and how far back, in every language", () => {
    // The owner's decision of 16 October 2026 ("yes, write the privacy sentence"): the organiser's line
    // "Kicksmash can't reach Tim and Adrian" (DECIDING rule 7, src/lib/domain/unreached.ts) shows a past
    // partner's first name and that no channel reaches them. The days are the ones partnersQuery reads.
    // An address counts only while its switch is on (`channelOf`: email && emailNotifications), so a
    // player who gave an email and switched it off is named too, and the line says so.
    const WORDS = {
      en: ["played a match with an organiser", "an email counts only while you let us email you", "first name", "cannot reach you", "send you the link"],
      ru: ["играли матч с организатором", "только пока вы разрешаете нам писать", "ваше имя", "не можем с вами связаться", "отправил вам ссылку"],
      es: ["jugaste un partido con un organizador", "un email solo cuenta mientras nos dejes escribirte", "nombre de pila", "no podemos contactarte", "te envíe el enlace"],
    } as const;
    const days = PARTNER_WINDOW_MS / (24 * 60 * 60 * 1000);
    expect(Number.isInteger(days)).toBe(true);
    for (const l of LOCALES) {
      const raw = (messagesOf(l).privacy.storeBody as string).split("\n").find((x) => x.includes(WORDS[l][0]));
      expect(raw, l).toContain("{partnerDays");
      const line = render(l, "privacy.storeBody").split("\n").find((x) => x.includes(WORDS[l][0]));
      expect(line, l).toBeDefined();
      for (const words of WORDS[l]) expect(line, `${l}: ${words}`).toContain(words);
      expect(line, l).toMatch(new RegExp(`(^|\\D)${days}\\s`));
    }
  });

  it("names every door that signs in by a name alone on the km_by_name line, in every language", () => {
    // Three calls set the mark (`markSignedInByName`): "That's me" (`thatsMeAction`), "I'm in" on an
    // invitation to a place kept for a past player's record (`confirmInviteAction`, the owner's decision
    // of 11 October 2026), and `restoreIdentity`, which brings the same session back and makes no new
    // door. Until 16 October 2026 the line named only "That's me". A new door is named on the page in
    // three languages first, then added here.
    const callers = readdirSync(path.resolve(process.cwd(), "src"), { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => /\bmarkSignedInByName\(/.test(readFileSync(path.resolve(process.cwd(), "src", f), "utf8").replace(/export (async )?function markSignedInByName\(/, "")))
      .map((f) => f.split(path.sep).join("/"))
      .sort();
    expect(callers).toEqual(["actions/identity.ts", "actions/slots.ts"]);
    for (const l of LOCALES) {
      const m = messagesOf(l);
      const line = render(l, "privacy.cookiesBody").split("\n").find((x) => x.includes(BY_NAME_COOKIE));
      for (const button of [m.identity.thatsMeIn, m.invitePage.confirm]) expect(line, `${l}: ${button}`).toContain(button);
    }
  });

  it("says a sign-in lasts a year after the last visit, renewed at most once in the days the code renews it, and one by name a year after it began", () => {
    // The owner, 28 October 2026: "May a sign-in last one year after the last visit ...?" "Yes, both".
    // `renewSession` gives km_player and km_has_id a new year at most once in RENEW_EVERY_DAYS, so the
    // line names that figure from the code; a sign-in by name is never renewed (`renewDue`).
    const LAST = { en: "One year after your last visit", ru: "Один год после вашего последнего визита", es: "Un año después de tu última visita" } as const;
    const BY_NAME = { en: "one year after you came in, and no longer", ru: "один год после входа, не дольше", es: "un año después de entrar, y no más" } as const;
    for (const l of LOCALES) {
      const raw = (messagesOf(l).privacy.cookiesBody as string).split("\n");
      expect(raw.find((x) => x.includes(`${PLAYER_COOKIE}:`)), l).toContain("{renewDays");
      const lines = render(l, "privacy.cookiesBody").split("\n");
      const player = lines.find((x) => x.includes(`${PLAYER_COOKIE}:`))!;
      expect(player, l).toContain(LAST[l]);
      expect(player, l).toMatch(new RegExp(`(^|\\D)${RENEW_EVERY_DAYS}\\s`));
      expect(player, l).toContain(BY_NAME[l]);
      expect(lines.find((x) => x.includes(`${HAS_ID_COOKIE}:`)), l).toContain(LAST[l]);
    }
  });

  it("says what 'Sign out on this browser' removes, where it is, and what the sign-out mark keeps, in every language", () => {
    // `signOutAction` deletes the session cookies and stamps km_signed_out; the page's script removes the
    // restore seal from the browser's storage (`forgetBrowser`). The button's own words are on the page.
    const COPY = { en: "removes that copy", ru: "удаляет эту копию", es: "borra esa copia" } as const;
    for (const l of LOCALES) {
      const m = messagesOf(l);
      const text = render(l, "privacy.cookiesBody");
      const storage = text.split("\n").at(-1)!;
      expect(storage, l).toContain(m.identity.signOut);
      expect(storage, l).toContain(COPY[l]);
      expect(text.split("\n").find((x) => x.includes(`${SIGNED_OUT_COOKIE}:`)), l).toContain(m.identity.signOut);
    }
  });

  it("says the sign-out stops this browser's notifications, and that the personal link and a home-screen icon still sign in", () => {
    // `signOutAction(endpoint)` deletes this browser's push row and `SignOut` ends the subscription: a
    // notification carries the personal link, so one left behind signed the next person in as the player.
    // The personal link is a sign-in by design (DECIDING rule 34), and the home-screen icon's start page is
    // that link (the manifest), so km_signed_out stops neither: the page says so, and names the way out.
    const STOPS = { en: "stops this browser's notifications", ru: "выключает уведомления в этом браузере", es: "desactiva las notificaciones de este navegador" } as const;
    const EXCEPT = { en: "except your personal link", ru: "кроме вашей личной ссылки", es: "salvo tu enlace personal" } as const;
    const ICON = { en: "home-screen icon", ru: "значок на главном экране", es: "icono de la pantalla de inicio" } as const;
    const CONFIRM = { en: ["stops your notifications", "personal link"], ru: ["уведомления сюда больше не придут", "Личная ссылка"], es: ["no recibirás más notificaciones", "enlace personal"] } as const;
    for (const l of LOCALES) {
      const m = messagesOf(l);
      const lines = render(l, "privacy.cookiesBody").split("\n");
      const storage = lines.at(-1)!;
      expect(storage, l).toContain(STOPS[l]);
      expect(storage, l).toContain(ICON[l]);
      // The way out is the button My matches really shows.
      expect(storage, l).toContain(m.identity.resetLink);
      expect(lines.find((x) => x.includes(`${SIGNED_OUT_COOKIE}:`)), l).toContain(EXCEPT[l]);
      for (const words of CONFIRM[l]) expect(m.identity.signOutConfirm, `${l}: ${words}`).toContain(words);
      expect(m.identity.signOutConfirm, l).toContain(ICON[l]);
    }
  });

  it("says that a sign-in by name proves who it is before it deletes the account, in every language", () => {
    // The owner, 28 October 2026, "Close it": `deleteMyAccountAction` refuses a session by name that proved nothing (`deletionRefusal`).
    const WORDS = {
      en: ["came in by your name alone", "email code", "Telegram"],
      ru: ["вошли по одному имени", "кодом из письма", "Telegram"],
      es: ["entraste solo con tu nombre", "código por email", "Telegram"],
    } as const;
    for (const l of LOCALES) {
      const del = render(l, "privacy.deleteBody");
      for (const words of WORDS[l]) expect(del, `${l}: ${words}`).toContain(words);
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
