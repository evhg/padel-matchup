// The serious tournament (see e2e/run.mjs): an organiser makes a competition and its categories, a player
// enters with a partner by name, the partner claims the spot by link, the desk fills the field, the ninth
// pair waits and moves up when one withdraws, the organiser marks paid and closes entries; then the draw:
// groups of four made and published, a player scores their own match from the page, a wrong score is
// refused with the rule's name, the table counts it, and the organiser gives a walkover; then the courts: two
// courts and a window, every match a court and a time, the order of play on the page, one match moved; and the
// club's screen with each court's match now and next.
import { BASE, crashed, finish, launch, makeCheck, shot } from "./lib.mjs";
process.on("unhandledRejection", () => {});
const browser = await launch();
const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-US", timezoneId: "Asia/Bangkok", reducedMotion: "reduce" };
const results = [];
const check = makeCheck(results);
const newPage = async () => {
  const ctx = await browser.newContext(iphone);
  const p = await ctx.newPage();
  p.on("dialog", (d) => d.accept());
  p.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  return p;
};
const category = (page, name) => page.locator('[data-testid^="category-"]').filter({ hasText: name });
// Chips are set in capitals by CSS and innerText carries the transform: read everything lower-case.
const low = async (loc) => (await loc.innerText()).toLowerCase();
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
try {
  // 1. The organiser, with no identity yet, makes the competition; it opens on the manage screen.
  const org = await newPage();
  await org.goto(`${BASE}/t/new`);
  await org.getByLabel("Your name").fill("Org");
  await org.getByLabel("Name", { exact: true }).fill("Phuket Open");
  await org.getByLabel("First day").fill(inDays(30));
  await org.getByLabel("Last day").fill(inDays(31));
  await org.getByLabel("Club or venue").fill("Rawai Padel");
  await org.getByLabel("Entry fee and how to pay").fill("1,500 THB per pair, PromptPay 081-234-5678");
  await org.getByRole("button", { name: "Create the tournament" }).click();
  await org.waitForURL(/\/t\/phuket-open\/manage$/, { timeout: 30000 });
  check("competition created and its manage screen opened", true, org.url());
  // The desk opens on how a weekend runs: five stages, entries lit, nothing ticked.
  check("the desk says how a weekend runs, entries first", (await org.getByTestId("weekend-strip").count()) === 1 && (await org.locator('li [data-testid^="stage-"]').count()) === 5 && (await org.getByTestId("stage-entries").getAttribute("aria-current")) === "step" && (await org.getByTestId("stage-hint").innerText()).includes("Enter pairs"));
  await shot(org, "tournament-manage-empty");

  // 2. Two categories: Gold with a band and a field of 8, Mixed with the default.
  const addCat = org.getByTestId("add-category");
  await addCat.getByLabel("Category").fill("Gold");
  await addCat.getByLabel("from").selectOption("4");
  await addCat.getByLabel("Pairs in the draw").selectOption("8");
  await addCat.getByRole("button", { name: "Add" }).click();
  await org.locator('[data-testid^="manage-category-"]').filter({ hasText: "Gold" }).waitFor({ timeout: 20000 });
  await addCat.getByLabel("Category").fill("Mixed");
  await addCat.getByRole("button", { name: "Add" }).click();
  await org.locator('[data-testid^="manage-category-"]').filter({ hasText: "Mixed" }).waitFor({ timeout: 20000 });
  const gold = org.locator('[data-testid^="manage-category-"]').filter({ hasText: "Gold" });
  check("two categories on the manage screen, Gold with its band and field", (await low(gold)).includes("4.0+") && (await low(gold)).includes("0 pairs of 8"));

  // 3. The list page carries it, and the public page shows the categories with a door each.
  const ana = await newPage();
  await ana.goto(`${BASE}/t`);
  check("the tournaments list shows it as open", (await ana.getByTestId("open-tournaments").innerText()).includes("Phuket Open"));
  await ana.goto(`${BASE}/t/phuket-open`);
  check("the public page shows the note, the status and both categories", (await ana.locator("main").innerText()).includes("PromptPay") && (await low(ana.getByTestId("status-chip"))).includes("open for entries") && (await category(ana, "Mixed").count()) === 1);
  await shot(ana, "tournament-public-empty");

  // 4. Ana enters Gold with Boris, who has no account: the pair is in, the partner's link is shown.
  await category(ana, "Gold").getByRole("button", { name: "Enter" }).click();
  await ana.getByLabel("Your name").fill("Ana");
  await ana.getByLabel("Your partner's name").fill("Boris");
  await ana.getByRole("button", { name: "Enter the pair" }).click();
  await ana.getByTestId("entered").waitFor({ timeout: 20000 });
  check("Ana and Boris are in Gold", (await ana.getByTestId("entered").innerText()).includes("You are in Gold."));
  const claimLink = await ana.getByTestId("claim-link").inputValue();
  check("the partner's claim link is on the screen", /\/t\/phuket-open\?claim=[a-z2-9]{12}$/.test(claimLink), claimLink);
  await ana.reload();
  check("the pair is listed, not yet confirmed, and under Your entries", (await category(ana, "Gold").innerText()).includes("Ana & Boris") && (await category(ana, "Gold").innerText()).includes("not confirmed yet") && (await ana.getByTestId("my-entries").innerText()).includes("Boris"));
  await shot(ana, "tournament-public-entered");

  // 5. Boris opens the link, types his name, confirms: the pair is his and the note is gone.
  const boris = await newPage();
  await boris.goto(claimLink);
  await boris.getByTestId("claim-card").waitFor({ timeout: 20000 });
  check("the claim card says whose spot it is", (await boris.getByTestId("claim-card").innerText()).includes("Ana entered you as their partner in Gold"));
  await boris.getByLabel("Your name").fill("Boris R");
  await boris.getByRole("button", { name: "Yes, that's me" }).click();
  await boris.getByText("Confirmed. You are in Gold with Ana.").waitFor({ timeout: 20000 });
  check("Boris confirmed the spot", true);
  await boris.goto(`${BASE}/t/phuket-open`);
  const goldText = await category(boris, "Gold").innerText();
  check("the pair reads Ana & Boris R with no note, and Boris sees it under Your entries", goldText.includes("Ana & Boris R") && !goldText.includes("not confirmed") && (await boris.getByTestId("my-entries").innerText()).includes("Ana"));
  await boris.goto(claimLink);
  check("a spent link says so", (await boris.getByTestId("claim-card").innerText()).includes("used already"));

  // 6. The desk fills Gold to eight; the ninth pair waits.
  await org.reload();
  const desk = org.getByTestId("desk-entry");
  for (let i = 1; i <= 7; i++) {
    await desk.getByLabel("Category").selectOption({ label: "Gold" });
    await desk.getByLabel("Player 1").fill(`Desk${i}`);
    await desk.getByLabel("Player 2").fill(`Mate${i}`);
    await desk.getByRole("button", { name: "Add" }).click();
    await org.locator('[data-testid^="manage-category-"]').filter({ hasText: "Gold" }).filter({ hasText: `Desk${i} & Mate${i}` }).waitFor({ timeout: 20000 });
  }
  check("the desk entered seven pairs", (await low(gold)).includes("8 pairs of 8"));
  const cal = await newPage();
  await cal.goto(`${BASE}/t/phuket-open`);
  await category(cal, "Gold").getByRole("button", { name: "Join the waitlist" }).click();
  await cal.getByLabel("Your name").fill("Cal");
  await cal.getByLabel("Your partner's name").fill("Dee");
  await cal.getByRole("button", { name: "Enter the pair" }).click();
  await cal.getByTestId("entered").waitFor({ timeout: 20000 });
  check("the ninth pair is on the waiting list at number 9", (await cal.getByTestId("entered").innerText()).includes("number 9 on the waiting list"));

  // 7. The organiser marks Ana's pair paid and withdraws a desk pair: Cal and Dee move up.
  await org.reload();
  const anaRow = gold.locator("li").filter({ hasText: "Ana & Boris R" });
  await anaRow.getByRole("button", { name: "Mark paid" }).click();
  await anaRow.getByText("Paid", { exact: true }).waitFor({ timeout: 20000 });
  check("the organiser marked the pair paid", true);
  await gold.locator("li").filter({ hasText: "Desk7 & Mate7" }).getByRole("button", { name: "Withdraw" }).click();
  await org.locator('[data-testid^="manage-category-"]').filter({ hasText: "Gold" }).filter({ hasText: "Desk7 & Mate7" }).waitFor({ state: "detached", timeout: 20000 });
  await cal.reload();
  const goldNow = await category(cal, "Gold").innerText();
  check("Cal and Dee moved up into the field", goldNow.includes("Cal & Dee") && !goldNow.toLowerCase().includes("waiting list") && (await cal.getByTestId("my-entries").innerText()).includes("You are in Gold."));
  await shot(org, "tournament-manage-full");

  // 8. Entries closed: the chip says so and the doors are gone.
  await org.getByRole("button", { name: "Close entries" }).click();
  await org.getByRole("button", { name: "Open entries" }).waitFor({ timeout: 20000 });
  await cal.reload();
  check("closed: the chip says so and no category has a door", (await low(cal.getByTestId("status-chip"))).includes("entries closed") && (await cal.getByRole("button", { name: "Enter" }).count()) === 0);
  // Only the organiser gets the manage screen.
  await cal.goto(`${BASE}/t/phuket-open/manage`);
  await cal.waitForURL(/\/t\/phuket-open$/, { timeout: 20000 });
  check("a player asking for the manage screen lands on the public page", true);

  // 9. The draw for Gold: groups of four, the top two through, made from the desk and looked at before anyone sees it.
  await org.reload();
  const controls = org.locator('[data-testid^="draw-controls-"]').filter({ hasText: "Draw settings · Gold" }); // "Golden point" sits in every card
  await controls.getByRole("button", { name: "Make the draw" }).click();
  await controls.getByRole("button", { name: "Publish the draw" }).waitFor({ timeout: 20000 });
  check("the draw is made and waits for publication", (await low(controls)).includes("draw made") && (await org.getByTestId("group-A").count()) === 1 && (await org.getByTestId("group-B").count()) === 1);
  await cal.reload();
  check("the public page shows no draw before publication", (await cal.getByTestId("groups").count()) === 0);
  await controls.getByRole("button", { name: "Publish the draw" }).click();
  await controls.getByRole("button", { name: "Publish the draw" }).waitFor({ state: "detached", timeout: 20000 });
  await cal.reload();
  const mainDraw = cal.getByTestId("main-draw");
  // A place not decided yet says where it comes from, not "to be decided" (the rehearsal of 24 September 2026).
  check("the public page shows the groups and the main draw, each place named by where it comes from", (await cal.getByTestId("group-A").count()) === 1 && (await mainDraw.count()) === 1 && (await mainDraw.innerText()).includes("Winner of group A") && !(await mainDraw.innerText()).includes("to be decided"));
  await shot(cal, "tournament-draw-public");

  // 10. Cal's own matches come first on his page, each with its form; a score outside the rule is refused by name.
  const myMatches = cal.getByTestId("my-matches");
  const above = async (a, b) => ((await a.boundingBox())?.y ?? 1e9) < ((await b.boundingBox())?.y ?? -1);
  check("Your matches lists Cal's three group matches, above the categories", (await myMatches.locator('[data-testid^="my-match-"]').count()) === 3 && (await above(myMatches, category(cal, "Gold"))));
  check("Cal sees a score form under his three group matches and nobody else's", (await cal.locator('[data-testid^="score-"]').count()) === 3 && (await myMatches.locator('[data-testid^="score-"]').count()) === 3);
  const myForm = cal.locator('[data-testid^="score-"]').first();
  await myForm.getByRole("textbox").fill("6-4");
  // The form names the pair whose games come first, and reads the winner back before the save.
  const firstPair = (await myForm.innerText()).match(/([^\n]+?)'s games first/)?.[1];
  // In his own match the line speaks to Cal: a 6-4 is a win for the pair named first, so it is "You win."
  // when that pair is his, and a loss in the other pair's name when it is not.
  const line = await myForm.getByTestId("winner-line").innerText();
  check("the form says whose games come first and whether a 6-4 wins or loses for Cal", Boolean(firstPair) && (firstPair.startsWith("Cal") ? line === "You win." : line === `${firstPair} win, you lose.`), `${firstPair} / ${line}`);
  await myForm.getByRole("button", { name: "Save the score" }).click();
  await cal.getByText("6-4", { exact: true }).first().waitFor({ timeout: 20000 });
  check("the score is on the page", true);
  const nextForm = cal.locator('[data-testid^="score-"]').first();
  await nextForm.getByRole("textbox").fill("6-5");
  await nextForm.getByRole("button", { name: "Save the score" }).click();
  await nextForm.getByText(/does not fit/).waitFor({ timeout: 20000 });
  check("a score outside the rule is refused with the rule's name", (await nextForm.innerText()).includes("One set to 6"));

  // 11. The organiser's table counts the played match, and a walkover is one tap.
  await org.reload();
  const calRow = org.locator("tr").filter({ hasText: "Cal & Dee" });
  // "6-4" is A then B in the match's own order; Cal's pair is either side, so the table reads 6-4 or 4-6.
  check("the group table counts Cal's played match", /6-4|4-6/.test(await calRow.innerText()));
  // The desk's forms wait behind a tap each, so thirty matches do not open thirty forms.
  check("the desk shows no open score form until asked", (await org.locator('[data-testid^="score-"]').count()) === 0);
  // A pending match, not Cal's finished one (the groups shuffle, so it may come first): only a pending match offers a walkover.
  const pendingLine = org.locator('[data-testid^="match-"]').filter({ hasNotText: "6-4" }).filter({ has: org.getByRole("button", { name: "Score", exact: true }) }).first();
  await pendingLine.getByRole("button", { name: "Score", exact: true }).click();
  const openForm = org.locator('[data-testid^="score-"]').first();
  await openForm.getByRole("button", { name: /Walkover to/ }).first().click();
  await org.getByText("w/o").first().waitFor({ timeout: 20000 });
  check("a walkover is recorded", true);
  await org.reload();
  check("the desk marks a match with a result 'Change the score', and one without 'Score'", (await org.getByRole("button", { name: "Change the score" }).count()) >= 2 && (await org.getByRole("button", { name: "Score", exact: true }).count()) > 0);
  await shot(org, "tournament-draw-manage");

  // 12. Courts and times: two courts, nine to nine, and every match of the draw gets a slot. A fresh page
  // first: a fill during the walkover's pending refresh was lost once.
  await org.reload();
  const courts = org.getByTestId("courts-form");
  await courts.getByLabel("Courts").fill("Court 1\nCourt 2");
  await courts.getByRole("button", { name: "Make the schedule" }).click();
  await courts.getByText(/given a court and a time/).waitFor({ timeout: 30000 });
  check("the schedule is made", (await courts.innerText()).includes("given a court and a time"));
  await org.reload();
  check("the strip ticks entries, the draw and the courts, and lights live", (await org.getByTestId("stage-entries").getAttribute("data-done")) === "1" && (await org.getByTestId("stage-draw").getAttribute("data-done")) === "1" && (await org.getByTestId("stage-courts").getAttribute("data-done")) === "1" && (await org.getByTestId("stage-live").getAttribute("aria-current")) === "step");
  await cal.reload();
  const play = cal.getByTestId("order-of-play");
  check("the public page carries the order of play by day with courts and times", (await play.count()) === 1 && (await play.innerText()).includes("Court 1") && (await play.innerText()).includes("Court 2") && (await cal.locator('[data-testid="match-when"]').count()) > 0);
  // A match already played when the schedule is made keeps no time, so it is not in the order of play:
  // the marked rows are exactly Cal's matches that have a court and a time.
  const timed = await myMatches.locator('[data-testid^="my-match-"]').filter({ hasText: "Court" }).count();
  check("Cal's own matches carry their court and time, and exactly those rows stand out in the order of play", timed >= 1 && (await play.locator('[data-mine="1"]').count()) === timed, `${timed} timed`);
  await shot(cal, "tournament-schedule-public");
  // 13. The organiser moves one match to Court 2 at a time of their choosing.
  await org.reload();
  await org.getByRole("button", { name: "Move", exact: true }).first().click();
  const move = org.locator('[data-testid^="move-"]').first();
  await move.getByLabel("Court").selectOption("Court 2");
  await move.getByLabel("Move").fill(`${inDays(31)}T15:30`);
  await move.getByRole("button", { name: "Move", exact: true }).click();
  await move.waitFor({ state: "detached", timeout: 20000 });
  // The form closes on the action's answer; the order of play follows on the refresh, so wait for the time itself.
  await org.getByTestId("order-of-play").getByText("15:30").first().waitFor({ timeout: 20000 });
  check("a match moved to Court 2 at 15:30 the next day", true);

  // 14. The club's screen: each court, now and next, in big type, from the link on the page.
  await cal.reload();
  await cal.getByTestId("tv-link").click();
  await cal.waitForURL(/\/tv$/, { timeout: 20000 });
  const tv = cal.getByTestId("tv");
  // Court names and "Next" are set in capitals by CSS, and innerText carries the transform.
  const tvText = (await tv.innerText()).toLowerCase();
  check("the live screen shows both courts with a next match each", tvText.includes("court 1") && tvText.includes("court 2") && tvText.includes("next") && (await cal.getByTestId("tv-courts").count()) === 1);
  await shot(cal, "tournament-tv");

  // 15. The extras: the results as a file, and the desk's check-in on a pair.
  const csv = await (await cal.request.get(`${BASE}/t/phuket-open/results.csv`)).text();
  check("the results file has a header and the played match", csv.startsWith("Category,Phase,Round") && /6-4|4-6/.test(csv));
  await org.reload();
  await org.locator('[data-testid^="checkin-"]').first().click();
  await org.getByText("Checked in").first().waitFor({ timeout: 20000 });
  check("the desk checked a pair in", true);
} catch (e) {
  await crashed(browser, results, e);
}
await browser.close();
finish(results);
