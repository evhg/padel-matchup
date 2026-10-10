// A fixed-pairs night (the owner's decision F, 9 October 2026), as its six players meet it on a phone:
// the organiser ticks "Fixed pairs", Ana joins with Bo's name and Bo claims the spot by link, Cy joins
// alone as "Partner needed" and Di taps "Be their partner", the organiser names Zed as theirs. Three
// pairs, so round 1 is one court with one pair resting; a score goes in and the table ranks pairs.
import { BASE, BASE_RE, crashed, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";
process.on("unhandledRejection", () => {});
const browser = await launch();
const phone = { ...iphone, timezoneId: "Asia/Bangkok" };
const results = [];
const check = makeCheck(results);
const newPage = async () => {
  const ctx = await browser.newContext(phone);
  const p = await ctx.newPage();
  p.on("dialog", (d) => d.accept());
  p.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  return p;
};
/** The join bar's own form on a fixed-pairs night: the partner's name (may stay empty), then the player's. */
async function joinAs(p, name, partner) {
  await p.getByRole("button", { name: "Join", exact: true }).first().click();
  const form = p.locator("form", { has: p.getByTestId("partner-name") });
  if (partner) await p.getByTestId("partner-name").fill(partner);
  await form.getByPlaceholder("e.g. Alex").fill(name);
  await form.getByRole("button", { name: "Join", exact: true }).click();
}
try {
  const org = await newPage();
  await org.goto(BASE + "/");
  await org.getByPlaceholder("e.g. Alex").fill("Org");
  await org.getByRole("button", { name: /Tournament/ }).click();
  // Tomorrow evening, computed from the moment the suite runs (rule 11): joining and leaving stay open.
  const at = new Date(Date.now() + 26 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const g = (t) => parts.find((p) => p.type === t).value;
  await org.locator("input[type=date]").fill(`${g("year")}-${g("month")}-${g("day")}`);
  await org.locator("input[type=time]").fill(`${g("hour")}:${g("minute")}`);
  await org.getByLabel("Players").selectOption("8");
  check("Fixed pairs is off by default", !(await org.getByTestId("fixed-pairs").isChecked()));
  await org.getByTestId("fixed-pairs").check();
  const plan = await org.getByTestId("night-plan").innerText();
  check("the form speaks of pairs: 4 pairs, 2 courts, 3 rounds of the round robin", plan.startsWith("4 pairs · Needs 2 courts · 3 rounds for the full round robin"), plan);
  await org.getByRole("button", { name: "Create & get the link" }).click();
  await org.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code = org.url().split("/").slice(-2)[0];
  await org.goto(`${BASE}/${code}`);
  check("the night says Fixed pairs", (await org.getByTestId("night-chips").getByText("Fixed pairs").count()) === 1);
  check("the organiser alone reads Partner needed", (await org.getByTestId("single-row").filter({ hasText: "Org" }).getByText("Partner needed").count()) === 1);

  // Ana signs up with Bo's name.
  const ana = await newPage();
  await ana.goto(`${BASE}/${code}`);
  await joinAs(ana, "Ana", "Bo");
  await ana.getByText("You're in with Bo").waitFor({ timeout: 30000 });
  check("Ana and Bo are one row", (await ana.getByTestId("pair-row").filter({ hasText: "Ana" }).filter({ hasText: "Bo" }).count()) === 1);
  await ana.getByRole("button", { name: "Send Bo the link" }).click();
  const hrefs = await ana.locator('a[href^="https://wa.me"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  const boLink = hrefs.map(decodeURIComponent).map((h) => h.match(new RegExp(`(${BASE_RE}/[^/\\s]{4}/i/[^\\s]{6})`))?.[1]).find(Boolean);
  check("Ana holds Bo's link", Boolean(boLink), boLink);
  await shot(ana, "p1-pair");

  // Bo claims the spot by link: the page knows his name, and says who named him.
  const bo = await newPage();
  await bo.goto(boLink);
  check("the link is addressed to Bo, from Ana", (await bo.getByText("Reserved for Bo").count()) > 0 && (await bo.getByText("Ana named you as their partner.").count()) === 1);
  await bo.getByRole("button", { name: /I'm in/ }).click();
  await bo.getByText("You're confirmed").waitFor({ timeout: 20000 });
  await bo.goto(`${BASE}/${code}`);
  check("Bo is in with Ana", (await bo.getByText("You're in with Ana").count()) === 1);

  // The organiser reserves a spot for Rex, a name: Rex is a single nobody else may pair with.
  await org.reload();
  await org.getByRole("button", { name: /Open spot/ }).first().click();
  await org.getByPlaceholder("Name").fill("Rex");
  await org.getByRole("button", { name: "Done", exact: true }).click();
  await org.getByText("Reserved for Rex").first().waitFor({ timeout: 20000 });

  // Cy comes alone; Di is their partner.
  const cy = await newPage();
  await cy.goto(`${BASE}/${code}`);
  check("a stranger holds no partner's link", (await cy.getByRole("button", { name: /^Send .* the link$/ }).count()) === 0);
  await joinAs(cy, "Cy", "");
  await cy.getByText("You're in · Partner needed").waitFor({ timeout: 30000 });
  const di = await newPage();
  await di.goto(`${BASE}/${code}`);
  const cyRow = di.getByTestId("single-row").filter({ hasText: "Cy" });
  check("Cy reads Partner needed, with Be their partner", (await cyRow.getByText("Partner needed").count()) === 1 && (await cyRow.getByRole("button", { name: "Be their partner" }).count()) === 1);
  check("a reserved name offers no Be their partner", (await di.getByTestId("single-row").filter({ hasText: "Rex" }).getByRole("button", { name: "Be their partner" }).count()) === 0);
  await cyRow.getByRole("button", { name: "Be their partner" }).click();
  await cyRow.getByPlaceholder("e.g. Alex").fill("Di");
  await cyRow.getByRole("button", { name: "Be their partner" }).click();
  await di.getByText("You're in with Cy").waitFor({ timeout: 30000 });
  check("Cy and Di are one row", (await di.getByTestId("pair-row").filter({ hasText: "Cy" }).filter({ hasText: "Di" }).count()) === 1);

  // The organiser names a partner of their own.
  await org.reload();
  await org.getByRole("button", { name: "Add your partner" }).click();
  await org.getByLabel("Your partner's name (optional)").fill("Zed");
  await org.getByRole("button", { name: "Save partner" }).click();
  await org.getByText("You're in with Zed").waitFor({ timeout: 30000 });
  check("three pairs on the list, and Rex alone", (await org.getByTestId("pair-row").count()) === 3 && (await org.getByTestId("single-row").count()) === 1);
  await shot(org, "p2-list");

  // Who is here: one tick a pair. Rex, ticked and alone, holds the start until he is unticked.
  const here = org.getByTestId("check-in");
  check("the check-in ticks pairs, and Rex alone", (await here.getByRole("checkbox").count()) === 4 && (await here.getByRole("checkbox", { name: "Ana & Bo" }).isChecked()));
  check("a ticked player without a partner holds the start", (await org.getByRole("button", { name: "Start with 3 pairs" }).isDisabled()) && (await org.getByText("1 player has no partner. Pair them in the list below, or untick them.").count()) === 1);
  await here.getByRole("checkbox", { name: /Rex/ }).uncheck();
  check("the sample speaks of pairs", (await org.getByTestId("night-sample").innerText()).includes("3 pairs: 1 court, two pairs per court, 1 pair rests each round, in turn."));
  await org.getByRole("button", { name: "Start with 3 pairs" }).click();
  await org.getByText("Round 1", { exact: true }).waitFor({ timeout: 20000 });
  const score = org.locator("section#score");
  const pairs = ["Org (you) & Zed", "Ana & Bo", "Cy & Di"];
  const resting = (await score.getByText(/Sitting out:/).innerText()).replace("Sitting out: ", "");
  check("round 1 rests one pair, partners together", pairs.includes(resting), resting);
  // The match card reads "Court 1 / a1 / a2 / vs / b1 / b2": each side must be one of the pairs, and neither the one resting.
  const lines = (await score.getByTestId("match-card").first().innerText()).split("\n").map((l) => l.trim()).filter(Boolean);
  const vs = lines.findIndex((l) => /^vs$/i.test(l));
  const sideA = `${lines[vs - 2]} & ${lines[vs - 1]}`;
  const sideB = `${lines[vs + 1]} & ${lines[vs + 2]}`;
  check("each side is a pair, and the resting pair is not on court", pairs.includes(sideA) && pairs.includes(sideB) && sideA !== sideB && ![sideA, sideB].includes(resting), `${sideA} v ${sideB}`);

  // A score, and the table ranks pairs.
  await score.locator('input[aria-label="A"]').first().fill("21");
  await score.locator('input[aria-label="B"]').first().fill("12");
  await score.locator('input[aria-label="B"]').first().blur();
  await org.getByText("Saved").waitFor({ timeout: 20000 });
  await org.reload();
  const rows = await org.locator("table tbody tr").allInnerTexts();
  check("the table has a row a pair", rows.length === 3 && rows.every((r) => r.includes(" & ")), rows.join(" | "));
  check("the winners lead with 21", /^1\s/.test(rows[0]) && rows[0].includes("21"), rows[0]);
  await shot(org, "p3-table");
} catch (e) {
  await crashed(browser, results, e);
} finally {
  await browser.close();
}
finish(results);
