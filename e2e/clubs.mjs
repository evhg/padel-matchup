// Clubs: the claim in the browser, the owner's approval through the Telegram callback, the club page,
// the city page, the public API and My matches.
import { BASE, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "e2e-tg-secret";
const OWNER = Number(process.env.TELEGRAM_OWNER_ID || 777001);
const hook = (update) => fetch(`${BASE}/api/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify(update) }).then((r) => r.json());
const CLUB = "Kata Padel Center";
const SLUG = "kata-padel-center";

try {
  const created = await fetch(`${BASE}/api/v1/matches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ startsAt: new Date(Date.now() + 5 * 3600 * 1000).toISOString(), tz: "Asia/Bangkok", venue: CLUB, organizer: { name: "Kai" }, listOnVenueBoard: true, bookingUrl: "https://playtomic.io/kata" }) }).then((r) => r.json());
  check("a match at the club exists with a booking link", created.match?.code && created.match.venue?.slug === SLUG, JSON.stringify(created).slice(0, 200));

  const ctx = await browser.newContext(iphone);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/${created.match.code}`);
  check("the match page names the booking platform", (await page.getByRole("link", { name: /Book on Playtomic/ }).count()) === 1);

  await page.goto(`${BASE}/clubs`);
  check("/clubs explains the founding offer", (await page.getByText("Founding clubs").count()) >= 1 && (await page.getByRole("link", { name: "Claim your club" }).count()) >= 1);
  await page.goto(`${BASE}/v/${SLUG}`);
  check("an unclaimed venue page offers the claim", (await page.getByText("Is this your club?").count()) === 1);
  await page.getByText("Is this your club?").click();
  await page.waitForURL(/\/clubs\/claim\?name=/);
  check("the claim form is prefilled with the club name", (await page.getByLabel("Club name").inputValue()) === CLUB);
  await page.getByLabel("Your name").fill("Nok");
  await page.getByLabel("Booking page").fill("https://www.matchi.se/facilities/kata");
  await page.getByRole("spinbutton", { name: /Courts/ }).fill("4");
  await page.getByLabel("City").selectOption("phuket");
  await page.getByLabel(/About the club/).fill("Four courts under a roof, ten minutes from Kata beach.");
  await page.getByRole("button", { name: "Claim this page" }).click();
  await page.getByText("Claim received").waitFor({ timeout: 20000 });
  const manage = (await page.locator("text=/\\/v\\/kata-padel-center\\/manage\\//").first().textContent())?.trim() ?? "";
  const token = manage.split("/manage/")[1];
  check("the manage link is shown once", /^[A-Za-z0-9_-]{24}$/.test(token ?? ""), manage);
  await shot(page, "c1-claimed");

  await page.goto(`${BASE}/v/${SLUG}`);
  check("pending: the page hides the claim row and shows no club details yet", (await page.getByText("Is this your club?").count()) === 0 && (await page.getByText("Managed by the club").count()) === 0);
  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);
  check("the manage page shows the pending status", (await page.getByText("Waiting for our check").count()) === 1);
  await page.goto(`${BASE}/me`);
  check("My matches lists the club", (await page.getByText("Your clubs").count()) === 1 && (await page.getByText(CLUB).count()) >= 1);

  const stranger = await hook({ update_id: 91, callback_query: { id: "x1", from: { id: 1, first_name: "Eve" }, data: `ca:${token}` } });
  check("a stranger's tap does nothing", stranger.outcome === "club:not_owner");
  const approved = await hook({ update_id: 92, callback_query: { id: "x2", from: { id: OWNER, first_name: "Owner" }, message: { message_id: 5, date: 0, chat: { id: OWNER, type: "private" } }, data: `ca:${token}` } });
  check("the owner's tap approves the club", approved.outcome === "club:approved", JSON.stringify(approved));

  await page.goto(`${BASE}/v/${SLUG}`);
  check("live: booking button, managed badge, founding badge, about text", (await page.getByRole("link", { name: "Book on MATCHi" }).count()) === 1 && (await page.getByText("Managed by the club").count()) === 1 && (await page.getByText("Founding club").count()) === 1 && (await page.getByText(/ten minutes from Kata beach/).count()) === 1);
  await shot(page, "c2-club-page");
  await page.goto(`${BASE}/phuket`);
  check("the city page lists the club with its booking button", (await page.getByRole("link", { name: CLUB }).count()) >= 1 && (await page.getByRole("link", { name: "Book on MATCHi" }).count()) >= 1);
  await page.goto(`${BASE}/clubs`);
  check("/clubs lists it under Phuket with nine founding places left", (await page.getByRole("link", { name: CLUB }).count()) === 1 && (await page.getByText("9 founding places left in Phuket").count()) === 1);

  const api = await fetch(`${BASE}/api/v1/clubs/${SLUG}`).then((r) => r.json());
  check("the API shows the club without anything private", api.booking?.platform === "matchi" && api.founding === true && api.courts === 4 && !JSON.stringify(api).includes(token));
  const list = await fetch(`${BASE}/api/v1/clubs?city=phuket`).then((r) => r.json());
  check("the city list carries it", Array.isArray(list.clubs) && list.clubs.some((c) => c.slug === SLUG));
  const missing = await fetch(`${BASE}/api/v1/clubs/nowhere-club`);
  check("unknown clubs are 404", missing.status === 404);
  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  check("sitemap lists /clubs and the live club page", sitemap.includes("/clubs") && sitemap.includes(`/v/${SLUG}`));

  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);
  await page.getByLabel("Booking page").fill("https://playtomic.io/kata-center");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("Saved").waitFor({ timeout: 15000 });
  const after = await fetch(`${BASE}/api/v1/clubs/${SLUG}`).then((r) => r.json());
  check("edits through the manage link go live at once", after.booking?.platform === "playtomic");
  const bad = await fetch(`${BASE}/v/${SLUG}/manage/not-the-token`);
  check("a wrong manage token is 404", bad.status === 404);
} finally {
  await browser.close();
}
finish(results);
