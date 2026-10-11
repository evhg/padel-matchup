/**
 * The browser gets only the messages its page hands it, and this file proves each page hands enough.
 *
 * Until 11 October 2026 the root layout gave every page the whole catalogue: 146 KB in English and
 * 230 KB in Russian, inline in every page's HTML and again in every refresh. Now the root layout gives
 * `ROOT_CLIENT_MESSAGES` (nothing), and a page whose client components translate wraps its default
 * export in `withClientMessages([...], Page)` with the namespaces they read. A smaller page narrows the
 * window in which hydration can start before the page's rows arrive; it does not fix React error 418
 * on /me (the ship skill, "A place in page.content() is not a place on the screen"). What a
 * client-side navigation now costs is in src/i18n/withClientMessages.tsx.
 *
 * The price of a missing key is the lesson about a notification that showed its own message key: the
 * browser renders "me.title". So the list is not trusted, it is read back from the source
 * (tests/helpers/client-messages.ts walks each route to every module the browser loads) and must be
 * exactly what those modules translate. When it is not, the failure prints the line to paste.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import ts from "typescript";
import { pickMessages, ROOT_CLIENT_MESSAGES } from "@/i18n/clientMessages";
import { analyseClientMessages, covers, leavesFor, leavesOf, listFor, type DynamicTable, type Report } from "./helpers/client-messages";

/** Namespaces given one level down, because each is large and no page reads most of it. */
const SPLIT = ["coach"] as const;

/**
 * Every key a client module builds at run time, by file and by the expression it hands the
 * translator (whitespace squashed, a cast left out). Each value lists what the expression can be,
 * relative to its translator: "a.b" is one key, "a.b.*" and "a.b_*" are every key that starts so.
 * Where the type checker can list the expression's values, the guard checks them against this entry.
 * A dynamic key that is not here fails the guard; so does an entry nothing uses any more.
 */
