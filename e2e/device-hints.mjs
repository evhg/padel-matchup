// The device hint's question, "Welcome back, Tim?" (design B, part 2; the owner's decision of 28 October
// 2026, DECIDING rule 40). Each browser context here is one browser: two with the same screen, language,
// time zone and phone are two browsers on one phone, as Safari and the home-screen icon are; a third with
// another screen is another phone. Since the key's second version (30 October 2026) the values also hold
// a short hash of a test picture, a 3D shape and a test sound, and every platform runs the three tests
// (the owner, 30 October 2026: "On everywhere"). Tim's contexts carry an iPhone's words, so each must send
// three real hashes, and a second browser with the same profile the same three; a context with another
// screen must give another key. Two contexts with an Android phone's words prove the same there. This is
// Chromium, which adds no noise: the suite proves nothing about Safari's own noise, which only a real
// iPhone can show (DECIDING rule 40 names that risk and how the report shows it).
// A read with a test still running at the 150 ms limit sends nothing and takes the tab's note back, so a
// view that must send its values gets two more views on a busy machine (`openAsked`). The acts after the
// question stay in the question's page (client-side navigation), where the tests already ran. Tim's first
// join reads in a new page with no second try: if it goes red with no values sent, look there first.
// Tim joins in the first; the second knows nobody, is asked "Welcome back, Tim?", taps "It's me" and is
// Tim, and the tap sends exactly the question's values; the third is asked nothing. Every context but one is in
// Asia/Bangkok, because a browser in a European zone sends nothing at all and writes nothing to the tab
// (part 1, `isEuropeanZone`; `hintAskOnce`): the one in Europe/Madrid proves it.
//
// Every record a suite makes is minutes old, and the question refuses a record made in the last seven
// days that shares no earlier match with anybody (the second Tim). An earlier match is one that has
// already started, never one still to come (review, 28 October 2026). So Tim first has only the match to
// come, and a browser on his phone is asked nothing; then he joins Kai's match that started 20 minutes
// ago (joining stays open for the match's length), and only then is the question asked.
//
// At the end, the browser that "It's me" signed in taps "Sign out on this browser": the request carries
// its values, and the key of this phone leaves Tim's record (DECIDING, "A phone is never shared").
import { BASE, crashed, finish, iphone, launch, makeCheck } from "./lib.mjs";

const browser = await launch();
/** What a phone shows, 390 px wide, around the element the walk just scrolled to. */
const view = (p, name) => (process.env.SHOTS ? p.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : Promise.resolve());
const results = [];
const check = makeCheck(results);

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
/** Chrome on an Android phone. */
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
/** Tim's iPhone in Phuket: every context made from this is a browser on the same phone. */
const TIMS_PHONE = { ...iphone, timezoneId: "Asia/Bangkok", userAgent: IPHONE_UA };

const CRON = { authorization: `Bearer ${process.env.CRON_SECRET || "e2e-cron-secret"}` };
/** One read through the operator's read-only door: the database's own answer, not the page's. */
const ask = async (q) => {
  const r = await fetch(`${BASE}/api/admin/sql?q=${encodeURIComponent(q)}`, { headers: CRON }).then((x) => x.json());
  if (r.ok !== true) throw new Error(`${r.error} in: ${q}`);
  return r.rows;
};
const recordsNamed = async (name) => Number((await ask(`select count(*)::int as n from players where display_name = '${name}'`))[0]?.n ?? -1);
const hintsOf = async (name) => Number((await ask(`select count(*)::int as n from device_hints h join players p on p.id = h.player_id where p.display_name = '${name}'`))[0]?.n ?? -1);

