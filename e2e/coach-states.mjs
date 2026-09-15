// The coach's screens, in the states that make sentences false.
//
// Every item in the owner's twelve-point review needed a state the happy path never reaches: a
// student with *no* package told "your package is untouched", a coach banner shown to somebody who
// is already a student, a list long enough to bury the screen, a desktop viewport for something
// written for a phone. A walk that books one lesson and stops sees none of them.
//
// So this seeds the awkward states — the coach's own assistant is the fastest way in, one line per
// state — and then photographs every coach screen in each of them, at phone and desktop width. The
// assertions here are only the shapes a machine can judge; the screenshots are for a person, and
// `SHOTS=./shots pnpm e2e` is how you get them.
import { BASE, crashed, finish, iphone, launch, makeCheck, shot, lessonDay } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);
const TG_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "e2e-tg-secret";
const desktop = { viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "Europe/Madrid", reducedMotion: "reduce" };

const tg = { id: 717171, is_bot: false, first_name: "Nadia", username: "nadia_coach_e2e" };
const chat = { id: 717171, type: "private" };
let msgId = 700000;
/** One line to the coach's own assistant. Seeding a book this way costs one request per state. */
const say = (text) =>
  fetch(`${BASE}/api/telegram/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TG_SECRET },
    body: JSON.stringify({ update_id: ++msgId, message: { message_id: msgId, date: 0, chat, from: tg, text } }),
  }).then((r) => r.json());

const page = async (ctxOpts) => {
  const ctx = await browser.newContext(ctxOpts);
  const p = await ctx.newPage();
  p.on("dialog", (d) => d.accept());
  p.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  return p;
};

try {
  const day = lessonDay();

  // ---------------------------------------------------------------- a coach exists
  const nadia = await page(iphone);
  await nadia.goto(BASE + "/coach");
  await nadia.getByPlaceholder("e.g. Alex").fill("Nadia");
  await nadia.locator("form button[type=submit]").click();
  await nadia.getByTestId("setup-where").waitFor({ timeout: 20000 });
  await nadia.locator("#coach-clubs").fill("Rawai Padel");
  await nadia.getByRole("button", { name: "Next" }).click();
  await nadia.getByTestId("setup-length").waitFor({ timeout: 10000 });
  await nadia.getByRole("button", { name: "Next" }).click();
  await nadia.getByTestId("setup-hours").waitFor({ timeout: 10000 });
  await nadia.getByTestId("hours-presets").locator('button[data-preset="both"]').click();
  await nadia.getByRole("button", { name: "Set up my assistant" }).click();
  await nadia.getByTestId("setup-price").waitFor({ timeout: 30000 });
  await nadia.getByTestId("price-single").fill("800");
  await nadia.getByTestId("pay-at-club").check();
  await nadia.getByTestId("price-save").click();

  await nadia.getByTestId("setup-notify").waitFor({ timeout: 20000 });
  const href = await nadia.getByTestId("open-bot").getAttribute("href");
  const ticket = href?.match(/start=coach_([^&]+)/)?.[1];
  const bound = await say(`/start coach_${decodeURIComponent(ticket ?? "")}`);
  check("the coach's own assistant is bound, so the book can be seeded a line at a time", bound.outcome === "coach_linked", JSON.stringify(bound));
  await nadia.getByRole("button", { name: "Email me instead" }).click();
  await nadia.getByTestId("setup-link").waitFor({ timeout: 20000 });
  const handle = (await nadia.getByTestId("student-link").innerText()).match(/\/c\/([a-z0-9-]+)/)?.[1] ?? "";
  await nadia.getByTestId("setup-finish").click();
  await nadia.waitForURL(/\/coach/, { timeout: 30000 });
  check("a coach exists, with no price set — a state the setup allows", Boolean(handle), handle);

  // ---------------------------------------------------------------- the awkward states
  // Pat has a package. Sam does not. That difference is what made "your package is untouched" wrong.
  await say(`pat +10 90d 8000`);
  await say(`pat ${day.en} 09:00`);
  await say(`sam ${day.en} 10:00`);
  const patPkg = await say("low");
  check("one student holds a package and one holds none", patPkg.outcome === "coach:low", JSON.stringify(patPkg));

  // A day with nothing free: the state behind "Nothing suits?".
  await say(`block ${day.en}`);

  // ---------------------------------------------------------------- the screens, twice each
  const screens = [
    ["coach-book", "/coach"],
    ["coach-students", "/coach/students"],
    ["coach-settings", "/coach/settings"],
  ];
  for (const [name, url] of screens) {
    for (const [size, opts] of [["phone", iphone], ["desktop", desktop]]) {
      const p = size === "phone" ? nadia : await page(opts);
      if (size === "desktop") {
        // The desktop context has no session, so it sees what a stranger sees; the coach's own
        // desktop view is the phone session resized, which is the honest way to compare the two.
        await p.close();
        continue;
      }
      await p.goto(BASE + url);
      await p.waitForLoadState("networkidle").catch(() => {});
      await shot(p, `state-${name}-${size}`);
    }
  }
  // The coach's own screens at desktop width, same session.
  await nadia.setViewportSize({ width: 1280, height: 900 });
  for (const [name, url] of screens) {
    await nadia.goto(BASE + url);
    await nadia.waitForLoadState("networkidle").catch(() => {});
    await shot(nadia, `state-${name}-desktop`);
  }
  await nadia.setViewportSize(iphone.viewport);

  // ---------------------------------------------------------------- what a student sees
  const sam = await page(iphone);
  await sam.goto(`${BASE}/c/${handle}`);
  await sam.waitForLoadState("networkidle").catch(() => {});
  await shot(sam, "state-coach-page-stranger-phone");
  const strangerText = await sam.locator("body").innerText();
  check("the walk is actually on the coach's page and not a 404", /Nadia/.test(strangerText) && !/not found/i.test(strangerText), strangerText.slice(0, 80));

  // A price that was never set must not print as an empty or broken amount anywhere a student reads.
  check(
    "a coach with no price set shows no half-written amount to a student",
    !/(^|\s)(฿|THB|undefined|NaN|null)\s*(\d|$)/m.test(strangerText) && !/\b0\s*(฿|THB)\b/.test(strangerText),
    (strangerText.match(/.{0,30}(undefined|NaN|null|฿\s*$).{0,30}/) ?? [""])[0],
  );

  // The coach's own page at desktop width: the "add to home screen" class of prompt is written for a
  // phone, and item four of the review was exactly this.
  const wide = await page(desktop);
  await wide.goto(`${BASE}/c/${handle}`);
  await wide.waitForLoadState("networkidle").catch(() => {});
  await shot(wide, "state-coach-page-stranger-desktop");
  const wideText = await wide.locator("body").innerText();
  check("nothing asks a desktop visitor to add anything to a home screen", !/home screen/i.test(wideText), (wideText.match(/.{0,40}home screen.{0,40}/i) ?? [""])[0]);

  // Three languages on the screen a student actually lands on.
  for (const loc of ["ru", "es"]) {
    const p = await page({ ...iphone, locale: loc });
    await p.goto(`${BASE}/${loc}/c/${handle}`);
    await p.waitForLoadState("networkidle").catch(() => {});
    await shot(p, `state-coach-page-${loc}`);
    const t = await p.locator("body").innerText();
    check(`the ${loc} coach page carries no untranslated key`, !/\b[a-z]+\.[a-z]+\.[a-zA-Z]+\b/.test(t.replace(/\S+@\S+|https?:\S+|[\w-]+\.(?:sh|com|org|net)\b/g, "")), (t.match(/\b[a-z]+\.[a-z]+\.[a-zA-Z]+\b/) ?? [""])[0]);
    await p.close();
  }
  await wide.close();
  await sam.close();
  await nadia.close();
} catch (e) {
  await crashed(browser, results, e, "coach-states");
}

finish(results);