const DYNAMIC: DynamicTable = {
  "src/components/AmericanoPanel.tsx": {
    // `key` is an action's error code (ActionError in src/actions/shared.ts): any of errors.*.
    "`errors.${key}`": ["errors.*"],
    // FORMAT_KEYS and FORMAT_HELP_KEYS in src/components/EventFields.tsx.
    "FORMAT_KEYS[format]": ["create.formatAmericano", "create.formatMexicano", "create.formatKing"],
    "FORMAT_KEYS[f]": ["create.formatAmericano", "create.formatMexicano", "create.formatKing"],
    "FORMAT_HELP_KEYS[format]": ["create.formatAmericanoHelp", "create.formatMexicanoHelp", "create.formatKingHelp"],
  },
  "src/components/EventFields.tsx": {
    "FORMAT_KEYS[f]": ["create.formatAmericano", "create.formatMexicano", "create.formatKing"],
    "FORMAT_HELP_KEYS[values.format]": ["create.formatAmericanoHelp", "create.formatMexicanoHelp", "create.formatKingHelp"],
    // The inline map beside it, one "how it works" line for each format.
    '({ americano: "pairs.howAmericano", mexicano: "pairs.howMexicano", king: "pairs.howKing" } as const)[values.format]': ["pairs.howAmericano", "pairs.howMexicano", "pairs.howKing"],
    // `freeLineMessage` in src/lib/domain/bestTimes.ts: free or busy, with or without the platform and the club's time.
    "freeThen.key": ["create.freeThen", "create.busyThen", "create.freeThenClub", "create.busyThenClub", "create.freeThenOn", "create.busyThenOn", "create.freeThenOnClub", "create.busyThenOnClub"],
    // `k` runs over "any", LEVEL_PRESETS (src/lib/domain/levels.ts) and "custom".
    "`level.${k}`": ["level.any", "level.bronze", "level.silver", "level.gold", "level.platinum", "level.custom"],
    // CATEGORY_KEYS in src/lib/domain/eventTags.ts.
    "CATEGORY_KEYS[c]": ["level.tagMen", "level.tagWomen", "level.tagMixed"],
  },
  "src/components/ClubClaimForm.tsx": {
    // `r` runs over the claimant's roles in the form (CLAIM_ROLES).
    "`club.role_${r}`": ["club.role_*"],
  },
  "src/components/ClubWeekEditor.tsx": {
    "CATEGORY_KEYS[c]": ["level.tagMen", "level.tagWomen", "level.tagMixed"],
    // A slot of the club's week: a match, or a tournament in its format.
    '`club.week.kind.${type === "tournament" ? (format ?? "americano") : "match"}`': ["club.week.kind.*"],
    // `p.key` runs over LEVEL_PRESETS (src/lib/domain/levels.ts).
    "`level.${p.key}`": ["level.bronze", "level.silver", "level.gold", "level.platinum"],
  },
  "src/components/EditMatch.tsx": {
    // `editErrorKey` in src/lib/editMatchForm.ts.
    "editErrorKey(r)": ["event.startLocked", "errors.invalid"],
  },
  "src/components/GroupPanel.tsx": {
    // An action's error code through `errKey` (the file's top): any of errors.*.
    "`errors.${errKey(r.error)}`": ["errors.*"],
  },
  "src/components/InviteActions.tsx": {
    '`errors.${r.error === "name_required" || r.error === "no_identity" ? "generic" : r.error}`': ["errors.*"],
  },
  "src/components/JoinBar.tsx": {
    '`errors.${r.error === "no_identity" ? "generic" : r.error}`': ["errors.*"],
    '`errors.${r.error === "name_required" || r.error === "no_identity" || r.error === "level_required" ? "generic" : r.error}`': ["errors.*"],
  },
  "src/components/JoinInline.tsx": {
    '`errors.${r.error === "name_required" || r.error === "no_identity" ? "generic" : r.error}`': ["errors.*"],
  },
  "src/components/JoinRequests.tsx": {
    '`errors.${r.error === "name_required" || r.error === "no_identity" || r.error === "level_required" ? "generic" : r.error}`': ["errors.*"],
  },
  "src/components/OpenSpot.tsx": {
    '`errors.${error === "no_identity" ? "generic" : error}`': ["errors.*"],
  },
  "src/components/PairRows.tsx": {
    "`errors.${key}`": ["errors.*"],
  },
  "src/components/ScorePanel.tsx": {
    '`errors.${r.error === "name_required" || r.error === "no_identity" ? "generic" : r.error}`': ["errors.*"],
  },
  "src/components/LevelAfterJoin.tsx": {
    // `b` is a level band (LEVEL_BANDS in src/lib/domain/levels.ts).
    "`level.bandHelp.${b}`": ["level.bandHelp.*"],
    "`level.bands.${b}`": ["level.bands.*"],
  },
  "src/components/LevelImport.tsx": {
    // `s.id` runs over the passport's scales (src/lib/domain/passport.ts).
    "`passport.scale.${s.id}`": ["passport.scale.*"],
    "`level.bands.${bandOf(level)}`": ["level.bands.*"],
  },
  "src/components/LevelSelect.tsx": {
    "`level.bands.${g.key}`": ["level.bands.*"],
    "`level.bands.${b}`": ["level.bands.*"],
    "`level.bandHelp.${b}`": ["level.bandHelp.*"],
  },
  "src/components/NoticeSettings.tsx": {
    // Under useTranslations("notices"): `k` runs over the notice kinds (src/lib/domain/noticeKinds.ts).
    "`kind_${k}`": ["kind_*"],
    "`line_${k}`": ["line_*"],
  },
  "src/components/tournament/DrawControls.tsx": {
    // `s` is a scoring scheme of the draw (tournament.sc_*).
    "`tournament.sc_${s}`": ["tournament.sc_*"],
  },
  "src/components/coach/CoachHome.tsx": {
    // Under useTranslations("coach"): an action's error code from the coach book.
    "`errors.${code}`": ["errors.*"],
    "`errors.${r.error}`": ["errors.*"],
    // A lesson's status as the server sends it.
    "`home.status.${l.status}`": ["home.status.*"],
    // The coach page's missing parts: photo, bio, price, levels.
    "`settings.gap${g[0].toUpperCase()}${g.slice(1)}`": ["settings.gap*"],
  },
  "src/components/coach/CoachSettings.tsx": {
    // Under useTranslations("coach"): priceTwo, priceThree, priceFour.
    "`setup.${k}`": ["setup.priceTwo", "setup.priceThree", "setup.priceFour"],
  },
  "src/components/coach/CoachSetup.tsx": {
    // Under useTranslations("coach"): the setup's presets and the notice hours.
    "`setup.preset.${p}`": ["setup.preset.*"],
    "`setup.notice${h}`": ["setup.notice*"],
  },
  "src/components/coach/StudentBooking.tsx": {
    "`errors.${code}`": ["errors.*"],
  },
  "src/lib/levelText.ts": {
    // A translator handed to rangeChip: `preset` is a LEVEL_PRESETS name ("custom" never reaches it).
    "`level.${preset}`": ["level.bronze", "level.silver", "level.gold", "level.platinum"],
    // tagChip: `tagParts` in src/lib/domain/eventTags.ts.
    "p.key": ["level.tagMen", "level.tagWomen", "level.tagMixed", "level.tagAge"],
  },
};