/** The browser's values in one action's body: the object with a `platform`, wherever the action's arguments put it; null for none. */
function valuesIn(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const walk = (v) => {
    if (!v || typeof v !== "object") return null;
    if (!Array.isArray(v) && typeof v.platform === "string") return v;
    for (const x of Object.values(v)) {
      const found = walk(x);
      if (found) return found;
    }
    return null;
  };
  return walk(parsed);
}
/** One set of values as text, its keys in order, so two sets compare as one string. */
const asText = (v) => JSON.stringify(v, v ? Object.keys(v).sort() : undefined);
const TESTS = ["canvas", "webgl", "audio"];
/** The three tests ran and each sent a 12-character hash, never "na". */
const hashed = (v) => Boolean(v) && TESTS.every((k) => /^[A-Za-z0-9_-]{12}$/.test(v[k] ?? ""));

/**
 * A browser on a phone, in a language of the page's own (the cookie; the phone's languages stay as they
 * are). `calls` counts every server action it sends; `hintCalls` those that carry the browser's values
 * (the question, "It's me", "Not me", a join or a sign-in that keeps a key, and "Sign out on this browser",
 * which forgets one), which no other action does; `sent` lists those values, one set for each such call.
 */
async function browserOn(options, lang = null) {
  const ctx = await browser.newContext(options);
  if (lang) await ctx.addCookies([{ name: "NEXT_LOCALE", value: lang, url: BASE }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  let calls = 0;
  let hintCalls = 0;
  let lastValues = "";
  const sent = [];
  page.on("request", (r) => {
    if (r.method() !== "POST" || !r.headers()["next-action"]) return;
    calls += 1;
    const body = r.postData() ?? "";
    if (!body.includes('"platform":')) return;
    hintCalls += 1;
    lastValues = body;
    sent.push(valuesIn(body));
  });
  return { ctx, page, calls: () => calls, hintCalls: () => hintCalls, lastValues: () => lastValues, sent: () => sent };
}

/** A match made through the public API, `hours` from now (less than zero: already under way, which the API takes within a year); its organiser, a new Kai each time, holds a seat and keeps no key, so no question is ever about him. */
async function newMatch(page, venue, hours) {
  const made = await page.request.post(`${BASE}/api/v1/matches`, { data: { startsAt: new Date(Date.now() + hours * 3600 * 1000).toISOString(), tz: "Asia/Bangkok", venue, organizer: { name: "Kai" } } });
  return (await made.json())?.match?.code;
}

/** Waits until the page has nothing more to say: the question comes after the page, from one call. */
const settle = async (page) => {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(800);
};

/**
 * Opens the match in a browser that knows nobody until its page has sent the values once, three views at
 * most: a read with a test still running at the limit sends nothing and takes the tab's note back, so the
 * next view asks again. The question, if any, is on the page when this returns.
 */
async function openAsked(b, code) {
  for (let tries = 0; tries < 3 && b.hintCalls() === 0; tries++) {
    await b.page.goto(`${BASE}/${code}`);
    await settle(b.page);
  }
}

const NAME = "Tim Hint";

try {
  // ---- Tim, in Safari: a match to come; his record is minutes old and has no past yet ----
  const safari = await browserOn(TIMS_PHONE);
  const code = await newMatch(safari.page, "Kata Padel", 50);
  const underWay = await newMatch(safari.page, "Rawai Padel", -1 / 3);
  check("two matches exist for the hint checks, one to come and one under way", Boolean(code && underWay), `${code} ${underWay}`);
  await safari.page.goto(`${BASE}/${code}`);
  await safari.page.getByRole("button", { name: "Join this match" }).click();
  await safari.page.getByTestId("open-spot-name").first().fill(NAME);
  await safari.page.getByTestId("open-spot-name").first().press("Enter");
  await safari.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  // The key is kept after the answer: give the after() a moment.
  await safari.page.waitForTimeout(1000);
  check("Tim's join keeps one key for his phone", (await hintsOf(NAME)) === 1);
  const joinValues = safari.sent().at(-1) ?? null;
  check(
    "on an iPhone too the page runs its three tests: Tim's join sends the test picture, the 3D shape and the test sound as three 12-character hashes, never \"na\"",
    Boolean(joinValues) && joinValues.platform === "iphone" && hashed(joinValues) && typeof joinValues.hourCycle === "string",
    asText(joinValues),
  );
  // The page's `!me` guard: a browser that knows somebody reads no hint and mounts no question, so it sends no values.
  const sentBefore = safari.hintCalls();
  await safari.page.goto(`${BASE}/${code}`);
  await settle(safari.page);
  check("a browser that knows somebody is never asked, and sends no values", safari.hintCalls() === sentBefore && (await safari.page.getByTestId("welcome-back").count()) === 0, `${sentBefore} -> ${safari.hintCalls()}`);

  // ---- The same phone, another browser, while Tim's record has only a match to come: the second Tim ----
  const fresh = await browserOn(TIMS_PHONE);
  await openAsked(fresh, code);
  check("a record minutes old with only a match to come is asked about nowhere: the server answers nothing", fresh.hintCalls() === 1 && (await fresh.page.getByTestId("welcome-back").count()) === 0, String(fresh.hintCalls()));
  await fresh.ctx.close();

  // ---- The same phone in a European zone: nothing written to the tab, nothing sent ----
  const madrid = await browserOn({ ...TIMS_PHONE, timezoneId: "Europe/Madrid" });
  await madrid.page.goto(`${BASE}/${code}`);
  await settle(madrid.page);
  const madridNote = await madrid.page.evaluate((key) => window.sessionStorage.getItem(key), `km_hint_asked:${code}`);
  check("a browser in Europe/Madrid writes no note to the tab and calls nothing", madridNote === null && madrid.calls() === 0 && (await madrid.page.getByTestId("welcome-back").count()) === 0, `${madridNote} ${madrid.calls()}`);
  await madrid.ctx.close();

  // ---- Tim sits beside Kai in a match under way: now his record has a past ----
  await safari.page.goto(`${BASE}/${underWay}`);
  await safari.page.getByRole("button", { name: "Join this match" }).click();
  await safari.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  await safari.page.waitForTimeout(1000);
  check("Tim's second join keeps the same one key", (await hintsOf(NAME)) === 1);

  // ---- The same phone, another browser: the question, in three languages ----
  for (const [lang, words] of [
    ["ru", { ask: "С возвращением, Tim?", yes: "Да, это я", no: "Это не я" }],
    ["es", { ask: "¿Hola de nuevo, Tim?", yes: "Sí, soy yo", no: "No soy yo" }],
  ]) {
    const other = await browserOn(TIMS_PHONE, lang);
    await openAsked(other, code);
    const q = other.page.getByTestId("welcome-back");
    await q.waitFor({ timeout: 15000 });
    await q.scrollIntoViewIfNeeded();
    const text = (await q.innerText()).replace(/\s+/g, " ");
    check(
      `${lang}: the question and its two buttons, in the page's language`,
      text.includes(words.ask) && (await q.getByRole("button", { name: words.yes, exact: true }).count()) === 1 && (await q.getByRole("button", { name: words.no, exact: true }).count()) === 1,
      text,
    );
    await view(other.page, `device-hints-01-welcome-back-${lang}-390`);
    await other.ctx.close();
  }

  const app = await browserOn(TIMS_PHONE);
  await openAsked(app, code);
  const question = app.page.getByTestId("welcome-back");
  await question.waitFor({ timeout: 15000 });
  await question.scrollIntoViewIfNeeded();
  const qText = (await question.innerText()).replace(/\s+/g, " ");
  check("a browser on the same phone that knows nobody is asked \"Welcome back, Tim?\", by the first name alone", qText.includes("Welcome back, Tim?") && !qText.includes("Hint"), qText);
  const yes = question.getByRole("button", { name: "It's me", exact: true });
  const no = question.getByRole("button", { name: "Not me", exact: true });
  check("the question has \"It's me\" and \"Not me\", and no other button", (await yes.count()) === 1 && (await no.count()) === 1 && (await question.getByRole("button").count()) === 2);
  const box = await question.boundingBox();
  check("the question fits a 390 px phone", Boolean(box) && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  await view(app.page, "device-hints-01-welcome-back-en-390");
  const askedOnce = app.calls();
  check("the browser asked once", askedOnce === 1, String(askedOnce));
  // The key's second version: another browser on the same iPhone runs the three tests again and sends exactly the values of Tim's join, the three hashes and the five settings included.
  const askedWith = app.sent().at(-1) ?? null;
  check("the question sends exactly the values of Tim's join in Safari, the same three hashes: one key for two browsers on one iPhone, and no picture", hashed(askedWith) && asText(askedWith) === asText(joinValues) && !app.lastValues().includes("data:image"), `${asText(askedWith)} vs ${asText(joinValues)}`);
  await yes.click();
  await app.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  check("\"It's me\" sends exactly the values that the question sent", app.sent().length === 2 && asText(app.sent()[1]) === asText(askedWith), `${app.sent().length} ${asText(app.sent().at(-1))}`);
  check("\"It's me\" signs this browser in as Tim, and no second Tim is made", (await recordsNamed(NAME)) === 1);
  check("signed in, the question is gone", (await app.page.getByTestId("welcome-back").count()) === 0);
  await view(app.page, "device-hints-02-signed-in-en-390");

  // ---- Another phone: another screen, the same language and zone. Asked nothing ----
  const pixel = await browserOn({ ...TIMS_PHONE, viewport: { width: 412, height: 915 } });
  await openAsked(pixel, code);
  check("a browser with another screen is asked nothing", (await pixel.page.getByTestId("welcome-back").count()) === 0 && (await pixel.page.getByText("Welcome back", { exact: false }).count()) === 0);
  // It runs the three tests too, and its values differ from Tim's in the screen, so its key is another key.
  const pixelValues = pixel.sent()[0] ?? null;
  const pixelDiffers = pixelValues && joinValues ? Object.keys({ ...pixelValues, ...joinValues }).filter((k) => JSON.stringify(pixelValues[k]) !== JSON.stringify(joinValues[k])) : [];
  check(
    "a browser with another screen sends three hashes and another screen than Tim's, so it gives another key",
    hashed(pixelValues) && (pixelDiffers.includes("w") || pixelDiffers.includes("h")) && asText(pixelValues) !== asText(joinValues),
    `differs: ${pixelDiffers.join(", ")}; ${asText(pixelValues)}`,
  );

  // ---- An Android phone in Chromium: the three tests run, and two browsers on the phone draw and play alike ----
  // Each browser knows nobody and opens Tim's match, so the page asks once with its values; the answer is
  // nothing (another phone). A late read gets two more views (`openAsked`).
  const androidValues = [];
  for (let i = 0; i < 2; i++) {
    const android = await browserOn({ ...TIMS_PHONE, userAgent: ANDROID_UA, viewport: { width: 412, height: 915 } });
    await openAsked(android, code);
    androidValues.push(android.sent()[0] ?? null);
    await android.ctx.close();
  }
  const [first, second] = androidValues;
  check(
    "Chromium on an Android phone sends the test picture, the 3D shape and the test sound as three 12-character hashes, never \"na\"",
    first?.platform === "android" && hashed(first) && hashed(second),
    TESTS.map((k) => `${k}=${first?.[k]}/${second?.[k]}`).join(" "),
  );
  const differ = TESTS.filter((k) => first?.[k] !== second?.[k]);
  check("a second browser on the same Android phone gives the same three hashes, and the same values in all", differ.length === 0 && asText(first) === asText(second), differ.length ? `differs: ${differ.join(", ")}` : `${asText(first)} vs ${asText(second)}`);

  // ---- A match where nobody is remembered: the page sends nothing ----
  const quiet = await newMatch(pixel.page, "Chalong Padel", 60);
  const anon = await browserOn(TIMS_PHONE);
  await anon.page.goto(`${BASE}/${quiet}`);
  await settle(anon.page);
  check("an anonymous view of a match where nobody is remembered makes no call", anon.calls() === 0 && (await anon.page.getByTestId("welcome-back").count()) === 0, String(anon.calls()));

  // ---- "Not me": the question goes, and the phone is not asked about Tim again ----
  const stranger = await browserOn(TIMS_PHONE);
  await openAsked(stranger, code);
  const again = stranger.page.getByTestId("welcome-back");
  await again.waitFor({ timeout: 15000 });
  await again.getByRole("button", { name: "Not me", exact: true }).click();
  await again.waitFor({ state: "detached", timeout: 10000 });
  await stranger.page.waitForTimeout(1000);
  check("\"Not me\" takes the question away and forgets this phone for Tim", (await hintsOf(NAME)) === 0);
  check("\"Not me\" sends exactly the values that the question sent", stranger.sent().length === 2 && asText(stranger.sent()[1]) === asText(stranger.sent()[0]), String(stranger.sent().length));
  const later = await browserOn(TIMS_PHONE);
  await later.page.goto(`${BASE}/${code}`);
  await settle(later.page);
  check("the next browser on the phone is asked nothing", (await later.page.getByTestId("welcome-back").count()) === 0);
  const counters = await ask("select key, sum(value)::int as n from metrics_daily where key in ('hint_asked', 'hint_yes', 'hint_no', 'hint_fresh') group by key order by key");
  const n = Object.fromEntries(counters.map((r) => [r.key, r.n]));
  check("the day's counters moved: asked, yes, no and the second Tim", n.hint_asked >= 4 && n.hint_yes >= 1 && n.hint_no >= 1 && n.hint_fresh >= 1, JSON.stringify(n));

  // ---- "Sign out on this browser" takes this phone's key off the record it leaves (DECIDING, "A phone is never shared") ----
  // The browser that "It's me" signed in as Tim acts once more: its join keeps this phone's key for Tim again.
  // Then its "Not you? Sign out" sends the values, and the same request deletes that key from Tim's record.
  // Both acts stay in the page that asked the question, by client-side navigation: the reader runs its tests
  // once in a page (`running`), so the join and the sign-out take the three hashes that the question already
  // has, at once. A `goto` starts a new page, whose first read can be late on a busy machine, and a late read
  // sends nothing: the join then keeps no key, and the sign-out forgets none.
  app.page.on("dialog", (d) => d.accept());
  const sentBeforeJoin = app.hintCalls();
  await app.page.evaluate((path) => window.next.router.push(path), `/${quiet}`);
  await app.page.waitForURL((u) => u.pathname === `/${quiet}`, { timeout: 20000 });
  await app.page.getByRole("button", { name: "Join this match" }).click();
  await app.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  await app.page.waitForTimeout(1000);
  check(
    "a join from the browser that \"It's me\" signed in sends the question's values and keeps this phone's key for Tim again",
    app.hintCalls() === sentBeforeJoin + 1 && asText(app.sent().at(-1)) === asText(askedWith) && (await hintsOf(NAME)) === 1,
    `${sentBeforeJoin} -> ${app.hintCalls()}: ${asText(app.sent().at(-1))}`,
  );
  // "My matches" in the header is a link, so the page and its tests stay.
  await app.page.getByTestId("nav-play").click();
  await app.page.waitForURL((u) => u.pathname === "/me", { timeout: 20000 });
  const sentToSignOut = app.hintCalls();
  await app.page.getByTestId("me-signout").click();
  await app.page.getByText("First time here? Just your name, that's it.").waitFor({ timeout: 20000 });
  check("the sign-out sends this browser's values, and its own request took this phone's key off Tim's record", app.hintCalls() === sentToSignOut + 1 && (await hintsOf(NAME)) === 0, `${sentToSignOut} -> ${app.hintCalls()}`);
  const forgot = await ask("select coalesce(sum(value), 0)::int as n from metrics_daily where key = 'hint_signout'");
  check("the sign-out counts the key it took (hint_signout)", forgot[0]?.n >= 1, JSON.stringify(forgot));
} catch (e) {
  await crashed(browser, results, e);
} finally {
  await browser.close();
}
finish(results);
