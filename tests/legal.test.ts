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
import { HINT_KEEP_DAYS } from "@/lib/domain/deviceHints";
import { isEuropeanZone, SIGNALS_COOKIE, SIGNALS_COOKIE_MAX_AGE } from "@/lib/domain/hintSignals";
import { HINT_SCOPE_STATUSES } from "@/lib/domain/deviceHintAsk";
import { HINT_ASKED_KEY } from "@/lib/deviceSignals";
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
    const cookies = [PLAYER_COOKIE, HAS_ID_COOKIE, BY_NAME_COOKIE, SIGNED_OUT_COOKIE, LOCALE_COOKIE, manageCookieName(""), SOURCE_COOKIE, COACH_SOURCE_COOKIE, notMineCookie!, TEXT_SIZE_COOKIE, CHALLENGE_COOKIE, SIGNALS_COOKIE];
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
      [60]: { en: "One minute", ru: "Одна минута", es: "Un minuto" },
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
      [SIGNALS_COOKIE, SIGNALS_COOKIE_MAX_AGE],
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

  it("says what a phone we recognise keeps, why, and never for a European zone, without calling it a fingerprint", () => {
    // Device hints, the owner's decision of 28 October 2026 (design B): a key made on the server with a secret
    // from what a browser tells every site (src/lib/deviceHint.ts), a label and two dates (the device_hints
    // table). Never the values, never for a browser set to a European zone (`isEuropeanZone`), never a sign-in.
    const WORDS = {
      en: ["a key that we make with a secret", "what your browser tells every site", "the screen size", "the languages", "the time zone", "the text size", "the day we saved it", "the day you last used it", "Never those details themselves", "European time zone", "another browser on the same phone", "never signs you in by itself"],
      ru: ["ключ, который мы делаем с секретом", "что ваш браузер сообщает любому сайту", "размер экрана", "языки", "часовой пояс", "размер текста", "день, когда мы его сохранили", "в последний раз", "Никогда — сами эти данные", "европейским часовым поясом", "в другом браузере на том же телефоне", "никогда не входит за вас"],
      es: ["una clave que hacemos con un secreto", "lo que tu navegador le dice a cualquier web", "el tamaño de la pantalla", "los idiomas", "la zona horaria", "el tamaño del texto", "el día en que la guardamos", "el día en que la usaste por última vez", "Nunca esos datos", "zona horaria europea", "otro navegador en el mismo teléfono", "Nunca inicia sesión por sí sola"],
    } as const;
    // "Never your face, your fingerprint" is the passkey's line about the body: the key is not a fingerprint, and the page never calls it one.
    const FINGER = { en: /fingerprint/i, ru: /отпечат/i, es: /huella/i } as const;
    expect(isEuropeanZone("Europe/Madrid") && isEuropeanZone("Atlantic/Canary") && !isEuropeanZone("Asia/Bangkok")).toBe(true);
    for (const l of LOCALES) {
      const line = render(l, "privacy.storeBody").split("\n").find((x) => x.includes(WORDS[l][0]));
      expect(line, l).toBeDefined();
      for (const words of WORDS[l]) expect(line, `${l}: ${words}`).toContain(words);
      expect(line, l).not.toMatch(FINGER[l]);
      expect(render(l, "identity.hintsHelp" as never), l).not.toMatch(FINGER[l]);
    }
  });

  it("says how long a phone we recognise is kept, that \"Forget this phone\" and deletion take it, and that it comes back", () => {
    // One year after the last use: the hourly job's prune (`pruneDeviceHints`, HINT_KEEP_DAYS). "Forget this
    // phone" deletes the row; the next join or sign-in from that phone keeps a key again, and the page says so.
    expect(HINT_KEEP_DAYS).toBe(365);
    const YEAR = { en: "one year after you last used it", ru: "один год после того, как вы пользовались им в последний раз", es: "un año después de la última vez que lo usaste" } as const;
    const AGAIN = { en: "keeps it again", ru: "сохраняет его снова", es: "se guarda de nuevo" } as const;
    const RIGHTS = { en: "Forget a phone we recognise", ru: "забыть телефон, который мы узнаём", es: "olvidar un teléfono que reconocemos" } as const;
    for (const l of LOCALES) {
      const m = messagesOf(l);
      const keep = render(l, "privacy.keepBody").split("\n").find((x) => x.includes(YEAR[l]));
      expect(keep, l).toBeDefined();
      expect(keep, l).toContain(m.identity.hintForget);
      expect(keep, l).toContain(AGAIN[l]);
      // The words the deletion and the rights name are the card's own title on My matches.
      const title = (m.identity.hintsTitle as string).toLowerCase();
      expect(render(l, "privacy.deleteBody").toLowerCase(), l).toContain(title);
      expect(render(l, "privacy.rightsBody"), l).toContain(RIGHTS[l]);
    }
  });

  it("names \"Don't recognise my phones\" where it names the key, says that it lasts until the player switches it off, and that it covers the one account it is on", () => {
    // Thai PDPA s.32: the key is kept under a legitimate interest with no tap, so the player may object for
    // good (`players.hints_off`, `setHintsOff`; DECIDING rule 40). The page names the switch by the screen's
    // own words, in the key's own bullet, in the line on how long a phone is kept, among the rights, and on
    // the short page that names the key too.
    const UNTIL = { en: "until you switch it off", ru: "пока вы это не выключите", es: "hasta que lo desactives" } as const;
    const LASTS = { en: "it covers that account and lasts until you switch it off", ru: "он действует для этого аккаунта, пока вы его не выключите", es: "vale para esa cuenta hasta que lo desactives" } as const;
    const ABOUT_UNTIL = { en: "stops it for your account until you switch it off", ru: "останавливает это для вашего аккаунта, пока вы его не выключите", es: "lo detiene para tu cuenta hasta que lo desactives" } as const;
    const ACCOUNT = { en: "The switch covers the account you switch it on in.", ru: "Переключатель действует для того аккаунта, в котором вы его включили.", es: "La opción vale para la cuenta en la que la activas." } as const;
    const NEW_ACCOUNT = { en: "If you join from another browser that does not know you, that makes a new account with its own key", ru: "Если вы запишетесь на матч из другого браузера, который вас не знает, там появится новый аккаунт со своим ключом", es: "Si te apuntas desde otro navegador que no te conoce, allí se crea una cuenta nueva con su propia clave" } as const;
    const JOINS = { en: "which joins the two accounts", ru: "тогда два аккаунта станут одним", es: "entonces las dos cuentas se unen" } as const;
    const UNQUALIFIED = { en: "we delete every key at once and keep none until", ru: "мы сразу удалим все ключи и не будем хранить новые", es: "borramos todas las claves al instante y no guardamos ninguna hasta" } as const;
    const KEEP_ACCOUNT = { en: "is on for that account", ru: "если для этого аккаунта не включено", es: "en esa cuenta" } as const;
    const LINE_ACCOUNT = { en: "makes a new account with its own key, until you sign in there", ru: "там появится новый аккаунт со своим ключом — пока вы там не войдёте", es: "allí se crea una cuenta nueva con su propia clave, hasta que inicies sesión allí" } as const;
    const KEY = { en: "a key that we make with a secret", ru: "ключ, который мы делаем с секретом", es: "una clave que hacemos con un secreto" } as const;
    const YEAR = { en: "one year after you last used it", ru: "один год после того, как вы пользовались им в последний раз", es: "un año después de la última vez que lo usaste" } as const;
    for (const l of LOCALES) {
      const sw = messagesOf(l).identity.hintsOff as string;
      const store = render(l, "privacy.storeBody").split("\n").find((x) => x.includes(KEY[l]));
      expect(store, l).toBeDefined();
      expect(store, `${l}: the key's bullet names the switch`).toContain(sw);
      expect(store, `${l}: until it is switched off`).toContain(UNTIL[l]);
      // The mark is on one record (`players.hints_off`), so the promise is for that account, and the page
      // names the second account that a join in a browser that knows nobody makes (rule 39), with its key.
      expect(store, `${l}: the switch covers the account it is on`).toContain(ACCOUNT[l]);
      expect(store, `${l}: a new account in another browser keeps its own key`).toContain(NEW_ACCOUNT[l]);
      expect(store, `${l}: until a sign-in there joins the two`).toContain(JOINS[l]);
      expect(store, `${l}: no promise of "none" beyond the account`).not.toContain(UNQUALIFIED[l]);
      const keep = render(l, "privacy.keepBody").split("\n").find((x) => x.includes(YEAR[l]));
      expect(keep, `${l}: a later act keeps nothing while the switch is on`).toContain(sw);
      expect(keep, `${l}: for that account`).toContain(KEEP_ACCOUNT[l]);
      const rights = render(l, "privacy.rightsBody");
      expect(rights, l).toContain(sw);
      expect(rights, l).toContain(LASTS[l]);
      const about = render(l, "about.storeBody");
      expect(about, l).toContain(sw);
      expect(about, l).toContain(ABOUT_UNTIL[l]);
      // The switch's own two lines on My matches say the same limit.
      const id = messagesOf(l).identity as Record<string, string>;
      for (const k of ["hintsOffHelp", "hintsOffOn"]) expect(id[k], `${l}: identity.${k}`).toContain(LINE_ACCOUNT[l]);
    }
  });

  it("says how the question \"Welcome back, Tim?\" reads a browser: once, keeping nothing, only for a name the page shows; and that \"Not me\" takes the phone", () => {
    // Part 2 of the device hint (the owner's decision of 28 October 2026, DECIDING rule 40): a browser that knows
    // nobody sends its values once per match in a tab (`WelcomeBack`, a sessionStorage guard), the server makes
    // the key and keeps nothing of it (`deviceHintAction` writes no row), and the scope is the records the match
    // page already shows such a browser (`hintScopeIds`). "Not me" deletes that record's row of the key
    // (`deviceHintNotMeAction`).
    const ASK = {
      en: ["sends the same details once when it opens a match", "we keep nothing of them", "We ask only about a name that the match page already shows"],
      ru: ["один раз отправляет те же данные, когда открывает матч", "мы ничего из них не храним", "Мы спрашиваем только об имени, которое уже есть на странице матча"],
      es: ["envía esos mismos datos una vez al abrir un partido", "no guardamos nada de ellos", "Solo preguntamos por un nombre que la página del partido ya muestra"],
    } as const;
    const GONE = { en: "it goes at once too", ru: "он тоже сразу удаляется", es: "también se borra al instante" } as const;
    expect(HINT_SCOPE_STATUSES).toEqual(["joined", "confirmed", "invited"]);
    for (const l of LOCALES) {
      const m = messagesOf(l);
      const store = render(l, "privacy.storeBody").split("\n").find((x) => x.includes(ASK[l][0]));
      expect(store, l).toBeDefined();
      for (const words of ASK[l]) expect(store, `${l}: ${words}`).toContain(words);
      // The same line as the key itself: one bullet says what is kept and how the question reads it.
      expect(store, l).toContain(l === "en" ? "a key that we make with a secret" : l === "ru" ? "ключ, который мы делаем с секретом" : "una clave que hacemos con un secreto");
      const keep = render(l, "privacy.keepBody").split("\n").find((x) => x.includes(GONE[l]));
      expect(keep, l).toBeDefined();
      // The button's own words, so the page and the screen cannot drift apart.
      expect(keep, l).toContain(m.identity.hintNo);
    }
  });

  it("names the tab's note of the question, outside Europe only, and that it goes with the tab", () => {
    // `hintAskOnce` (src/lib/deviceSignals.ts) writes `km_hint_asked:<code>` to the tab's sessionStorage, once
    // per match, and only after the zone: a European browser writes nothing (review, 28 October 2026).
    const NOTE = { en: ["Outside Europe", "goes when you close the tab"], ru: ["За пределами Европы", "исчезает, когда вы закрываете вкладку"], es: ["Fuera de Europa", "se borra al cerrar la pestaña"] } as const;
    expect(HINT_ASKED_KEY).toBe("km_hint_asked:");
    for (const l of LOCALES) {
      const line = render(l, "privacy.cookiesBody").split("\n").find((x) => x.includes(HINT_ASKED_KEY));
      expect(line, l).toBeDefined();
      for (const words of NOTE[l]) expect(line, `${l}: ${words}`).toContain(words);
      // The question's own words, so the page and the screen cannot drift apart.
      const ask = (messagesOf(l).identity.hintAsk as string).split(",")[0];
      expect(line, l).toContain(ask.replace(/^¿/, ""));
    }
  });

  it("names the legal basis of each use: our agreement for the app, our legitimate interest for the key", () => {
    // PDPA s.23(1) and the PDPC notice guideline of 7 September 2022: a notice names its legal basis. The key
    // under "What we keep" is saved with no tap, so its basis is a legitimate interest, not consent
    // (DECIDING rule 40; the law research of 28 October 2026).
    const BASES = {
      en: ["our agreement with you", "sign in on your own phone", "duplicate players", "our legitimate interest"],
      ru: ["наше соглашение с вами", "входить со своего телефона", "один игрок не появлялся в приложении дважды", "наш законный интерес"],
      es: ["nuestro acuerdo contigo", "iniciar sesión desde tu propio teléfono", "jugadores duplicados", "nuestro interés legítimo"],
    } as const;
    const CONSENT = { en: /consent/i, ru: /согласи/i, es: /consentimiento/i } as const;
    for (const l of LOCALES) {
      const law = render(l, "privacy.lawBody");
      expect(law, l).toContain("PDPA");
      for (const words of BASES[l]) expect(law, `${l}: ${words}`).toContain(words);
      expect(law, l).not.toMatch(CONSENT[l]);
    }
  });

  it("keeps \"No tracking\" true: across other sites, on the privacy page and on /about", () => {
    // A key made from what a browser tells every site is first-party, for sign-in only, and never read on
    // another site; a bare "No tracking" stopped being literally true on 28 October 2026.
    const ACROSS = { en: "No tracking across other sites", ru: "Без трекинга на других сайтах", es: "Sin rastreo en otras webs" } as const;
    const BARE = { en: /No tracking(?! across other sites)/, ru: /Без трекинга(?! на других сайтах)/, es: /Sin rastreo(?! en otras webs)/ } as const;
    // The short page says what it keeps too: the key, outside Europe, for one question on the same phone.
    const ABOUT = { en: ["Outside Europe we also keep a key", "what your browser tells every site", "another browser on the same phone"], ru: ["За пределами Европы мы также храним ключ", "что ваш браузер сообщает любому сайту", "другой браузер на том же телефоне"], es: ["Fuera de Europa también guardamos una clave", "lo que tu navegador le dice a cualquier web", "otro navegador del mismo teléfono"] } as const;
    for (const l of LOCALES) {
      for (const key of ["privacy.cookiesBody", "about.cookiesBody"]) {
        const text = render(l, key);
        expect(text, `${l} ${key}`).toContain(ACROSS[l]);
        expect(text, `${l} ${key}`).not.toMatch(BARE[l]);
      }
      for (const words of ABOUT[l]) expect(render(l, "about.storeBody"), `${l}: ${words}`).toContain(words);
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
    // Four calls set the mark (`markSignedInByName`): "That's me" (`thatsMeAction`), "I'm in" on an
    // invitation to a place kept for a past player's record (`confirmInviteAction`, the owner's decision
    // of 11 October 2026), "It's me" under "Welcome back, Tim?" (`deviceHintYesAction`, the device hint's
    // question, 28 October 2026), and `restoreIdentity`, which brings the same session back and makes no new
    // door. Until 16 October 2026 the line named only "That's me". A new door is named on the page in
    // three languages first, then added here.
    const callers = readdirSync(path.resolve(process.cwd(), "src"), { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => /\bmarkSignedInByName\(/.test(readFileSync(path.resolve(process.cwd(), "src", f), "utf8").replace(/export (async )?function markSignedInByName\(/, "")))
      .map((f) => f.split(path.sep).join("/"))
      .sort();
    expect(callers).toEqual(["actions/deviceHints.ts", "actions/identity.ts", "actions/slots.ts"]);
    for (const l of LOCALES) {
      const m = messagesOf(l);
      const line = render(l, "privacy.cookiesBody").split("\n").find((x) => x.includes(BY_NAME_COOKIE));
      for (const button of [m.identity.thatsMeIn, m.identity.hintYes, m.invitePage.confirm]) expect(line, `${l}: ${button}`).toContain(button);
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

  it("says that 'Sign out on this browser' takes this phone's key off the account it signs out of, in every language", () => {
    // DECIDING, "A phone is never shared" (28 October 2026): `SignOut` sends this browser's values with the
    // sign-out, and `signOutAction` deletes that key from the record that signs out, in the same request
    // (`forgetDeviceHints`). The page says so in the line on how long a phone we recognise is kept, by the
    // button's own words.
    const YEAR = { en: "one year after you last used it", ru: "один год после того, как вы пользовались им в последний раз", es: "un año después de la última vez que lo usaste" } as const;
    const GOES = { en: "we delete at once, from the account you sign out of, the key that this browser's details make at that moment", ru: "мы сразу удалим из аккаунта, из которого вы выходите, ключ, который дают данные этого браузера в этот момент", es: "borramos al instante, de la cuenta de la que sales, la clave que dan los datos de este navegador en ese momento" } as const;
    // The promise holds only for the key that the browser's values make at the tap (`forgetKeyOf`), and
    // `readDeviceSignals` sends none in a European zone. A key kept under other values (the phone flew home
    // to Europe/London, or its text size or languages changed) stays: no request can find it without its
    // values. So the line names the condition, and names "Forget this phone" as the full way out for it.
    const ONLY = { en: "outside Europe only", ru: "и только за пределами Европы", es: "y solo fuera de Europa" } as const;
    const OTHER = { en: "A key that we kept under other details", ru: "Ключ, который мы сохранили при других данных", es: "Una clave que guardamos con otros datos" } as const;
    for (const l of LOCALES) {
      const m = messagesOf(l);
      const keep = render(l, "privacy.keepBody").split("\n").find((x) => x.includes(YEAR[l]));
      expect(keep, l).toContain(m.identity.signOut);
      const out = keep!.slice(keep!.indexOf(m.identity.signOut));
      expect(out, l).toContain(GOES[l]);
      expect(out, l).toContain(ONLY[l]);
      expect(out, l).toContain(OTHER[l]);
      expect(out.slice(out.indexOf(OTHER[l])), l).toContain(m.identity.hintForget);
    }
    expect(readFileSync(path.resolve(process.cwd(), "src/actions/identity.ts"), "utf8")).toMatch(/await forgetDeviceHints\(db, leaving, key\)/);
    expect(readFileSync(path.resolve(process.cwd(), "src/components/SignOut.tsx"), "utf8")).toMatch(/signOutAction\(sub\?\.endpoint \?\? null, \{ hint \}\)/);
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