const en = JSON.parse(readFileSync(path.resolve(process.cwd(), "messages/en.json"), "utf8")) as Record<string, unknown>;
const LEAVES = leavesOf(en);

describe("pickMessages", () => {
  const all = { a: { x: "1", y: { z: "2" } }, b: { w: "3" }, c: "4" };

  it("copies only the paths it is given", () => {
    expect(pickMessages(all, ["b"])).toEqual({ b: { w: "3" } });
    expect(pickMessages(all, ["a.y", "c"])).toEqual({ a: { y: { z: "2" } }, c: "4" });
    expect(pickMessages(all, [])).toEqual({});
  });

  it("takes a whole namespace once, whatever order its parts come in", () => {
    expect(pickMessages(all, ["a.y", "a"])).toEqual({ a: all.a });
    expect(pickMessages(all, ["a", "a.x"])).toEqual({ a: all.a });
  });

  it("never writes into the catalogue it reads", () => {
    const before = JSON.stringify(all);
    pickMessages(all, ["a", "a.y", "b", "a.x"]);
    pickMessages(all, ["a.x", "a.y.z", "a"]);
    expect(JSON.stringify(all)).toBe(before);
  });

  it("skips a path the catalogue does not hold", () => {
    expect(pickMessages(all, ["nope", "a.nope", "c.deeper"])).toEqual({});
  });
});

