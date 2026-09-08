// The coach's book: Olga sets up in four taps, Ivan asks to join through her page, Olga accepts and
// starts a package, Ivan books and cancels a lesson himself, Olga books one for him from her book.
import { BASE, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);
const newPage = async () => {
  const ctx = await browser.newContext(iphone);
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  return page;
};
/** Clicks day chips left to right until a time chip shows up, then clicks the first time. */
async function pickFirstFreeTime(_page, scope) {
  const dayChips = scope.locator('button[data-kind="day"]');
  const n = await dayChips.count();
  for (let i = 0; i < Math.min(n, 15); i++) {
    await dayChips.nth(i).click();
    const times = scope.locator('button[data-kind="time"]');
    if ((await times.count()) > 0) {
      const label = await times.first().textContent();
      await times.first().click();
      return label?.trim() ?? "";
    }
  }
  return "";
}

try {
  // Olga: name first, then four taps.
  const olga = await newPage();
  await olga.goto(BASE + "/coach");
  await olga.getByPlaceholder("e.g. Alex").fill("Olga");
  await olga.locator("form button[type=submit]").click();
  await olga.getByText("Your lessons book").first().waitFor({ timeout: 20000 });
  check("setup asks where, how long and when on one screen", (await olga.locator("#coach-clubs").count()) === 1 && (await olga.getByRole("radio", { name: "Both" }).count()) === 1);
  await olga.locator("#coach-clubs").fill("Warehaus");
  await olga.getByRole("button", { name: "Create my book" }).click();
  await olga.waitForURL(/\/coach\?welcome=1$/, { timeout: 30000 });
  await olga.getByText("Your book is ready").waitFor({ timeout: 20000 });
  const body = await olga.locator("main").innerText();
  const handle = body.match(/\/c\/([a-z0-9-]+)/)?.[1];
  check("the welcome card shows the coach's link and a QR", Boolean(handle) && (await olga.locator("main svg").count()) > 0, handle);
  await shot(olga, "60-coach-welcome");

  // Settings: PromptPay and a cutoff, saved once.
  await olga.goto(BASE + "/coach/settings");
  await olga.getByPlaceholder("08x xxx xxxx").fill("0899999999");
  await olga.getByRole("button", { name: "Save" }).click();
  await olga.getByText("Saved.").waitFor({ timeout: 20000 });
  check("settings save with a PromptPay number", true);

  // Ivan finds Olga's page, asks to join.
  const ivan = await newPage();
  await ivan.goto(`${BASE}/c/${handle}`);
  check("the public page names the coach and the club", (await ivan.getByRole("heading", { name: "Olga" }).count()) === 1 && (await ivan.getByText(/at Warehaus/).count()) === 1);
  check("the public page carries structured data and language alternates", (await ivan.locator('script[type="application/ld+json"]').count()) === 1 && (await ivan.locator('link[rel="alternate"][hreflang="ru"]').count()) === 1);
  await ivan.getByPlaceholder("e.g. Alex").fill("Ivan");
  await ivan.getByRole("button", { name: "Ask to become a student" }).click();
  await ivan.getByText(/Asked\. Olga will confirm/).waitFor({ timeout: 20000 });
  check("a newcomer asks to join with just a name", true);

  // Olga accepts and starts a package of ten.
  await olga.goto(BASE + "/coach/students");
  await olga.getByText("Waiting for your yes").waitFor({ timeout: 20000 });
  await olga.getByRole("button", { name: "Accept" }).click();
  await olga.getByRole("button", { name: /New package/ }).waitFor({ timeout: 20000 });
  await olga.getByRole("button", { name: /New package/ }).click();
  await olga.locator('input[type="number"]').nth(2).fill("6000");
  await olga.getByRole("button", { name: "Create package" }).click();
  await olga.getByText(/10 of 10 left · 90 days/).waitFor({ timeout: 20000 });
  check("a package shows lessons left and days left, not paid yet", (await olga.getByText(/Not paid yet/).count()) === 1);
  await olga.getByRole("button", { name: "Show payment QR" }).click();
  await olga.getByText(/Scan to pay Olga · 6000 THB/).waitFor({ timeout: 10000 });
  check("the PromptPay QR renders with the amount", (await olga.locator("main svg").count()) > 0);
  await olga.getByRole("button", { name: "Mark paid" }).click();
  await olga.getByText(/· Paid/).waitFor({ timeout: 20000 });
  await shot(olga, "61-coach-students");

  // Ivan books a free time himself, then cancels in time: the lesson goes back on the package.
  await ivan.reload();
  await ivan.getByRole("heading", { name: "Book a lesson" }).waitFor({ timeout: 20000 });
  const picked = await pickFirstFreeTime(ivan, ivan.locator("main"));
  check("an accepted student sees free times", picked !== "", picked);
  await ivan.getByRole("button", { name: /^Book / }).click();
  await ivan.getByText(/^Booked:/).waitFor({ timeout: 20000 });
  await ivan.getByText(/9 of 10 left/).waitFor({ timeout: 20000 });
  check("booking draws one lesson from the package", true);
  await shot(ivan, "62-student-booked");
  // Depending on the hour this runs, the first free slot may be inside the cutoff: then the free pass covers it. Either way the lesson goes back.
  await ivan.locator("main").getByRole("button", { name: "Cancel" }).first().click();
  await ivan.getByText(/^Cancelled/).waitFor({ timeout: 20000 });
  const cancelNote = await ivan.getByText(/^Cancelled/).textContent();
  await ivan.getByText(/10 of 10 left/).waitFor({ timeout: 20000 });
  check("a cancellation before the cutoff, or covered by the free pass, refunds the lesson", /back on your package|free pass covered/.test(cancelNote ?? ""), cancelNote?.trim());

  // Olga books Ivan from her book in two taps.
  await olga.goto(BASE + "/coach");
  await olga.getByRole("button", { name: "Book a lesson" }).click();
  await olga.locator("#book-student").waitFor({ timeout: 10000 });
  check("the book form offers Ivan", (await olga.locator("#book-student option", { hasText: "Ivan" }).count()) === 1);
  const when = await pickFirstFreeTime(olga, olga.locator("form"));
  await olga.locator("form").getByRole("button", { name: "Book", exact: true }).click();
  await olga.getByText(/^Booked Ivan/).waitFor({ timeout: 20000 });
  check("the coach books a student from the book", when !== "", when);
  await shot(olga, "63-coach-home");

  // Ivan sees it on My matches with the package line.
  await ivan.goto(BASE + "/me");
  await ivan.getByText("Your lessons").waitFor({ timeout: 20000 });
  check("My matches shows the lesson and the package with Olga", (await ivan.getByText("with Olga").count()) === 1 && (await ivan.getByText(/9 of 10 left/).count()) === 1);

  // Russian path renders the coach page in Russian.
  await ivan.goto(`${BASE}/ru/c/${handle}`);
  check("the coach page has a Russian URL", (await ivan.getByText("Тренер по паделу").count()) === 1);
} catch (e) {
  console.error("E2E crashed:", e);
  results.push({ name: "crash", ok: false });
} finally {
  await browser.close();
}

finish(results);
