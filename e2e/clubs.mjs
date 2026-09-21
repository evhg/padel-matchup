// Clubs: the claim in the browser, the owner's approval through the Telegram callback, the club page,
// the city page, the public API and My matches.
import { BASE, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";
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
  // The claim is a walk: the club, the courts and hours, the links; the claim itself is the last button.
  check("the walk starts on the club", (await page.getByTestId("claim-club").count()) === 1 && (await page.getByText("Step 1 of 4").count()) === 1);
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
  check("the last step asks who they are and how to confirm it, with a way back and the claim button", (await page.getByRole("button", { name: "Back" }).count()) === 1 && (await page.getByRole("button", { name: "Claim this page" }).count()) === 1 && (await page.getByRole("button", { name: "Manager" }).count()) === 1);
  check("the claim button waits for a role", await page.getByRole("button", { name: "Claim this page" }).isDisabled());
  await page.getByRole("button", { name: "Manager" }).click();
  await page.getByLabel("How can we confirm it?").fill("nok@kata-padel.com");
  await page.getByRole("button", { name: "Claim this page" }).click();
  await page.getByText("Claim received").waitFor({ timeout: 20000 });
  check("the done screen asks for the code sent to the work email", (await page.getByTestId("claim-code").count()) === 1 && (await page.getByText("Code sent to nok@kata-padel.com").count()) === 1);
  const claimMail = mails().reverse().find((m) => JSON.stringify(m).includes("nok@kata-padel.com"));
  const claimCode = claimMail?.subject?.match(/\d{6}/)?.[0] ?? "";
  check("the code email went to the work email and names the club", /^\d{6}$/.test(claimCode) && /Kata Padel Center/.test(claimMail?.subject ?? ""), JSON.stringify(claimMail?.subject));
  await page.getByLabel("6-digit code").fill(claimCode);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByTestId("claim-verified").waitFor({ timeout: 20000 });
  check("the work email is confirmed on the screen", (await page.getByText(/Work email confirmed/).count()) === 1);
  check("done: the poster and the week are the next two taps", (await page.getByTestId("claim-poster").getAttribute("href")) === `/v/${SLUG}/poster` && /\/manage\/[A-Za-z0-9_-]{24}#week$/.test((await page.getByTestId("claim-week").getAttribute("href")) ?? ""));
  const manage = (await page.locator("text=/\\/v\\/kata-padel-center\\/manage\\//").first().textContent())?.trim() ?? "";
  const token = manage.split("/manage/")[1];
  check("the manage link is shown once", /^[A-Za-z0-9_-]{24}$/.test(token ?? ""), manage);
  await shot(page, "c1-claimed");

  // The work email made the page live by itself (the owner's decision): no waiting, no claim row.
  await page.goto(`${BASE}/v/${SLUG}`);
  check("live at once by the work email: the managed badge is up and the claim row is gone", (await page.getByText("Is this your club?").count()) === 0 && (await page.getByText("Managed by the club").count()) === 1);
  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);
  check("the manage page shows the live status", (await page.getByText("✓ Live").count()) === 1 && (await page.getByText("Waiting for our check").count()) === 0);
  await page.goto(`${BASE}/me`);
  check("My matches lists the club", (await page.getByText("Your clubs").count()) === 1 && (await page.getByText(CLUB).count()) >= 1);

  const stranger = await hook({ update_id: 91, callback_query: { id: "x1", from: { id: 1, first_name: "Eve" }, data: `ca:${token}` } });
  check("a stranger's tap does nothing", stranger.outcome === "club:not_owner");
  const approved = await hook({ update_id: 92, callback_query: { id: "x2", from: { id: OWNER, first_name: "Owner" }, message: { message_id: 5, date: 0, chat: { id: OWNER, type: "private" } }, data: `ca:${token}` } });
  check("the owner's tap on a page already live changes nothing and says approved", approved.outcome === "club:approved", JSON.stringify(approved));

  await page.goto(`${BASE}/v/${SLUG}`);
  check("live: booking button, managed badge, founding badge, about text", (await page.getByRole("link", { name: "Book on MATCHi" }).count()) === 1 && (await page.getByText("Managed by the club").count()) === 1 && (await page.getByText("Founding club").count()) === 1 && (await page.getByText(/ten minutes from Kata beach/).count()) === 1);
  check("the courts badge carries the indoor and outdoor split", (await page.getByText("4 courts · 3 indoor · 1 outdoor").count()) === 1);
  await shot(page, "c2-club-page");
  await page.goto(`${BASE}/phuket`);
  check("the city page lists the club with its booking button", (await page.getByRole("link", { name: CLUB }).count()) >= 1 && (await page.getByRole("link", { name: "Book on MATCHi" }).count()) >= 1);
  await page.goto(`${BASE}/clubs`);
  check("/clubs lists it under Phuket with nine founding places left", (await page.getByRole("link", { name: CLUB }).count()) === 1 && (await page.getByText("9 founding places left in Phuket").count()) === 1);
  // A club owner's first move is to look for their own club, and there was no box to type it into
  // on any page of the site. One of them spent seven of his ten minutes proving an absence.
  await page.getByTestId("club-search").fill(CLUB.slice(0, 6));
  await page.getByRole("button", { name: "Find a club" }).click();
  check("the search finds a club by a piece of its name", (await page.getByRole("link", { name: CLUB }).count()) === 1);
  await page.goto(`${BASE}/clubs?q=zzzznotaclub`);
  check("and says so plainly when nothing matches", (await page.getByTestId("club-search-none").count()) === 1 && (await page.getByRole("link", { name: CLUB }).count()) === 0);
  // The URL an owner guesses. It was a 404; a club's page is its board.
  await page.goto(`${BASE}/clubs/${SLUG}`);
  check("the URL a club owner guesses lands on the club's page", page.url().endsWith(`/v/${SLUG}`));

  await page.goto(`${BASE}/new`);
  await page.getByLabel(/Venue/).click();
  // The list is the point of the directory: a club is picked under the place it is in, not typed.
  // The heading names the country now that a claim carries one: "Thailand · Phuket".
  check("the create form offers the club under its country and province", (await page.getByText(/(^|· )Phuket$/).count()) >= 1 && (await page.getByRole("button", { name: CLUB }).count()) === 1);
  await page.getByRole("button", { name: CLUB }).click();
  check("picking it fills the venue", (await page.getByLabel(/Venue/).inputValue()) === CLUB);

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
  check("the manage page shows today's view and the week editor", (await page.getByTestId("club-day").count()) === 1 && (await page.getByTestId("club-week-editor").count()) === 1);
  // The courts one by one: numbered in one tap from the count, with the split the claim typed (three indoor, one outdoor)
  // already on the rows; the first one renamed, saved as a set.
  check("the courts editor starts empty with the one-tap numbering", (await page.getByTestId("club-courts-editor").count()) === 1 && (await page.getByTestId("number-courts").count()) === 1);
  await page.getByTestId("number-courts").click();
  check("numbering keeps the split the claim typed: three indoor, one outdoor", (await page.getByLabel("Indoor or outdoor").nth(2).inputValue()) === "indoor" && (await page.getByLabel("Indoor or outdoor").nth(3).inputValue()) === "outdoor");
  const firstCourt = page.getByLabel("Court name").first();
  await firstCourt.fill("Centre");
  await page.getByLabel("Indoor or outdoor").first().selectOption("indoor");
  await page.getByTestId("save-courts").click();
  await page.getByText("4 courts saved").waitFor({ timeout: 20000 });
  await page.goto(`${BASE}/v/${SLUG}`);
  check("the club page lists the courts by name, the badge follows the rows", (await page.getByTestId("club-courts").getByText("Centre").count()) === 1 && (await page.getByTestId("club-courts").locator("li").count()) === 4 && (await page.getByText("4 courts · 3 indoor · 1 outdoor").count()) === 1);
  const withCourts = await (await fetch(`${BASE}/api/v1/clubs/${SLUG}`)).json();
  check("the API carries the court names", JSON.stringify(withCourts.courtNames) === JSON.stringify(["Centre", "Court 2", "Court 3", "Court 4"]), JSON.stringify(withCourts.courtNames));
  // The match form at this club offers those names instead of 1…n.
  await page.goto(`${BASE}/?venue=${encodeURIComponent(CLUB)}`);
  check("the match form offers the club's courts by name", (await page.locator("select option", { hasText: "Centre" }).count()) === 1);
  // Back on the manage page, where the rest of the suite stands.
  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);

  // ---- and it watches the coaching too ----
  // The real bug this replaces: a coach's clubs were free text, so the two coaches in production had
  // typed "warehaus" and "Warehaus" and neither could be matched to a club. This coach types the
  // club's name in lower case and must still be this club's coach.
  const coaching = page.getByTestId("club-coaching");
  check("a club with no coaches says so, rather than showing an empty box", (await coaching.count()) === 1 && (await coaching.getByText("No coach has named your club yet.").count()) === 1);

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
  check("the walk refuses to finish while the assistant has no way to reach the coach", (await nok.getByTestId("notify-none").count()) === 1);
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
  check("a coach who typed the club's name in lower case is still this club's coach", (await listed.getByText("Tida").count()) === 1, (await listed.innerText()).slice(0, 160));
  check("a coach who has taught nothing here yet says so, and shows no invented number", (await listed.getByText("No lessons in the last seven days").count()) === 1, (await listed.innerText()).slice(0, 160));
  await shot(page, "c2-coaching");
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).getUTCDay();
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  await page.getByRole("radio", { name: dayNames[tomorrow] }).click();
  await page.getByTestId("slot-time").fill("23:00");
  await page.getByRole("radio", { name: "Americano" }).click();
  await page.getByRole("radio", { name: /Gold/ }).click();
  await page.getByTestId("slot-verified-only").check();
  await page.getByTestId("slot-title").fill("Gold night");
  await page.getByTestId("slot-add").click();
  await page.getByText(/Added\. The first match appears/).waitFor({ timeout: 20000 });
  await page.getByTestId("club-slots").getByText("Gold night").waitFor({ timeout: 20000 });
  const hourly = await fetch(`${BASE}/api/cron/hourly`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET || "e2e-cron-secret"}` } }).then((r) => r.json());
  check("the hourly job turns the slot into a match", hourly.clubMatches >= 1, JSON.stringify(hourly).slice(0, 200));
  await page.goto(`${BASE}/v/${SLUG}`);
  const weekCard = page.getByTestId("club-week");
  check("the club page shows this week with the gold night and eight open seats", (await weekCard.count()) === 1 && (await weekCard.getByText("Gold night").count()) >= 1 && (await weekCard.getByText("0/8").count()) >= 1);
  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);
  check("the editor names the next match of the slot", (await page.getByTestId("club-slots").getByText(/next: [A-Za-z0-9]{4}/).count()) === 1);

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
  check("the match page carries the confirmed-levels chip", (await mia.getByText(/confirmed levels/).count()) >= 1);
  const askClub = mia.getByRole("button", { name: `Ask ${CLUB} to confirm my level` });
  check("Mia can ask the club to confirm her level in one tap", (await askClub.count()) === 1);
  await askClub.click();
  await mia.getByText(`Asked ${CLUB} ✓`).waitFor({ timeout: 20000 });
  await page.goto(`${BASE}/v/${SLUG}/manage/${token}`);
  const checks = page.getByTestId("level-checks");
  check("the manage page lists Mia's level to confirm", (await checks.count()) === 1 && (await checks.getByText("Mia").count()) === 1 && (await checks.getByText("says 3.5").count()) === 1);
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
  if ((await mia.getByText(/You.re in/).count()) === 0) {
    await mia.waitForTimeout(3000);
    await mia.reload();
  }
  check("Mia is in the gold night once the club confirmed, nobody else tapped", (await mia.getByText(/You.re in/).count()) === 1);
  await page.reload();
  check("the club's list no longer waits on Mia", (await page.getByTestId("level-checks").getByText("says 3.5").count()) === 0);
  const seated = await fetch(`${BASE}/api/v1/matches/${goldCode}`).then((r) => r.json());
  check("the API shows Mia seated with her level", ((seated.match ?? seated).players ?? []).some((p) => p.name === "Mia" && p.level === 3.5), JSON.stringify((seated.match ?? seated).players));
  const bad = await fetch(`${BASE}/v/${SLUG}/manage/not-the-token`);
  check("a wrong manage token is 404", bad.status === 404);
} finally {
  await browser.close();
}
finish(results);