describe("the messages each page gives the browser", () => {
  let report: Report;
  beforeAll(() => {
    report = analyseClientMessages(DYNAMIC);
  }, 60_000);

  it("follows every translator the browser runs, and no module reads messages another way", () => {
    expect(report.problems.map((p) => `${p.at}: ${p.message}`)).toEqual([]);
  });

  it("knows every dynamic key, and every entry of its table is still used", () => {
    expect(report.staleDynamic).toEqual([]);
  });

  it("asks only for keys that exist", () => {
    // A DYNAMIC entry is relative to its translator, so it is checked here, where it lands.
    const missing = [...new Set(report.entries.flatMap((e) => e.needs.filter((n) => leavesFor(n, LEAVES).length === 0).map((n) => `${n.at}: ${n.path}${n.kind === "prefix" ? "*" : ""}`)))];
    expect(missing).toEqual([]);
  });

  it("a route file that is not wrapped translates nothing in the browser", () => {
    // The root layout's provider holds ROOT_CLIENT_MESSAGES on every page, and so do error.tsx, an
    // unwrapped not-found.tsx and an unwrapped page, which render inside it. A page's own provider
    // replaces it: next-intl's providers do not merge.
    const unwrapped: string[] = [];
    for (const e of report.entries.filter((x) => x.declared === null)) {
      const want = listFor(new Set(e.needs.flatMap((n) => leavesFor(n, LEAVES))), SPLIT, ROOT_CLIENT_MESSAGES);
      if (want.length) unwrapped.push(`${e.file}: export default withClientMessages(${JSON.stringify(want)}, …)`);
    }
    expect(unwrapped).toEqual([]);
  });

  it("each wrapped page gives exactly the namespaces its client components read", () => {
    const wrong: string[] = [];
    for (const e of report.entries.filter((x) => x.declared !== null)) {
      const want = listFor(new Set(e.needs.flatMap((n) => leavesFor(n, LEAVES))), SPLIT, ROOT_CLIENT_MESSAGES);
      const got = [...e.declared!].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        wrong.push(want.length ? `${e.file}: export default withClientMessages(${JSON.stringify(want)}, …)` : `${e.file}: no client component translates; export the page itself`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("only the root layout and withClientMessages hand messages to the browser, and both say which", () => {
    // `messages` left out means the whole catalogue (next-intl's server provider reads getMessages()),
    // so every provider must name its subset.
    const providers: string[] = [];
    const scan = (dir: string) => {
      for (const f of ts.sys.readDirectory(dir, [".tsx", ".ts"])) {
        const text = readFileSync(f, "utf8");
        if (!text.includes("NextIntlClientProvider")) continue;
        const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const visit = (n: ts.Node) => {
          if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === "NextIntlClientProvider") {
            const messages = n.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "messages");
            providers.push(`${path.relative(process.cwd(), f)}: ${messages && ts.isJsxAttribute(messages) && messages.initializer ? messages.initializer.getText(sf) : "(no messages)"}`);
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
    };
    scan(path.resolve(process.cwd(), "src"));
    // And withClientMessages wraps a route's default export and nothing else, where the walk reads it.
    const elsewhere = ts.sys
      .readDirectory(path.resolve(process.cwd(), "src"), [".tsx", ".ts"])
      .filter((f) => !f.endsWith("src/i18n/withClientMessages.tsx"))
      .flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => ({ f, line, i })))
      .filter(({ f, line }) => line.includes("withClientMessages(") && !(/\/(page|not-found)\.tsx$/.test(f) && /^export default withClientMessages\(\[/.test(line)))
      .map(({ f, i }) => `${path.relative(process.cwd(), f)}:${i + 1}`);
    expect(elsewhere).toEqual([]);
    expect(providers.sort()).toEqual(["src/app/layout.tsx: {pickMessages(messages, ROOT_CLIENT_MESSAGES)}", "src/i18n/withClientMessages.tsx: {pickMessages(await getMessages(), [...ROOT_CLIENT_MESSAGES, ...paths])}"]);
  });
});

/**
 * The guard's own blind spots, each found by the review of 11 October 2026 in a scratch copy where
 * tsc and this file passed while the browser showed "me.title". tests/fixtures/client-messages is a
 * small app tree with one page for each; the guard must see the key or name the problem.
 */
describe("the guard sees a translator however it reaches the browser", () => {
  const FIX = "tests/fixtures/client-messages/src";
  let fx: Report;
  beforeAll(() => {
    // A DYNAMIC entry for a template it can never build: the browser would get feedback.* and no errors.* key.
    fx = analyseClientMessages({ [`${FIX}/components/TemplateKey.tsx`]: { "`errors.${code}`": ["feedback.*"], key: ["feedback.*"] } }, path.resolve(process.cwd(), FIX));
  }, 60_000);
  const problemsIn = (file: string) => fx.problems.filter((p) => p.at.startsWith(`${FIX}/${file}`)).map((p) => p.message);
  const needsOf = (page: string) => fx.entries.find((e) => e.file === `${FIX}/app/${page}/page.tsx`)!.needs.map((n) => n.path).sort();

  it("useTranslations passed on by a file of our own, under its own name or another", () => {
    expect(needsOf("barrel")).toEqual(["feedback.title", "me.title"]);
  });

  it("a namespace import of such a file, and useMessages taken from it", () => {
    expect(problemsIn("components/ByNamespace.tsx")).toEqual([expect.stringContaining("a namespace import of")]);
    expect(problemsIn("components/ByMessages.tsx")).toEqual([expect.stringContaining("useMessages in code the browser runs")]);
  });

  it("a JavaScript module the browser runs", () => {
    expect(problemsIn("components/ProbeJsx.jsx")).toEqual([expect.stringContaining("a JavaScript module the browser runs")]);
  });

  it("an import() of a path built at run time, and a local import that names no file", () => {
    expect(problemsIn("components/Loader.tsx")).toEqual([expect.stringContaining("an import() of a path built at run time"), 'an import the guard cannot resolve: "./steps/Gone"']);
  });

  it("a DYNAMIC entry that lists keys its template can never build", () => {
    expect(problemsIn("components/TemplateKey.tsx")).toEqual(['`errors.${code}` can never be "feedback.*", which its DYNAMIC entry lists', 'key can never be "feedback.*", which its DYNAMIC entry lists']);
  });
});
