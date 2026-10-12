// Clubs: the claim in the browser, the owner's approval through the Telegram callback, the club page,
// the city page, the public API and My matches.
import { BASE, finish, iphone, launch, lessonDay, makeCheck, shot, sitsInside } from "./lib.mjs";
import { existsSync, readFileSync } from "node:fs";
/** Every email the build wrote instead of sending, oldest first. */
const mails = () => (process.env.EMAIL_SINK_FILE && existsSync(process.env.EMAIL_SINK_FILE) ? readFileSync(process.env.EMAIL_SINK_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const browser = await launch();
const results = [];
const check = makeCheck(results);
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "e2e-tg-secret";
const OWNER = Number(process.env.TELEGRAM_OWNER_ID || 777001);
const hook = (update) => fetch(`${BASE}/api/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify(update) }).then((r) => r.json());
const CLUB = "Kata Padel Center";
/**
 * Counts a locator once it has painted. count() reads the page at one instant, and under the gate's full
 * browser run a server page can still be painting after a goto or an action: the core suite met it on
 * 10 October 2026 ("Link not found"), and this suite the same day. It waits up to 15 s for the first
 * match and then counts, so every check stays exactly as strict as it was.
 */
const painted = async (loc, timeout = 15000) => {
  await loc.first().waitFor({ timeout }).catch(() => undefined);
  return loc.count();
};
/** Reads again until the read gives what the check wants, up to 15 s, and returns the last read: for a value a tap changes (an input, a button's state). */
const settles = async (read, ok, timeout = 15000) => {
  const end = Date.now() + timeout;
  let v = await read();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200));
    v = await read();
  }
  return v;
};
const SLUG = "kata-padel-center";

try {
  const created = await fetch(`${BASE}/api/v1/matches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ startsAt: new Date(Date.now() + 5 * 3600 * 1000).toISOString(), tz: "Asia/Bangkok", venue: CLUB, organizer: { name: "Kai" }, listOnVenueBoard: true, bookingUrl: "https://playtomic.io/kata", category: "mixed", ageMin: 45 }) }).then((r) => r.json());
  check("a match at the club exists with a booking link", created.match?.code && created.match.venue?.slug === SLUG, JSON.stringify(created).slice(0, 200));
  check("the API takes who the match is for and gives it back", created.match?.category === "mixed" && created.match?.ageMin === 45, JSON.stringify({ category: created.match?.category, ageMin: created.match?.ageMin }));

  const ctx = await browser.newContext(iphone);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/${created.match.code}`);
  check("the match page names the booking platform", (await painted(page.getByRole("link", { name: /Book on Playtomic/ }))) === 1);

  await page.goto(`${BASE}/clubs`);
  check("/clubs explains the founding offer", (await painted(page.getByText("Founding clubs"))) >= 1 && (await painted(page.getByRole("link", { name: "Claim your club" }))) >= 1);
  await page.goto(`${BASE}/v/${SLUG}`);
  check("an unclaimed venue page offers the claim", (await painted(page.getByText("Is this your club?"))) === 1);
  await page.getByText("Is this your club?").click();
  await page.waitForURL(/\/clubs\/claim\?name=/);
  check("the claim form is prefilled with the club name", (await page.getByLabel("Club name").inputValue()) === CLUB);
  // The claim is a walk: the club, the courts and hours, the links; the claim itself is the last button.
  check("the walk starts on the club", (await painted(page.getByTestId("claim-club"))) === 1 && (await painted(page.getByText("Step 1 of 4"))) === 1);
  await page.getByLabel("Your name").fill("Nok");
  await page.getByLabel("City").fill("Phuket");
  await page.getByLabel("Country").selectOption("TH");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByTestId("claim-courts").waitFor();
  await page.getByRole("spinbutton", { name: /Courts/ }).fill("4");
  await page.getByRole("spinbutton", { name: "Indoor" }).fill("3");
  await page.getByRole("spinbutton", { name: "Outdoor" }).fill("1");
  await page.getByLabel(/About the club/).fill("Four courts under a roof, ten minutes from Kata beach.");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByTestId("claim-links").waitFor();
  await page.getByLabel("Booking page").fill("https://www.matchi.se/facilities/kata");
  await page.getByLabel("Website").fill("https://kata-padel.com");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByTestId("claim-you").waitFor();
  // The claim's check: who they are and how the club can confirm it. A work email at the club's own
  // domain gets a code; the code goes back; the claim is confirmed by itself before the owner's tap.
  check("the last step asks who they are and how to confirm it, with a way back and the claim button", (await painted(page.getByRole("button", { name: "Back" }))) === 1 && (await painted(page.getByRole("button", { name: "Claim this page" }))) === 1 && (await painted(page.getByRole("button", { name: "Manager" }))) === 1);
  check("the claim button waits for a role", await page.getByRole("button", { name: "Claim this page" }).isDisabled());
  await page.getByRole("button", { name: "Manager" }).click();
  await page.getByLabel("How can we confirm it?").fill("nok@kata-padel.com");
  await page.getByRole("button", { name: "Claim this page" }).click();
  await page.getByText("Claim received").waitFor({ timeout: 20000 });
  check("the done screen asks for the code sent to the work email", (await painted(page.getByTestId("claim-code"))) === 1 && (await painted(page.getByText("Code sent to nok@kata-padel.com"))) === 1);
  const claimMail = mails().reverse().find((m) => JSON.stringify(m).includes("nok@kata-padel.com"));
  const claimCode = claimMail?.subject?.match(/\d{6}/)?.[0] ?? "";
  check("the code email went to the work email and names the club", /^\d{6}$/.test(claimCode) && /Kata Padel Center/.test(claimMail?.subject ?? ""), JSON.stringify(claimMail?.subject));
  await page.getByLabel("6-digit code").fill(claimCode);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByTestId("claim-verified").waitFor({ timeout: 20000 });
  check("the work email is confirmed on the screen", (await painted(page.getByText(/Work email confirmed/))) === 1);
  check("done: the poster and the week are the next two taps", (await page.getByTestId("claim-poster").getAttribute("href")) === `/v/${SLUG}/poster` && /\/manage\/[A-Za-z0-9_-]{24}#week$/.test((await page.getByTestId("claim-week").getAttribute("href")) ?? ""));
  const manage = (await page.locator("text=/\\/v\\/kata-padel-center\\/manage\\//").first().textContent())?.trim() ?? "";
  const token = manage.split("/manage/")[1];
  check("the manage link is shown once", /^[A-Za-z0-9_-]{24}$/.test(token ?? ""), manage);
  await shot(page, "c1-claimed");

  // The work email made the page live by itself (the owner's decision): no waiting, no claim row.
  await page.goto(`${BASE}/v/${SLUG}`);
  check("live at once by the work email: the managed badge is up and the claim row is gone", (await painted(page.getByText("Managed by the club"))) === 1 && (await page.getByText("Is this your club?").count()) === 0);
  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);
  check("the manage page shows the live status", (await painted(page.getByText("✓ Live"))) === 1 && (await page.getByText("Waiting for our check").count()) === 0);
  await page.goto(`${BASE}/me`);
  check("My matches lists the club", (await painted(page.getByText("Your clubs"))) === 1 && (await painted(page.getByText(CLUB))) >= 1);

  const stranger = await hook({ update_id: 91, callback_query: { id: "x1", from: { id: 1, first_name: "Eve" }, data: `ca:${token}` } });
  check("a stranger's tap does nothing", stranger.outcome === "club:not_owner");
  const approved = await hook({ update_id: 92, callback_query: { id: "x2", from: { id: OWNER, first_name: "Owner" }, message: { message_id: 5, date: 0, chat: { id: OWNER, type: "private" } }, data: `ca:${token}` } });
  check("the owner's tap on a page already live changes nothing and says approved", approved.outcome === "club:approved", JSON.stringify(approved));

  await page.goto(`${BASE}/v/${SLUG}`);
  check("live: booking button, managed badge, founding badge, about text", (await painted(page.getByRole("link", { name: "Book on MATCHi" }))) === 1 && (await painted(page.getByText("Managed by the club"))) === 1 && (await painted(page.getByText("Founding club"))) === 1 && (await painted(page.getByText(/ten minutes from Kata beach/))) === 1);
  check("the courts badge carries the indoor and outdoor split", (await painted(page.getByText("4 courts · 3 indoor · 1 outdoor"))) === 1);
  await shot(page, "c2-club-page");
  await page.goto(`${BASE}/phuket`);
  check("the city page lists the club with its booking button", (await painted(page.getByRole("link", { name: CLUB }))) >= 1 && (await painted(page.getByRole("link", { name: "Book on MATCHi" }))) >= 1);
  await page.goto(`${BASE}/clubs`);
  check("/clubs lists it under Phuket with nine founding places left", (await painted(page.getByRole("link", { name: CLUB }))) === 1 && (await painted(page.getByText("9 founding places left in Phuket"))) === 1);
  // A club owner's first move is to look for their own club, and there was no box to type it into
  // on any page of the site. One of them spent seven of his ten minutes proving an absence.
  await page.getByTestId("club-search").fill(CLUB.slice(0, 6));
  await page.getByRole("button", { name: "Find a club" }).click();
  await page.waitForURL(/\/clubs\?q=/, { timeout: 20000 });
  check("the search finds a club by a piece of its name", (await painted(page.getByRole("link", { name: CLUB }))) === 1);
  await page.goto(`${BASE}/clubs?q=zzzznotaclub`);
  check("and says so plainly when nothing matches", (await painted(page.getByTestId("club-search-none"))) === 1 && (await page.getByRole("link", { name: CLUB }).count()) === 0);
  // The URL an owner guesses. It was a 404; a club's page is its board.
  await page.goto(`${BASE}/clubs/${SLUG}`);
  check("the URL a club owner guesses lands on the club's page", page.url().endsWith(`/v/${SLUG}`));

  await page.goto(`${BASE}/new`);
  await page.getByLabel(/Venue/).click();
  // The list is the point of the directory: a club is picked under the place it is in, not typed.
  // The heading names the country now that a claim carries one: "Thailand · Phuket".
  check("the create form offers the club under its country and province", (await painted(page.getByText(/(^|· )Phuket$/))) >= 1 && (await painted(page.getByRole("button", { name: CLUB }))) === 1);
  await page.getByRole("button", { name: CLUB }).click();
  check("picking it fills the venue", (await settles(() => page.getByLabel(/Venue/).inputValue(), (v) => v === CLUB)) === CLUB);

  const api = await fetch(`${BASE}/api/v1/clubs/${SLUG}`).then((r) => r.json());
  check("the API shows the club without anything private", api.booking?.platform === "matchi" && api.founding === true && api.courts === 4 && api.courtsIndoor === 3 && api.courtsOutdoor === 1 && api.country === "TH" && api.province === "Phuket" && !JSON.stringify(api).includes(token));
  const list = await fetch(`${BASE}/api/v1/clubs?city=phuket`).then((r) => r.json());
  check("the city list carries it", Array.isArray(list.clubs) && list.clubs.some((c) => c.slug === SLUG));
  const missing = await fetch(`${BASE}/api/v1/clubs/nowhere-club`);
  check("unknown clubs are 404", missing.status === 404);
  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  check("sitemap lists /clubs and the live club page", sitemap.includes("/clubs") && sitemap.includes(`/v/${SLUG}`));

  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);
  await page.getByLabel("Booking page").fill("https://playtomic.io/kata-center");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved").waitFor({ timeout: 15000 });
  const after = await fetch(`${BASE}/api/v1/clubs/${SLUG}`).then((r) => r.json());
  check("edits through the manage link go live at once", after.booking?.platform === "playtomic");

  // ---- The club watches: one slot on the week, the hourly job makes the match, players see it ----
  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);
  check("the manage page shows today's view and the week editor", (await painted(page.getByTestId("club-day"))) === 1 && (await painted(page.getByTestId("club-week-editor"))) === 1);
  // The courts one by one: numbered in one tap from the count, with the split the claim typed (three indoor, one outdoor)
  // already on the rows; the first one renamed, saved as a set.
  check("the courts editor starts empty with the one-tap numbering", (await painted(page.getByTestId("club-courts-editor"))) === 1 && (await painted(page.getByTestId("number-courts"))) === 1);
  await page.getByTestId("number-courts").click();
  const split = () => Promise.all([2, 3].map((n) => page.getByLabel("Indoor or outdoor").nth(n).inputValue({ timeout: 15000 })));
  check("numbering keeps the split the claim typed: three indoor, one outdoor", JSON.stringify(await settles(split, (v) => v[0] === "indoor" && v[1] === "outdoor")) === JSON.stringify(["indoor", "outdoor"]));
  const firstCourt = page.getByLabel("Court name").first();
  await firstCourt.fill("Centre");
  await page.getByLabel("Indoor or outdoor").first().selectOption("indoor");
  await page.getByTestId("save-courts").click();
  await page.getByText("4 courts saved").waitFor({ timeout: 20000 });
  await page.goto(`${BASE}/v/${SLUG}`);
  check("the club page lists the courts by name, the badge follows the rows", (await painted(page.getByTestId("club-courts").getByText("Centre"))) === 1 && (await painted(page.getByTestId("club-courts").locator("li"))) === 4 && (await painted(page.getByText("4 courts · 3 indoor · 1 outdoor"))) === 1);
  const withCourts = await (await fetch(`${BASE}/api/v1/clubs/${SLUG}`)).json();
  check("the API carries the court names", JSON.stringify(withCourts.courtNames) === JSON.stringify(["Centre", "Court 2", "Court 3", "Court 4"]), JSON.stringify(withCourts.courtNames));
  // The day grid is quiet when there is nothing on: a club with courts and an empty day reads no
  // grid at all, rather than an empty one claiming something. The laying-out itself is proven in
  // tests/court-day.test.ts, where a fixed clock costs nothing.
  // The match form at this club offers those names instead of 1…n.
  await page.goto(`${BASE}/?venue=${encodeURIComponent(CLUB)}`);
  check("the match form offers the club's courts by name", (await painted(page.locator("select option", { hasText: "Centre" }))) === 1);
  // Back on the manage page, where the rest of the suite stands.
  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);

  // ---- and it watches the coaching too ----
  // The real bug this replaces: a coach's clubs were free text, so the two coaches in production had
  // typed "warehaus" and "Warehaus" and neither could be matched to a club. This coach types the
  // club's name in lower case and must still be this club's coach.
  const coaching = page.getByTestId("club-coaching");
  check("a club with no coaches says so, rather than showing an empty box", (await painted(coaching)) === 1 && (await painted(coaching.getByText("No coach has named your club yet."))) === 1);

  const coachCtx = await browser.newContext(iphone);
  const nok = await coachCtx.newPage();
  await nok.goto(`${BASE}/coach`);
  await nok.getByPlaceholder("e.g. Alex").fill("Tida");
  await nok.locator("form button[type=submit]").click();
  await nok.getByTestId("setup-where").waitFor({ timeout: 20000 });
  await nok.locator("#coach-clubs").fill(CLUB.toLowerCase());
  await nok.getByRole("button", { name: "Next" }).click();
  await nok.getByTestId("setup-length").waitFor({ timeout: 10000 });
  await nok.getByRole("button", { name: "Next" }).click();
  await nok.getByTestId("setup-hours").waitFor({ timeout: 10000 });
  await nok.getByTestId("hours-presets").locator('button[data-preset="both"]').click();
  await nok.getByRole("button", { name: "Set up my assistant" }).click();
  await nok.getByTestId("setup-price").waitFor({ timeout: 30000 });
  await nok.getByTestId("price-single").fill("900");
  await nok.getByTestId("pay-at-club").check();
  await nok.getByTestId("price-save").click();
  await nok.getByTestId("setup-notify").waitFor({ timeout: 20000 });
  // Nok has not opened the bot, so there is nowhere to tell her anything. The walk used to let her
  // past on a button reading "Email me instead" that collected no address; now it does not.
  await nok.getByTestId("notify-done").click();
  await nok.getByTestId("notify-none").waitFor({ timeout: 10000 });
  check("the walk refuses to finish while the assistant has no way to reach the coach", (await painted(nok.getByTestId("notify-none"))) === 1);
  const nokEmail = nok.getByTestId("notify-email");
  await nokEmail.locator('input[type="email"]').fill("nok@example.test");
  await nokEmail.getByRole("button", { name: "Save", exact: true }).click();
  await nok.getByTestId("notify-done").click();
  await nok.getByTestId("setup-link").waitFor({ timeout: 20000 });
  await nok.getByTestId("setup-finish").click();
  await nok.waitForURL(/\/coach/, { timeout: 30000 });
  await nok.close();

  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);
  const listed = page.getByTestId("club-coaching");
  check("a coach who typed the club's name in lower case is still this club's coach", (await painted(listed.getByText("Tida"))) === 1, (await listed.innerText()).slice(0, 160));
  check("a coach who has taught nothing here yet says so, and shows no invented number", (await painted(listed.getByText("No lessons in the last seven days"))) === 1, (await listed.innerText()).slice(0, 160));
  await shot(page, "c2-coaching");
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).getUTCDay();
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  await page.getByRole("radio", { name: dayNames[tomorrow] }).click();
  await page.getByTestId("slot-time").fill("23:00");
  await page.getByRole("radio", { name: "Americano" }).click();
  await page.getByRole("radio", { name: /Gold/ }).click();
  await page.getByTestId("slot-verified-only").check();
  // Who the slot's matches are for (the owner's decision of 9 October 2026): one tap, carried to every match.
  await page.getByTestId("slot-category").getByRole("radio", { name: "Women", exact: true }).click();
  await page.getByTestId("slot-title").fill("Gold night");
  await page.getByTestId("slot-add").click();
  await page.getByText(/Added\. The first match appears/).waitFor({ timeout: 20000 });
  await page.getByTestId("club-slots").getByText("Gold night").waitFor({ timeout: 20000 });
  await shot(page, "c3-week-tagged");
  check("the slot's row says who its matches are for, as a checked chip", (await page.getByTestId("slot-row-category").first().getByRole("radio", { name: "Women", exact: true }).getAttribute("aria-checked")) === "true");
  const hourly = await fetch(`${BASE}/api/cron/hourly`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET || "e2e-cron-secret"}` } }).then((r) => r.json());
  check("the hourly job turns the slot into a match", hourly.clubMatches >= 1, JSON.stringify(hourly).slice(0, 200));
  await page.goto(`${BASE}/v/${SLUG}`);
  const weekCard = page.getByTestId("club-week");
  check("the club page shows this week with the gold night and eight open seats", (await painted(weekCard)) === 1 && (await painted(weekCard.getByText("Gold night"))) >= 1 && (await painted(weekCard.getByText("0/8"))) >= 1);
  check("the gold night on the club's week carries the slot's tag", (await painted(weekCard.getByText("Women", { exact: true }))) >= 1);
  // On a phone each row's chips wrap on a line of their own: the box of every tag chip sits inside its row.
  const taggedRows = weekCard.getByTestId("club-week-row").filter({ has: page.getByTestId("tag-chip") });
  const boxes = [];
  for (let i = 0; i < (await taggedRows.count()); i++) boxes.push(await sitsInside(page, taggedRows.nth(i).getByTestId("tag-chip"), taggedRows.nth(i)));
  check("both tagged nights on the club's week keep their chips inside the row at 390px", boxes.length >= 2 && boxes.every((b) => b.ok), boxes.map((b) => b.detail).join(" "));
  await shot(page, "c4-board-tagged");
  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);
  check("the editor names the next match of the slot", (await painted(page.getByTestId("club-slots").getByText(/next: [A-Za-z0-9]{4}/))) === 1);
  // Retagged in place: no remove-and-add, so the night already made is not made twice, and it follows the tag.
  const rowCategory = page.getByTestId("slot-row-category").first();
  await rowCategory.getByRole("radio", { name: "Mixed", exact: true }).click();
  await rowCategory.locator('[aria-checked="true"]', { hasText: "Mixed" }).waitFor({ timeout: 20000 });
  await fetch(`${BASE}/api/cron/hourly`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET || "e2e-cron-secret"}` } });
  const board = await fetch(`${BASE}/api/v1/boards/${SLUG}`).then((r) => r.json());
  const nights = (board.matches ?? []).filter((m) => m.title === "Gold night");
  check("retagging the slot keeps one gold night, and that night now says Mixed", nights.length === 1 && nights[0].category === "mixed", JSON.stringify(nights.map((m) => [m.code, m.category])));
  await shot(page, "c5-manage-tagged");

  // ---- Confirmed levels only: a declared level asks, the club confirms in one tap, the player is seated ----
  const slotText = (await page.getByTestId("club-slots").getByText(/next: [A-Za-z0-9]{4}/).textContent()) ?? "";
  const goldCode = slotText.match(/next: ([A-Za-z0-9]{4})/)?.[1];
  check("the slot row says its matches take confirmed levels", /confirmed levels/.test(slotText), slotText);
  const gold = await fetch(`${BASE}/api/v1/matches/${goldCode}`).then((r) => r.json());
  check("the API marks the gold night as confirmed levels only", (gold.match ?? gold).level?.verifiedOnly === true, JSON.stringify((gold.match ?? gold).level));
  const asked = await fetch(`${BASE}/api/v1/matches/${goldCode}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Mia", level: 3.5 }) }).then((r) => r.json());
  check("a declared level inside the range lands on the organizer's list, with the confirmation hint", asked.outcome === "requested" && /confirmed levels/.test(asked.next ?? ""), JSON.stringify(asked).slice(0, 200));
  const mia = await (await browser.newContext(iphone)).newPage();
  await mia.goto(`${BASE}/p/${asked.player.personalToken}/${goldCode}`);
  await mia.getByText("Request sent").waitFor({ timeout: 20000 });
  check("the match page carries the confirmed-levels chip", (await painted(mia.getByText(/confirmed levels/))) >= 1);
  const askClub = mia.getByRole("button", { name: `Ask ${CLUB} to confirm my level` });
  check("Mia can ask the club to confirm her level in one tap", (await painted(askClub)) === 1);
  await askClub.click();
  await mia.getByText(`Asked ${CLUB} ✓`).waitFor({ timeout: 20000 });
  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);
  const checks = page.getByTestId("level-checks");
  check("the manage page lists Mia's level to confirm", (await painted(checks)) === 1 && (await painted(checks.getByText("Mia"))) === 1 && (await painted(checks.getByText("says 3.5"))) === 1);
  await page.getByTestId("level-check-confirm").click();
  // The confirmation line is the action's own reply; on a slow runner the refresh can lag behind the write.
  // The state that matters is checked on Mia's page and in the API below, so a late line is not a failure.
  const confirmedLine = await page
    .getByText(/Mia: confirmed at 3\.5, seated in 1 match\./)
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  if (!confirmedLine) console.log("    (confirmation line not painted within 20s; checking the outcome directly)");
  await mia.reload();
  // The seat is the server's: a page loaded before the write lands shows the request, so one more load.
  if (!(await mia.getByText(/You.re in/).waitFor({ timeout: 10000 }).then(() => true, () => false))) await mia.reload();
  check("Mia is in the gold night once the club confirmed, nobody else tapped", (await painted(mia.getByText(/You.re in/))) === 1);
  await page.reload();
  await page.getByTestId("club-week-editor").waitFor({ timeout: 15000 });
  check("the club's list no longer waits on Mia", (await page.getByTestId("level-checks").getByText("says 3.5").count()) === 0);
  const seated = await fetch(`${BASE}/api/v1/matches/${goldCode}`).then((r) => r.json());
  check("the API shows Mia seated with her level", ((seated.match ?? seated).players ?? []).some((p) => p.name === "Mia" && p.level === 3.5), JSON.stringify((seated.match ?? seated).players));
  const bad = await fetch(`${BASE}/v/${SLUG}/manage/not-the-token`);
  check("a wrong manage token is 404", bad.status === 404);

  // Every club on Kicksmash is in Thailand or Singapore. A reader anywhere else read two city
  // headings and nothing addressed to them. The edge names their country; the page answers it.
  const de = await browser.newContext({ ...iphone, extraHTTPHeaders: { ...iphone.extraHTTPHeaders, "x-vercel-ip-country": "DE", "x-vercel-ip-city": "Berlin", "x-vercel-ip-timezone": "Europe/Berlin" } });
  const lars = await de.newPage();
  await lars.goto(`${BASE}/clubs`);
  check("a reader in Germany is told no club there has a page yet", (await painted(lars.getByTestId("clubs-none-here").getByText("No club in Germany has a page here yet."))) === 1);
  check("and is offered the ten founding places in their own city", (await painted(lars.getByTestId("founding-here").getByText(/Berlin/))) === 1);

  const th = await browser.newContext({ ...iphone, extraHTTPHeaders: { ...iphone.extraHTTPHeaders, "x-vercel-ip-country": "TH", "x-vercel-ip-city": "Phuket", "x-vercel-ip-timezone": "Asia/Bangkok" } });
  const nok2 = await th.newPage();
  await nok2.goto(`${BASE}/clubs`);
  await nok2.getByRole("link", { name: CLUB }).first().waitFor({ timeout: 15000 });
  check("a reader in Thailand, where clubs exist, is told nothing of the kind", (await nok2.getByTestId("clubs-none-here").count()) === 0);

  // Anybody lists a club nobody had listed. Not a claim: no role, no work address, no owner's tap.
  check("the country with nothing in it offers the listing door first", (await painted(lars.getByTestId("clubs-add-door"))) === 1);
  await lars.getByTestId("clubs-add-door").click();
  await lars.waitForURL(/\/clubs\/add/);
  await lars.getByLabel("Your name").fill("Lars");
  await lars.getByTestId("add-club-name").fill("Padel Kreuzberg");
  await lars.getByLabel("City").fill("Berlin");
  await lars.getByLabel("Country").selectOption("DE");
  await lars.getByTestId("add-indoor").fill("4");
  await lars.getByTestId("add-outdoor").fill("2");
  check("the button waits until the courts are counted", (await settles(() => lars.getByTestId("add-submit").isEnabled(), (v) => v === true)) === true);
  await lars.getByTestId("add-submit").click();
  await lars.waitForURL(/\/v\/padel-kreuzberg/, { timeout: 20000 });
  check("the club has a page at once", (await painted(lars.getByRole("heading", { name: "Padel Kreuzberg" }))) >= 1);
  check("the page says no club runs it", (await painted(lars.getByTestId("club-unclaimed"))) === 1);
  // Until 11 October 2026 every listed club's badges said "Managed by the club" beside that line.
  check("and wears no managed badge", (await lars.getByText("Managed by the club").count()) === 0);
  check("and names the person who put it on the map", (await painted(lars.getByTestId("club-added-by").getByText("Listed by Lars"))) === 1);
  check("the page shows the court split they gave", (await painted(lars.getByText("6 courts"))) >= 1);
  await lars.goto(`${BASE}/clubs`);
  check("the club is in the German section", (await painted(lars.getByTestId("clubs-country").getByRole("link", { name: "Padel Kreuzberg" }))) >= 1);
  check("and Germany is no longer empty, so the line is gone", (await lars.getByTestId("clubs-none-here").count()) === 0);

  // The same club cannot be listed twice; its real manager claims the page instead, keeping one page.
  const twice = await browser.newContext({ ...iphone, extraHTTPHeaders: { ...iphone.extraHTTPHeaders, "x-vercel-ip-country": "DE" } });
  const bea = await twice.newPage();
  await bea.goto(`${BASE}/clubs/add`);
  await bea.getByLabel("Your name").fill("Bea");
  await bea.getByTestId("add-club-name").fill("Padel Kreuzberg");
  await bea.getByLabel("City").fill("Berlin");
  await bea.getByLabel("Country").selectOption("DE");
  await bea.getByTestId("add-indoor").fill("1");
  await bea.getByTestId("add-submit").click();
  // count() does not wait; the answer comes back from a server action, so wait for the line itself.
  const refused = await bea
    .getByText("This club already has a page here.")
    .waitFor({ timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("a second listing of the same club is refused", refused, bea.url());

  // The public API: the default answer is unchanged, and include=listed is the one that answers
  // "where can I play here?" — an assistant was told nobody had claimed a page while /clubs had 40.
  const claimedOnly = await fetch(`${BASE}/api/v1/clubs`).then((r) => r.json());
  const withListed = await fetch(`${BASE}/api/v1/clubs?include=listed`).then((r) => r.json());
  const slugs = (b) => (b.clubs ?? []).map((c) => c.slug);
  check("the API's default still means clubs that run their own page", !slugs(claimedOnly).includes("padel-kreuzberg") && claimedOnly.include === "claimed", JSON.stringify(slugs(claimedOnly)));
  check("include=listed adds the club a player listed", slugs(withListed).includes("padel-kreuzberg"), JSON.stringify(slugs(withListed)).slice(0, 200));
  check("and every row says whether the club runs the page", (withListed.clubs ?? []).find((c) => c.slug === "padel-kreuzberg")?.claimed === false && (withListed.clubs ?? []).every((c) => typeof c.claimed === "boolean"));

  // A free court offered to a player who asked for that hour (`offerFreeCourts`) opens the match form
  // at the club, on the day, at the hour, in the club's zone. This phone is in Madrid: without the
  // zone from the link, the form would read 14:00 as Madrid's hour, not the club's.
  const courtPage = await (await browser.newContext(iphone)).newPage();
  const courtDay = lessonDay().date;
  await courtPage.goto(`${BASE}/?venue=${encodeURIComponent(CLUB)}&date=${courtDay}&time=14:00&tz=Asia%2FBangkok`);
  await courtPage.waitForLoadState("networkidle");
  const prefilled = [await courtPage.locator('input[type="date"]').inputValue(), await courtPage.locator('input[type="time"]').inputValue(), await courtPage.getByRole("button", { name: "Asia/Bangkok" }).count()];
  check("a free court's link fills the day, the hour and the club's zone", JSON.stringify(prefilled) === JSON.stringify([courtDay, "14:00", 1]), JSON.stringify(prefilled));

  // KicksmashBot names /about in every request it sends a booking platform (DECIDING rule 35). Whoever
  // follows the link finds what it reads, how often, that it stops, and an address to write to.
  await courtPage.goto(`${BASE}/about`);
  const bot = courtPage.locator("#bot");
  const botText = ((await bot.textContent({ timeout: 5000 }).catch(() => "")) ?? "").replace(/\s+/g, " ");
  check("/about says what KicksmashBot reads, how often, and where to write", /KicksmashBot/.test(botText) && /Playtomic/.test(botText) && /15/.test(botText) && (await painted(bot.locator('a[href^="mailto:"]'))) === 1, botText.slice(0, 160));
  // ---- "Book this court" fills Playtomic's own checkout (the owner, 11 October 2026, DECIDING rule 36) ----
  // Before the club shares a feed of its own (the next section), because a club's feed wins over a
  // platform's read: the club moves its booking page to Playtomic for a while, so the reader of free
  // court times reads the platform. The platform is the suites' fake (e2e/fakes/playtomic.mjs, two
  // courts free on every half hour), so nothing here calls Playtomic, and nothing opens the checkout:
  // the checks read the link the page built. The section ends with the club's old link back.
  const PT_LINK = "https://playtomic.com/clubs/e2e-kata";
  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);
  await page.getByLabel("Booking page").fill(PT_LINK);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText(/^Saved/).waitFor({ timeout: 15000 });
  const CRON = { authorization: `Bearer ${process.env.CRON_SECRET || "e2e-cron-secret"}` };
  // The read rides the five-minute push job and runs once in four minutes: make it due, then tick.
  await fetch(`${BASE}/api/admin/metrics`, { method: "POST", headers: { ...CRON, "content-type": "application/json" }, body: JSON.stringify({ key: "cron_scrape_at", value: 0 }) });
  const tick = await fetch(`${BASE}/api/cron/push`, { headers: CRON }).then((r) => r.json());
  check("the push job reads the club on the platform, and the checkout is on", tick.scrape?.platforms?.playtomic?.ok >= 1 && tick.scrape?.platforms?.playtomic?.checkout === "on", JSON.stringify(tick.scrape ?? tick).slice(0, 300));
  // The create form: the platform's free times as chips, and no platform's name on them or under the
  // time (the owner, 11 October 2026: "The chat reply and the time chips show no platform name").
  await page.goto(`${BASE}/?venue=${encodeURIComponent(CLUB)}`);
  await page.getByTestId("length-choice").getByRole("button", { name: "90 min" }).click();
  await page.getByTestId("free-times").waitFor({ timeout: 15000 });
  const ptChip = page.getByTestId("free-chip").first();
  const ptLabel = (await ptChip.innerText()).trim();
  await ptChip.click();
  const ptRead = async () => [await page.locator('input[type="time"]').inputValue(), (await page.getByTestId("free-then").innerText({ timeout: 1000 }).catch(() => "")).trim()];
  const ptFilled = await settles(ptRead, (v) => ptLabel.endsWith(v[0]) && v[1] === "✓ The club shows a free court then.");
  const chipsText = `${await page.getByTestId("free-times").innerText()} | ${ptFilled[1]}`;
  check("the platform's free times are chips, and neither the chips nor the line under the time name the platform", ptLabel.endsWith(ptFilled[0]) && ptFilled[1] === "✓ The club shows a free court then." && !/playtomic/i.test(chipsText), chipsText);
  await page.getByRole("button", { name: "Create & get the link" }).click();
  await page.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const ptCode = page.url().split("/").slice(-2)[0];
  await page.goto(`${BASE}/${ptCode}`);
  const ptBook = page.getByTestId("book-court");
  await ptBook.waitFor({ timeout: 15000 });
  const ptMatch = await fetch(`${BASE}/api/v1/matches/${ptCode}`).then((r) => r.json()).then((j) => j.match ?? j);
  const ptHref = new URL((await ptBook.getAttribute("href")) ?? "about:blank");
  const ptQuery = Object.fromEntries(ptHref.searchParams);
  check(
    "'Book and pay on Playtomic' opens Playtomic's own checkout with the club, a court, the start and the length filled in",
    (await ptBook.innerText()).includes("Book and pay on Playtomic") &&
      `${ptHref.origin}${ptHref.pathname}` === "https://playtomic.com/api/web-app/payments" &&
      ptQuery.type === "CUSTOMER_MATCH" &&
      ptQuery.tenant_id === "e2e0e2e0-0000-4000-8000-000000000001" &&
      /^e2e0c0c[12]-0000-4000-8000-00000000000[12]$/.test(ptQuery.resource_id ?? "") &&
      ptQuery.start === ptMatch.startsAt &&
      ptQuery.duration === "90" &&
      ptQuery.sport_id === "PADEL" &&
      (await ptBook.getAttribute("target")) === "_blank",
    JSON.stringify({ text: await ptBook.innerText(), href: ptHref.toString(), startsAt: ptMatch.startsAt }),
  );
  const ptSlot = await page.getByTestId("book-slot").innerText();
  const ptHint = await page.getByTestId("book-checkout-hint").innerText().catch(() => "");
  check("beside it, the court the link holds, and that Playtomic may ask for its sign-in first", /Court [12]/.test(ptSlot) && ptSlot.includes("90 min") && ptHint.includes("Playtomic may ask you to sign in first"), JSON.stringify({ ptSlot, ptHint }));
  await shot(page, "c9-checkout");
  // The club's old booking page again, which the rest of the suite expects.
  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);
  await page.getByLabel("Booking page").fill("https://playtomic.io/kata-center");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText(/^Saved/).waitFor({ timeout: 15000 });

  // ---- The best times, and a court a player books (DECIDING rule 36) ----
  // Last in the suite, because it adds a feed and a match at the club that nothing above expects.
  // The club shares a feed of its bookings: its own match calendar, which this build serves and the
  // manage page's save reads once, as the hourly job would.
  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);
  await page.getByRole("button", { name: "Free courts feed" }).click();
  await page.locator('#feed input[type="url"]').fill(`${BASE}/v/${SLUG}/calendar.ics`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText(/^Saved · \d+ free court-hours? today$/).waitFor({ timeout: 20000 });
  // Whether a chip can exist depends on the hour this runs: the club shows free courts until 23:00
  // its time, and the form offers only courts two hours out or more. The API reads the same cache, so
  // the check asks it, and then the form must agree either way: a chip that fills the time, or none.
  const feedNow = await fetch(`${BASE}/api/v1/clubs/${SLUG}`).then((r) => r.json());
  const reachable = (feedNow.freeCourts?.slots ?? []).filter((s) => new Date(s.start).getTime() >= Date.now() + 2 * 3600_000 + 5 * 60_000);
  await page.goto(`${BASE}/?venue=${encodeURIComponent(CLUB)}`);
  await page.getByTestId("length-choice").getByRole("button", { name: "60 min" }).click();
  if (reachable.length > 0) {
    await page.getByTestId("free-times").waitFor({ timeout: 15000 });
    const chip = page.getByTestId("free-chip").first();
    const label = (await chip.innerText()).trim();
    await chip.click();
    // The club's own zone, as its feed was read: the claim took it from the claimant's phone, so it is not Bangkok here.
    const clubTz = String(feedNow.freeCourts?.tz ?? "").replace(/_/g, " ");
    // The time, the zone button and the free-then line paint a moment after the tap: read until they agree.
    const read = async () => [await page.locator('input[type="time"]').inputValue(), await page.getByRole("button", { name: clubTz, exact: true }).count(), (await page.getByTestId("free-then").innerText({ timeout: 1000 }).catch(() => "")).trim()];
    const filled = await settles(read, (v) => label.endsWith(v[0]) && v[1] === 1 && v[2] === "✓ The club shows a free court then.");
    check("the create form offers the club's free time as a chip, and a tap fills the time and the club's zone", clubTz !== "" && label.endsWith(filled[0]) && filled[1] === 1 && filled[2] === "✓ The club shows a free court then.", JSON.stringify({ label, clubTz, filled }));
  } else {
    check("past the club's last free hour, the form offers no free time rather than a guess", (await page.getByTestId("free-times").count()) === 0);
  }
  await page.getByRole("button", { name: "Create & get the link" }).click();
  await page.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const bookedCode = page.url().split("/").slice(-2)[0];
  await page.goto(`${BASE}/${bookedCode}`);
  // The organiser books in the club's own app: the link is the club's booking page, the slot beside it.
  const book = page.getByTestId("book-court");
  check("the organiser gets 'Book this court' to the club's own booking page, with the slot beside it", (await book.innerText()).includes("Book this court") && (await book.getAttribute("href")) === "https://playtomic.io/kata-center" && (await page.getByTestId("book-slot").innerText()).includes("60 min"), await page.getByTestId("court-booking").innerText());
  await page.getByTestId("court-booked-mark").click();
  await page.getByTestId("court-booked").waitFor({ timeout: 15000 });
  check("'I booked it' shows 'Court booked ✓' with who booked it", (await page.getByTestId("court-booked").innerText()).includes("Court booked ✓ (by Nok)"), await page.getByTestId("court-booked").innerText());
  // GET /api/v1/matches/{code} answers with the match itself, not wrapped as a create does.
  const bookedApi = await fetch(`${BASE}/api/v1/matches/${bookedCode}`).then((r) => r.json());
  check("and the API says so, with the booker's first name", (bookedApi.match ?? bookedApi).courtBooked?.by === "Nok", JSON.stringify((bookedApi.match ?? bookedApi).courtBooked));
  // The owner, 12 October 2026: "the not booked button looks confusing". The undo is an action that says what it does.
  const undo = page.getByRole("button", { name: "Mark the court as not booked", exact: true });
  check("the booked line's undo is a small \"Undo\" named \"Mark the court as not booked\", and nothing reads \"Not booked\"", (await undo.count()) === 1 && (await undo.innerText()).trim() === "Undo" && (await page.getByText("Not booked", { exact: true }).count()) === 0, await page.getByTestId("court-booked").innerText());
  await shot(page, "clubs-court-booked-undo");
  await undo.click();
  await page.getByTestId("court-booked-mark").waitFor({ timeout: 15000 });
  check("any player takes it back in one tap", (await page.getByTestId("court-booked").count()) === 0);

  // ---- Paste your booking: a court booked in the club's own app becomes a booked match in one tap ----
  // The owner's case (11 October 2026: a court booked in a platform's app with Danny and Alberto), at
  // the club this suite claimed, pasted as words with no link, so the server reads nothing from
  // outside. The day is three days out in the club's zone (the claim took it from the claimant's
  // phone), written as a booking app writes it, from the moment the suite runs (rule 11). The paste
  // ends with The Padel Society's invitation and a tracking query: the words give the club, the day and
  // the time, so the link is never opened, and the match page shows it as "Join this booking" without
  // the query (the owner, 11 October 2026: "Only made-to-share links").
  const clubZone = String(feedNow.freeCourts?.tz || "Europe/Madrid");
  const pasteAt = new Date(Date.now() + 3 * 86400 * 1000);
  const pasteDay = new Intl.DateTimeFormat("en-CA", { timeZone: clubZone }).format(pasteAt);
  const INVITE = "https://thepadelsociety.app.link/AbCdEf12345";
  const pasteText = `${CLUB} ${new Intl.DateTimeFormat("en-GB", { timeZone: clubZone, weekday: "short", day: "numeric", month: "short" }).format(pasteAt)} 18:00-19:30 court 3 with Danny, Alberto ${INVITE}?_p=c21`;
  await page.goto(`${BASE}/`);
  await page.getByTestId("paste-door").click();
  await page.getByLabel("Paste the booking link and the text from your booking app.").fill(pasteText);
  await page.getByRole("button", { name: "Read my booking" }).click();
  // Watch the address and the answer together: a refused read stays on the page with a sentence.
  const pasteBy = Date.now() + 30_000;
  while (new URL(page.url()).searchParams.get("src") !== "paste" && Date.now() < pasteBy) {
    if (await page.getByTestId("paste-note").count()) throw new Error(`paste refused: ${await page.getByTestId("paste-note").innerText()}`);
    await page.waitForTimeout(250);
  }
  await page.getByTestId("carried-players").waitFor({ timeout: 20000 });
  const pasted = {
    venue: await page.getByLabel(/Venue/).inputValue(),
    date: await page.locator('main input[type="date"]').inputValue(),
    time: await page.locator('main input[type="time"]').inputValue(),
    zone: await page.getByRole("button", { name: clubZone.replace(/_/g, " "), exact: true }).count(),
    length: await page.getByTestId("length-choice").getByRole("button", { name: "90 min" }).getAttribute("aria-pressed"),
    court: await page.getByPlaceholder("e.g. 3 or Centre court").inputValue(),
  };
  check("a pasted booking fills the form: the club, the day, 18:00 in the club's zone, 90 minutes, court 3", JSON.stringify(pasted) === JSON.stringify({ venue: CLUB, date: pasteDay, time: "18:00", zone: 1, length: "true", court: "3" }), JSON.stringify(pasted));
  check("the players come 'from your booking', and nothing is marked missing", (await page.getByTestId("carried-players").innerText()).includes("2 players from your booking") && (await page.getByTestId("carried-players").innerText()).includes("Danny · Alberto") && (await page.getByTestId("paste-missing-when").count()) === 0 && (await page.getByTestId("paste-missing-club").count()) === 0);
  check("'Court booked by me' stands ticked, and the match stays off the venue board", (await page.getByTestId("booked-by-me").isChecked()) && (await page.getByRole("checkbox", { name: /Show on the venue board/ }).isChecked()) === false);
  check("the form says the match page will show the booking's invitation", (await page.getByTestId("paste-invite").innerText().catch(() => "")).includes("join the booking on The Padel Society"), await page.getByTestId("paste-invite").innerText().catch(() => "no paste-invite"));
  check("and the form shows that link itself, without its query string, so the organiser sees what the match will show", (await page.getByTestId("paste-invite-link").innerText().catch(() => "")) === "thepadelsociety.app.link/AbCdEf12345", await page.getByTestId("paste-invite-link").innerText().catch(() => "no paste-invite-link"));
  await page.getByRole("button", { name: "Create & get the link" }).click();
  const madeBy = Date.now() + 30_000;
  while (!/\/[^/]{4}\/share$/.test(page.url()) && Date.now() < madeBy) {
    if (await page.getByTestId("create-error").count()) throw new Error(`create refused: ${await page.getByTestId("create-error").innerText()}`);
    await page.waitForTimeout(250);
  }
  const pastedCode = page.url().split("/").slice(-2)[0];
  await page.goto(`${BASE}/${pastedCode}`);
  const pastedRows = await page.locator("main li").allInnerTexts();
  // The count line names the held places, so "Full" or "1 spot left" is not the only hint (the owner, 12 October 2026).
  const pastedCount = (await page.getByTestId("count-line").innerText().catch(() => "")).trim();
  check("one tap made the match with Danny and Alberto held, and the count line says so", ["Danny", "Alberto"].every((x) => pastedRows.some((r) => r.includes(`Reserved for ${x}`))) && pastedCount === "1 spot left · 2 places held for Danny, Alberto", JSON.stringify({ count: pastedCount, rows: pastedRows.slice(0, 4) }).slice(0, 260));
  check("and the court shows booked by the organiser", (await page.getByTestId("court-booked").innerText().catch(() => "")).includes("Court booked ✓ (by Nok)"), await page.getByTestId("court-booked").innerText().catch(() => "no court-booked"));
  const join = page.getByTestId("join-booking");
  const joinLine = { n: await painted(join), text: await join.innerText().catch(() => ""), href: await join.getAttribute("href").catch(() => null), target: await join.getAttribute("target").catch(() => null) };
  check("the match page shows 'Join this booking on The Padel Society' as a plain link, its query string removed", joinLine.n === 1 && joinLine.text.includes("Join this booking on The Padel Society") && joinLine.href === INVITE && joinLine.target === "_blank", JSON.stringify(joinLine));
  const pm = await fetch(`${BASE}/api/v1/matches/${pastedCode}`).then((r) => r.json()).then((j) => j.match ?? j);
  check("the API agrees: the club, 90 minutes, court 3, not listed, booked by Nok", pm.venue?.slug === SLUG && pm.durationMinutes === 90 && pm.venue?.court === "3" && pm.listed === false && pm.courtBooked?.by === "Nok", JSON.stringify({ v: pm.venue, d: pm.durationMinutes, l: pm.listed, b: pm.courtBooked }));

  // A create link anybody can write carries a made-to-share link too (another booking's Playtomic match).
  // The form shows the link itself, not only the platform's name, and one tap keeps it off the match.
  const CRAFTED = "https://playtomic.io/matches/0b0e3c1a-1234-4abc-9def-0123456789ab";
  await page.goto(`${BASE}/?src=paste&venue=${encodeURIComponent(CLUB)}&date=${pasteDay}&time=20:00&tz=${encodeURIComponent(clubZone)}&invite=${encodeURIComponent(CRAFTED)}`);
  await page.getByTestId("paste-invite").waitFor({ timeout: 20000 });
  const craftedShown = await page.getByTestId("paste-invite-link").innerText().catch(() => "");
  check("a crafted create link's invitation shows on the form in full", craftedShown === "playtomic.io/matches/0b0e3c1a-1234-4abc-9def-0123456789ab", craftedShown || "no paste-invite-link");
  // The click lands once React has hydrated the form: tap again until the line goes, for five seconds at most.
  const dropBy = Date.now() + 5000;
  while ((await page.getByTestId("paste-invite").count()) > 0 && (await page.getByRole("button", { name: "Don't show this link" }).count()) > 0 && Date.now() < dropBy) {
    await page.getByRole("button", { name: "Don't show this link" }).click();
    await page.waitForTimeout(250);
  }
  check("one tap on 'Don't show this link' takes it off the form", (await page.getByTestId("paste-invite").count()) === 0);
  await page.getByRole("button", { name: "Create & get the link" }).click();
  const craftedBy = Date.now() + 30_000;
  while (!/\/[^/]{4}\/share$/.test(page.url()) && Date.now() < craftedBy) {
    if (await page.getByTestId("create-error").count()) throw new Error(`create refused: ${await page.getByTestId("create-error").innerText()}`);
    await page.waitForTimeout(250);
  }
  const craftedCode = page.url().split("/").slice(-2)[0];
  await page.goto(`${BASE}/${craftedCode}`);
  await page.locator("main h1").first().waitFor({ timeout: 15000 });
  check("and the match it makes shows no invitation", (await page.getByTestId("join-booking").count()) === 0 && craftedCode !== pastedCode, craftedCode);

} finally {
  await browser.close();
}
finish(results);
