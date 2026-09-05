// Americano tournament journey on a fresh local server (see e2e/run.mjs):
// create with names, invite, generate rounds, enter scores, standings, clone, locale switch.
import { BASE, finish, launch, makeCheck, shot } from "./lib.mjs";
process.on("unhandledRejection", () => {});
const browser = await launch();
const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-US", timezoneId: "Asia/Bangkok" };
const results = [];
const check = makeCheck(results);
const newPage = async () => {
  const ctx = await browser.newContext(iphone);
  const p = await ctx.newPage();
  p.on("dialog", (d) => d.accept());
  p.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  p.on("requestfailed", (r) => console.log(`    FAILED ${r.method()} ${r.url().replace(BASE, "").slice(0, 80)} ${r.failure()?.errorText}`));
  return p;
};
try {
  const a = await newPage();
  // Landing is the form; quick chip; venue left empty; tournament type
  await a.goto(BASE + "/");
  check("landing shows the create form", (await a.getByRole("button", { name: "Create & get the link" }).count()) > 0);
  await a.getByPlaceholder("e.g. Alex").fill("Org");
  await a.getByRole("button", { name: /Tournament/ }).click();
  // start 1h ago so scoring is open
  const past = new Date(Date.now() - 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(past);
  const g = (t) => parts.find((p) => p.type === t).value;
  await a.locator("input[type=date]").fill(`${g("year")}-${g("month")}-${g("day")}`);
  await a.locator("input[type=time]").fill(`${g("hour")}:${g("minute")}`);
  await a.getByLabel("Players").selectOption("8"); // capacity, in fours
  await a.getByRole("button", { name: "Create & get the link" }).click();
  await a.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code = a.url().split("/").slice(-2)[0];
  check("tournament created without a venue", true, code);
  check("share page says tournament is live + Go to tournament", (await a.getByText("Your tournament is live").count()) > 0 && (await a.getByRole("link", { name: /Go to tournament/ }).count()) > 0);
  await a.getByText("Your tournament is live").first().waitFor({ timeout: 20000 });
  await a.waitForTimeout(300);
  check("share page opened at the top", (await a.evaluate(() => window.scrollY)) === 0, String(await a.evaluate(() => window.scrollY)));
  await shot(a, "t1-share");

  // 2 more players join (Org already joined) → 3 names; round 1 needs fours
  const others = [];
  for (const n of ["Bea", "Cal"]) {
    const p = await newPage(n);
    await p.goto(`${BASE}/${code}`);
    await p.getByRole("button", { name: "Join" }).first().click();
    await p.getByPlaceholder("e.g. Alex").fill(n);
    await p.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
    try {
      await p.getByText(/Happening right now|You're in/).first().waitFor({ timeout: 30000 });
    } catch (e) {
      console.log("    join wait failed for", n, "| url:", p.url());
      await shot(p, `fail-${n}`);
      throw e;
    }
    others.push(p);
  }
  await a.goto(`${BASE}/${code}`);
  check("event page shows Court TBD", (await a.getByText("Court TBD").count()) > 0);
  check("americano panel present", (await a.getByText("Americano").count()) > 0);
  check("no courts setting (courts follow players)", (await a.getByLabel("Courts").count()) === 0);
  check("3 names: round 1 blocked with the in-fours hint", (await a.getByRole("button", { name: "Generate round 1" }).isDisabled()) && (await a.getByText(/needs at least 4 names/).count()) > 0);
  // Organizer reserves Zed (name only) → 4 names, one not yet accepted
  await a.getByRole("button", { name: /Open spot/ }).first().click();
  await a.getByPlaceholder("Name").fill("Zed");
  await a.getByRole("button", { name: "Done", exact: true }).click();
  await a.getByText("Reserved for Zed").first().waitFor({ timeout: 20000 });
  check("reserved row says invite not yet accepted (no email sent)", (await a.getByText("Invite not yet accepted").count()) > 0 && (await a.getByText("Invited now").count()) === 0);
  check("buttons read Invite now / Remove player", (await a.getByRole("button", { name: "Invite now" }).count()) > 0 && (await a.getByRole("button", { name: "Remove player" }).count()) > 0);
  check("4 names of 8: auto-shrink note shown", (await a.getByText(/closes the remaining spots/).count()) > 0);
  await a.getByRole("button", { name: "Generate round 1" }).click();
  await a.getByText("Round 1", { exact: true }).waitFor({ timeout: 20000 });
  // Zed has not accepted yet: 3 occupied of a capacity now 4, but Zed is in the round.
  check("round 1 generated with the reserved name, capacity shrunk to 4", (await a.getByText("3/4 players").count()) > 0 && (await a.locator("section#score").getByText("Zed").count()) > 0 && (await a.getByText(/Sitting out:/).count()) === 0, await a.locator("h2").filter({ hasText: /players/ }).innerText());
  check("(you) marks the organizer in the round", (await a.locator("section#score").getByText(/Org \(you\)/).count()) > 0);
  check("rotation hint: 3 rounds for 4 players", (await a.getByText(/3 rounds complete the rotation/).count()) > 0);
  // Court names: rename court 1 → "Centre"
  await a.getByRole("button", { name: /Court 1/ }).first().click();
  await a.getByPlaceholder("Court 1").fill("Centre");
  await a.getByRole("button", { name: "Save court names" }).click();
  await a.locator("section#score").getByText("Centre").first().waitFor({ timeout: 20000 });
  check("court renamed to Centre", (await a.locator("section#score").getByText("Centre").count()) > 0);
  // Half a score is not an error
  await a.locator('input[aria-label="A"]').first().fill("7");
  await a.locator('input[aria-label="A"]').first().blur();
  await a.waitForTimeout(300);
  check("half-entered score says 'Please complete the score', no generic error", (await a.getByText("Please complete the score").count()) > 0 && (await a.getByText("Something went wrong").count()) === 0);
  await a.locator('input[aria-label="A"]').first().fill("");
  await a.locator('input[aria-label="A"]').first().blur();
  await shot(a, "t2-round1");

  // Participant (Bea) enters a score
  const bea = others[0];
  await bea.reload();
  const inputs = bea.locator('input[aria-label="A"], input[aria-label="B"]');
  await inputs.nth(0).fill("16");
  await inputs.nth(1).fill("8");
  await inputs.nth(1).blur();
  await bea.getByText("Saved").waitFor({ timeout: 20000 });
  check("participant saved a match score", true);
  await a.reload();
  check("standings show 16 points leader", (await a.locator("table").getByText("16").count()) > 0);
  await a.getByRole("button", { name: "Generate round 2" }).click();
  await a.getByText("Round 2", { exact: true }).waitFor({ timeout: 20000 });
  check("round 2 generated", true);
  // Organizer scores round 2, then deletes it anyway (confirm dialog auto-accepted)
  await a.locator('input[aria-label="A"]').last().fill("5");
  await a.locator('input[aria-label="B"]').last().fill("3");
  await a.locator('input[aria-label="B"]').last().blur();
  await a.getByText("Saved").waitFor({ timeout: 20000 });
  await a.getByRole("button", { name: /Delete round 2/ }).click();
  await a.getByText("Round 2", { exact: true }).waitFor({ state: "detached", timeout: 20000 });
  check("scored latest round can be deleted", (await a.getByText("Round 2", { exact: true }).count()) === 0 && (await a.getByRole("button", { name: /Delete round 1/ }).count()) > 0);
  await a.getByRole("button", { name: /Finalize scores/ }).click();
  await a.getByText("Scores finalized").waitFor({ timeout: 20000 });
  check("organizer finalized", true);
  await shot(a, "t3-final");
  await bea.reload();
  check("participant inputs locked after finalize", (await bea.locator('input[aria-label="A"]').count()) === 0);
  await bea.goto(`${BASE}/me`);
  check("/me shows placement", (await bea.getByText(/#\d of 4/).count()) > 0);

  // Play again from the tournament page (creator)
  await a.goto(`${BASE}/${code}`);
  await a.getByRole("button", { name: /Play again next week/ }).first().click();
  await a.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code2 = a.url().split("/").slice(-2)[0];
  check("play again created a new event", code2 !== code, code2);
  await a.goto(`${BASE}/${code2}`);
  check("clone is a tournament with organizer joined", (await a.getByText("1/4 players").count()) > 0 && (await a.getByText("Americano").count()) > 0);

  // Locale switch timing
  const t0 = Date.now();
  await a.getByRole("button", { name: "ru", exact: true }).click();
  await a.getByText("Американо").first().waitFor({ timeout: 20000 });
  check("locale switch", true, `${Date.now() - t0}ms`);
  await shot(a, "t4-ru");

  // Manifest + icons
  const man = await a.request.get(`${BASE}/manifest.webmanifest`);
  check("manifest served", man.status() === 200 && (await man.text()).includes('"display":"standalone"'));
  const ico = await a.request.get(`${BASE}/api/icon?size=192`);
  check("icon png", ico.status() === 200 && ico.headers()["content-type"]?.startsWith("image/png"));
} catch (e) {
  console.error("✗ crashed:", e);
  results.push({ name: "crash", ok: false });
} finally {
  await browser.close();
}
finish(results);
