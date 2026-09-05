// Venue boards: opt-in listing at create time, the public board, the printable poster,
// unlisting from Edit match, the board's empty state prefilling the venue.
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

try {
  const org = await newPage();
  await org.goto(BASE + "/");
  check("no venue → no listing switch", (await org.getByText("Show on the venue board").count()) === 0);
  await org.getByPlaceholder("e.g. Alex").fill("Vera");
  await org.getByPlaceholder("Court TBD · or type a club").fill("Riverside Padel");
  await org.getByText("Show on the venue board").waitFor({ timeout: 5000 });
  const box = org.getByRole("checkbox");
  check("listing switch appears once a venue is typed, unchecked by default", (await box.count()) === 1 && !(await box.isChecked()));
  await box.check();
  await org.getByRole("button", { name: "Create & get the link" }).click();
  await org.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code = org.url().split("/").slice(-2)[0];
  await org.goto(`${BASE}/${code}`);
  check("match shows the board chip", (await org.getByRole("link", { name: /On the Riverside Padel board/ }).count()) === 1);

  const guest = await newPage();
  await guest.goto(`${BASE}/v/riverside-padel`);
  await shot(guest, "b1-board");
  check("board lists the match with spots left", (await guest.getByRole("heading", { name: "Padel at Riverside Padel" }).count()) === 1 && (await guest.locator(`a[href='/${code}']`).count()) === 1 && (await guest.getByText("3 spots left").count()) === 1);
  await guest.goto(`${BASE}/v/riverside-padel/poster`);
  await shot(guest, "b2-poster");
  check("poster has a QR and the scan line", (await guest.locator("svg").count()) >= 1 && (await guest.getByText("Scan for open padel matches at Riverside Padel").count()) === 1 && (await guest.getByRole("button", { name: /Print/ }).count()) === 1);
  const robots = await guest.request.get(`${BASE}/robots.txt`);
  check("poster pages stay out of the index", (await robots.text()).includes("/v/*/poster"));

  // A second match at the same venue without the switch does not show up.
  const other = await newPage();
  await other.goto(BASE + "/");
  await other.getByPlaceholder("e.g. Alex").fill("Walt");
  await other.getByPlaceholder("Court TBD · or type a club").fill("Riverside Padel");
  await other.getByRole("button", { name: "Create & get the link" }).click();
  await other.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code2 = other.url().split("/").slice(-2)[0];
  await guest.goto(`${BASE}/v/riverside-padel`);
  check("unlisted match is not on the board", (await guest.locator(`a[href='/${code2}']`).count()) === 0 && (await guest.locator(`a[href='/${code}']`).count()) === 1);

  // Organizer unlists from Edit match.
  await org.goto(`${BASE}/${code}`);
  await org.getByRole("button", { name: "Edit match" }).click();
  await org.getByRole("checkbox").uncheck();
  await org.getByRole("button", { name: "Save changes" }).click();
  await org.getByRole("link", { name: /On the Riverside Padel board/ }).waitFor({ state: "detached", timeout: 20000 });
  check("chip gone after unlisting", (await org.getByRole("link", { name: /On the Riverside Padel board/ }).count()) === 0);
  await guest.goto(`${BASE}/v/riverside-padel`);
  check("board shows the empty state with a prefilled create link", (await guest.getByText("Nothing listed at Riverside Padel right now.").count()) === 1 && (await guest.getByRole("link", { name: "Organize one here" }).getAttribute("href")) === "/?venue=Riverside%20Padel");
  await guest.getByRole("link", { name: "Organize one here" }).click();
  await guest.waitForURL(/\/\?venue=/, { timeout: 20000 });
  check("create form prefilled with the venue and the listing on", (await guest.getByPlaceholder("Court TBD · or type a club").inputValue()) === "Riverside Padel" && (await guest.getByRole("checkbox").isChecked()));
  await guest.goto(`${BASE}/v/no-such-venue`);
  check("unknown venue → 404 page", (await guest.getByText("Link not found").count()) > 0 || (await guest.title()).toLowerCase().includes("not found"));
} catch (e) {
  console.error("✗ crashed:", e);
  results.push({ name: "crash", ok: false });
} finally {
  await browser.close();
}
finish(results);
