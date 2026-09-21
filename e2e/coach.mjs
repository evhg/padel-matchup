// The coach's book: Olga walks the six setup steps, Ivan asks to join through her page, Olga accepts and
// starts a package, Ivan books and cancels a lesson himself, Olga books one for him from her book.
import { BASE, crashed, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);
const TG_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "e2e-tg-secret";
const hook = (update) => fetch(`${BASE}/api/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TG_SECRET }, body: JSON.stringify(update) }).then((r) => r.json());
/** What a prompt() answers with. Confirms are accepted either way; a prompt gets this text. */
const promptText = { value: "" };
const newPage = async () => {
  const ctx = await browser.newContext(iphone);
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept(d.type() === "prompt" ? promptText.value : undefined));
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
  await olga.getByText("Your assistant").first().waitFor({ timeout: 20000 });
  // The walk: where, how long, when (that makes the assistant), what a lesson costs, where to be told,
  // and the link for students. No Google Calendar step — it cannot be done in the phone apps at all.
  check("setup starts with where you coach, one question per screen", (await olga.getByTestId("setup-where").count()) === 1 && (await olga.locator("#coach-clubs").count()) === 1 && (await olga.getByText("Step 1 of").count()) === 1);
  await olga.locator("#coach-clubs").fill("Warehaus");
  await olga.getByRole("button", { name: "Next" }).click();
  await olga.getByTestId("setup-length").waitFor({ timeout: 10000 });
  await olga.getByRole("button", { name: "Next" }).click();
  await olga.getByTestId("setup-hours").waitFor({ timeout: 10000 });

  // The hours used to be a grid pre-filled eight to eight, six days a week, so a coach who tapped
  // through sold their whole waking week. Presets come first; the grid is behind one more tap.
  const presets = olga.getByTestId("hours-presets");
  check("hours offer three presets before any grid, and none of them is the whole day", (await presets.locator('button[data-kind="preset"]').count()) === 3 && (await olga.getByTestId("hours-grid").count()) === 0);
  await olga.getByTestId("hours-custom").click();
  const grid = olga.getByTestId("hours-grid");
  check("the per-day grid is still there for a coach who wants it", (await grid.locator('input[type="time"]').count()) === 14);
  await olga.getByTestId("hours-custom").click();
  await presets.locator('button[data-preset="both"]').click();
  // The notice hours are personal, so the walk asks; settings used to be the only place, weeks later.
  await olga.getByTestId("notice-presets").locator('button[data-notice="12"]').click();
  await olga.getByRole("button", { name: "Set up my assistant" }).click();

  await olga.getByTestId("setup-price").waitFor({ timeout: 30000 });
  check("the assistant exists after the third step; the rest can wait", (await olga.getByText(/Your assistant exists/).count()) === 1);
  check("the walk asks what a lesson costs and how students pay, which nothing did before", (await olga.getByTestId("price-single").count()) === 1 && (await olga.getByTestId("pay-at-club").count()) === 1);
  await olga.getByTestId("price-single").fill("800");
  // Benji's card: a second length with its prices, an extra outside the hours, and a package. Each
  // sits behind one line, so a coach with one price still walks the same six short screens.
  await olga.getByTestId("second-open").click();
  await olga.getByTestId("price-second-single").fill("1200");
  await olga.getByTestId("price-second-two").fill("900");
  await olga.getByTestId("fee-open").click();
  await olga.getByTestId("fee").fill("300");
  await olga.getByTestId("offers-open").click();
  await olga.getByTestId("offer-price-0").fill("7000");
  check("the price step takes a second length, an extra outside the hours and a package, each behind one line", (await olga.getByTestId("second-minutes").inputValue()) === "90" && (await olga.getByTestId("offer-size-0").inputValue()) === "10" && (await olga.getByTestId("offer-valid-0").inputValue()) === "70");
  await olga.getByTestId("pay-at-club").check();
  await olga.getByTestId("price-save").click();

  // The bot step: the button carries a signed ticket; opening it binds that Telegram account to Olga.
  await olga.getByTestId("setup-notify").waitFor({ timeout: 20000 });
  const stranger = { id: 616162, is_bot: false, first_name: "Someone", username: "someone_e2e" };
  const href = await olga.getByTestId("open-bot").getAttribute("href");
  const ticket = href?.match(/start=coach_([^&]+)/)?.[1];
  const param = `coach_${decodeURIComponent(ticket ?? "")}`;
  check("the bot link's start parameter is one Telegram accepts (at most 64 of [A-Za-z0-9_-])", param.length <= 64 && /^[A-Za-z0-9_-]+$/.test(param), param);
  check("the bot step opens @kicksmash_bot with a signed ticket", Boolean(ticket), href ?? "");
  const tgOlga = { id: 616161, is_bot: false, first_name: "Olga", username: "olga_coach_e2e" };
  const linked = await hook({ update_id: 900001, message: { message_id: 900001, date: 0, chat: { id: 616161, type: "private" }, from: tgOlga, text: `/start coach_${decodeURIComponent(ticket ?? "")}` } });
  check("opening the bot from the setup binds that Telegram account to the coach", linked.outcome === "coach_linked", JSON.stringify(linked));
  const agenda = await hook({ update_id: 900002, message: { message_id: 900002, date: 0, chat: { id: 616161, type: "private" }, from: tgOlga, text: "tomorrow" } });
  check("the bound account runs the coach's book from the chat", agenda.outcome === "coach:agenda", JSON.stringify(agenda));
  // The ticket is salted with the binding: once Olga is bound, the ticket that bound her is dead.
  const rawTicket = decodeURIComponent(ticket ?? "");
  const replayed = await hook({ update_id: 900003, message: { message_id: 900003, date: 0, chat: { id: 616162, type: "private" }, from: stranger, text: `/start coach_${rawTicket}` } });
  check("the ticket that bound the coach is dead once she is bound: replayed from a second Telegram account it is refused as expired", replayed.outcome === "coach_link_expired", JSON.stringify(replayed));
  await olga.getByTestId("notify-done").click();

  // The walk ends on the link, not on a Done button with the link two screens away.
  await olga.getByTestId("setup-link").waitFor({ timeout: 20000 });
  const walkLink = await olga.getByTestId("student-link").innerText();
  check("the walk ends on the student link, carrying the invite code", /\/c\/[a-z0-9-]+\?i=/.test(walkLink), walkLink);
  check("a coach who already has students is offered the sheet right there", (await olga.getByTestId("setup-import").count()) === 1);
  await olga.getByTestId("setup-finish").click();
  await olga.waitForURL(/\/coach\?welcome=1$/, { timeout: 30000 });
  await olga.getByText("Your assistant is ready").waitFor({ timeout: 20000 });
  const body = await olga.locator("main").innerText();
  const handle = body.match(/\/c\/([a-z0-9-]+)/)?.[1];
  const welcome = olga.getByTestId("coach-welcome");
  // The welcome shows the link and the message to forward; no referral ask and no fence QR on day one.
  const tgHref = await welcome.locator('a[href*="t.me/share"]').getAttribute("href");
  const studentUrl = tgHref ? new URL(tgHref).searchParams.get("url") : null;
  const inviteCode = studentUrl ? new URL(studentUrl).searchParams.get("i") : null;
  check("the welcome card shows the link and a student link that carries the invite code", Boolean(handle) && Boolean(inviteCode) && studentUrl?.includes(`/c/${handle}?i=`), `${handle} ${studentUrl}`);
  check("the fresh welcome asks for no referral and shows no QR", (await welcome.getByText("Know a coach?").count()) === 0 && (await welcome.locator('svg[height="160"]').count()) === 0);
  check("the invite to other coaches waits until the assistant has earned it", (await olga.getByTestId("invite-coach").count()) === 0);
  await shot(olga, "60-coach-welcome");
  await olga.goto(BASE + "/");
  check("the header shows the way back to the assistant for a coach", (await olga.getByTestId("assistant-link").count()) === 1);
  await olga.goto(BASE + "/me");
  check("My matches puts the assistant first for a coach", (await olga.getByTestId("coach-card").count()) === 1 && (await olga.getByText("Nothing booked today").count()) === 1);
  check("My matches keeps the doors, so a coach who lands there can get back", (await olga.getByTestId("assistant-link").count()) === 1);
  // The bug this replaced: the header asked a browser cookie rather than the database, so someone
  // who had opened the coach screen without finishing was told they were a coach ever after. Erik
  // gets as far as naming himself on the setup walk and leaves; no book exists, so no door appears.
  const erik = await newPage();
  await erik.goto(BASE + "/coach");
  await erik.getByPlaceholder("e.g. Alex").fill("Erik");
  await erik.locator("form button[type=submit]").click();
  await erik.getByText("Your assistant").first().waitFor({ timeout: 20000 });
  await erik.goto(BASE + "/");
  check("a player who opened the coach screen but made no book is still only a player", (await erik.getByTestId("assistant-link").count()) === 0 && (await erik.getByRole("link", { name: "My matches" }).count()) === 1);
  // The coach opens her own student link: the page as students see it, with the way to her book, and no form to join herself.
  await olga.goto(`${BASE}/c/${handle}?i=${inviteCode}`);
  check("the coach's own student link shows the owner's note instead of the join form", (await olga.getByTestId("owner-note").count()) === 1 && (await olga.getByTestId("invited-join").count()) === 0 && (await olga.getByTestId("ask-to-join").count()) === 0 && (await olga.getByRole("link", { name: "Open my assistant" }).getAttribute("href")) === "/coach");
  // A ticket minted after the bind (the setup walk reopened) is live; opened from a second Telegram account it is refused and the assistant stays with Olga.
  await olga.goto(BASE + "/coach?setup=1");
  // A reopened walk resumes at the price, because the book already exists.
  await olga.getByTestId("setup-price").waitFor({ timeout: 20000 });
  await olga.getByRole("button", { name: "Later" }).first().click();
  await olga.getByTestId("setup-notify").waitFor({ timeout: 20000 });
  const freshHref = await olga.getByTestId("open-bot").getAttribute("href");
  const freshTicket = decodeURIComponent(freshHref?.match(/start=coach_([^&]+)/)?.[1] ?? "");
  // First with its last character changed: dead. Then intact: refused, because the assistant is bound to Olga's account already.
  const tampered = freshTicket.slice(0, -1) + (freshTicket.endsWith("0") ? "1" : "0");
  const dead = await hook({ update_id: 900004, message: { message_id: 900004, date: 0, chat: { id: 616162, type: "private" }, from: stranger, text: `/start coach_${tampered}` } });
  check("a live ticket with one character changed is refused as expired", Boolean(freshTicket) && dead.outcome === "coach_link_expired", JSON.stringify(dead));
  const other = await hook({ update_id: 900005, message: { message_id: 900005, date: 0, chat: { id: 616162, type: "private" }, from: stranger, text: `/start coach_${freshTicket}` } });
  check("the intact live ticket from a second Telegram account is refused: the assistant stays with the first", other.outcome === "coach_link_other", JSON.stringify(other));
  const still = await hook({ update_id: 900006, message: { message_id: 900006, date: 0, chat: { id: 616161, type: "private" }, from: { id: 616161, is_bot: false, first_name: "Olga", username: "olga_coach_e2e" }, text: "tomorrow" } });
  check("and the first account still runs the book", still.outcome === "coach:agenda", JSON.stringify(still));

  // Settings: PromptPay and a cutoff, saved once.
  await olga.goto(BASE + "/coach/settings");
  await olga.getByPlaceholder("08x xxx xxxx").fill("0899999999");
  // The walk asked one price; settings used to hide the rest. A pair price, saved here, is what makes
  // the student's "how many are coming" picker appear.
  await olga.getByTestId("settings-priceTwo").fill("500");
  await olga.getByRole("button", { name: "Save" }).click();
  await olga.getByText("Saved.").waitFor({ timeout: 20000 });
  check("settings save with a PromptPay number", true);
  check("settings carry every price the walk asked", (await olga.getByTestId("settings-price-single").inputValue()) === "800" && (await olga.getByTestId("settings-priceTwo").inputValue()) === "500");
  check("the notice chosen in the walk is what settings show", (await olga.getByLabel("Shortest notice for a booking (hours)").inputValue()) === "12");
  await shot(olga, "67-coach-settings-prices");
  check("settings carry the second length, the extra outside the hours and the package", (await olga.getByTestId("settings-second-minutes").inputValue()) === "90" && (await olga.getByTestId("settings-price-second-single").inputValue()) === "1200" && (await olga.getByTestId("settings-fee").inputValue()) === "300" && (await olga.getByTestId("offer-price-0").inputValue()) === "7000");
  const calendarCard = olga.getByTestId("coach-calendar");
  // The Google steps sit behind a fold now: the lesson already reaches the coach's calendar by email,
  // and sharing a calendar is only for reading busy time, which most coaches never need.
  check("the calendar section leads with what is already true, and folds the Google steps", (await calendarCard.getByText(/already reaches your calendar/).count()) === 1 && (await calendarCard.getByTestId("calendar-fold").getAttribute("open")) === null);
  await calendarCard.locator("summary").click();
  check("settings carry the calendar attachment with its two steps", (await calendarCard.count()) === 1 && (await calendarCard.getByText(/Share your Google Calendar/).count()) === 1 && (await calendarCard.locator("#gcal-id").count()) === 1);
  await calendarCard.locator("#gcal-id").fill("not an address");
  await calendarCard.getByRole("button", { name: "Attach and check" }).click();
  await calendarCard.getByText("That does not look like a calendar address.").waitFor({ timeout: 20000 });
  check("a bad calendar address is refused in place", true);

  // Ivan finds Olga's page, asks to join.
  const ivan = await newPage();
  await ivan.goto(`${BASE}/c/${handle}`);
  check("the public page names the coach and the club", (await ivan.getByRole("heading", { name: "Olga" }).count()) === 1 && (await ivan.getByText(/at Warehaus/).count()) === 1);
  check("the header names both lengths when the coach sells two", (await ivan.getByText(/60- or 90-minute lessons/).count()) === 1);
  check("the public page carries structured data and language alternates", (await ivan.locator('script[type="application/ld+json"]').count()) === 1 && (await ivan.locator('link[rel="alternate"][hreflang="ru"]').count()) === 1);
  await ivan.getByPlaceholder("e.g. Alex").fill("Ivan");
  await ivan.getByRole("button", { name: "Ask to become a student" }).click();
  await ivan.getByText(/Asked\. Olga will confirm/).waitFor({ timeout: 20000 });
  check("a newcomer asks to join with just a name", true);

  // Dasha opens the link Olga forwarded: her name, and she is on the list without anyone approving.
  const dasha = await newPage();
  await dasha.goto(`${BASE}/c/${handle}?i=${inviteCode}`);
  check("the forwarded link greets the student as added, not as an applicant", (await dasha.getByTestId("invited-join").count()) === 1 && (await dasha.getByText("Olga added you. Your name, and you can book.").count()) === 1);
  await dasha.getByPlaceholder("e.g. Alex").fill("Dasha");
  await dasha.getByRole("button", { name: "I'm in" }).click();
  await dasha.getByText("Pick a day").waitFor({ timeout: 20000 });
  check("a student from the coach's link books at once, no request, no yes", (await dasha.getByTestId("ask-to-join").count()) === 0);
  const wrong = await newPage();
  await wrong.goto(`${BASE}/c/${handle}?i=notthecode`);
  check("a wrong code is just the public page", (await wrong.getByTestId("ask-to-join").count()) === 1);

  // Mila opens the link and takes the package from the page. It starts unpaid, with what to pay and how.
  const mila = await newPage();
  await mila.goto(`${BASE}/c/${handle}?i=${inviteCode}`);
  await mila.getByPlaceholder("e.g. Alex").fill("Mila");
  await mila.getByRole("button", { name: "I'm in" }).click();
  await mila.getByText("Pick a day").waitFor({ timeout: 20000 });
  const priceCard = mila.getByTestId("price-card");
  check("the page shows the prices the way the card at the desk has them: both lengths, the extra, the package", (await priceCard.getByText(/90 min/).count()) >= 1 && (await priceCard.getByText(/1200 THB/).count()) === 1 && (await priceCard.getByText(/\+300 THB per lesson/).count()) === 1 && (await mila.getByTestId("offers-list").getByText(/10 lessons of 60 min/).count()) === 1);
  await shot(mila, "66-student-prices");
  check("a student picks the lesson length when the coach sells two, and sees what each costs", (await mila.getByTestId("student-length").locator('button[data-minutes="90"]').count()) === 1 && (await mila.getByTestId("student-length").getByText(/1200 THB/).count()) === 1);
  await mila.getByTestId("take-offer").click();
  await mila.getByText(/Your package has started/).waitFor({ timeout: 20000 });
  await mila.getByTestId("owed").waitFor({ timeout: 20000 });
  check("taking a package starts it unpaid, with the figure and the ways to pay on the same screen", (await mila.getByTestId("owed").getByText(/7000 THB/).count()) >= 1 && (await mila.getByTestId("owed-package").count()) === 1 && (await mila.getByTestId("take-offer").count()) === 0 && (await mila.getByText(/10 of 10 left/).count()) >= 1);

  // Olga accepts and starts a package of ten.
  await olga.goto(BASE + "/coach/students");
  await olga.getByText("Waiting for your yes").waitFor({ timeout: 20000 });
  await olga.getByRole("button", { name: "Accept" }).click();
  // Two students on the list now (Dasha came through the link): everything below is Ivan's row.
  const ivanRow = olga.locator("li", { hasText: "Ivan" }).first();
  await ivanRow.getByRole("button", { name: /New package/ }).waitFor({ timeout: 20000 });
  await ivanRow.getByRole("button", { name: /New package/ }).click();
  await ivanRow.locator('input[type="number"]').nth(2).fill("6000");
  await ivanRow.getByRole("button", { name: "Create package" }).click();
  await ivanRow.getByText(/10 of 10 left · 90 days/).waitFor({ timeout: 20000 });
  check("a package shows lessons left and days left, not paid yet", (await ivanRow.getByText(/Not paid yet/).count()) === 1);
  await ivanRow.getByRole("button", { name: "Show payment QR" }).click();
  await ivanRow.getByText(/Scan to pay Olga · 6000 THB/).waitFor({ timeout: 10000 });
  check("the PromptPay QR renders with the amount", (await ivanRow.locator("svg").count()) > 0);
  await ivanRow.getByRole("button", { name: "Mark paid" }).click();
  await ivanRow.getByText(/· Paid/).waitFor({ timeout: 20000 });
  await shot(olga, "61-coach-students");

  // Olga brings her sheet: paste, look, confirm. Pavel arrives with six of ten left.
  await olga.getByRole("button", { name: "Import" }).click();
  await olga.getByTestId("import-text").fill("Name\tLessons\tUsed\tExpires\tPaid\nPavel\t10\t4\t2027-01-31\tyes\nnonsense line\n");
  await olga.getByRole("button", { name: "Read it" }).click();
  await olga.getByTestId("import-preview").waitFor({ timeout: 20000 });
  check("the sheet preview shows the row and the skipped line before anything is written", (await olga.getByText(/1 row read, 1 line skipped/).count()) === 1 && (await olga.getByTestId("import-preview").getByText("6/10").count()) === 1);
  await olga.getByTestId("import-confirm").click();
  await olga.getByText(/1 package added: 1 new student/).waitFor({ timeout: 20000 });
  await olga.getByText("Pavel").first().waitFor({ timeout: 20000 });
  check("the imported student appears with lessons left and the expiry", (await olga.getByText(/6 of 10 left/).count()) === 1);

  // Olga sells pairs now, so a student is asked how many are coming. Dasha, who holds no package,
  // sees what each pays; Ivan, whose package pays, sees the count and no figure.
  await dasha.reload();
  await dasha.getByTestId("student-heads").waitFor({ timeout: 20000 });
  await dasha.getByTestId("student-heads").locator('button[data-heads="2"]').click();
  check("a student is asked how many are coming once the coach has a group price, and sees what each pays", (await dasha.getByTestId("each-pays").innerText()).includes("500"));
  await ivan.reload();
  await ivan.getByTestId("student-heads").waitFor({ timeout: 20000 });
  check("a student whose package pays is asked how many, and shown no price", (await ivan.getByTestId("each-pays").count()) === 0);
  check("the header says the price is 'from' when there is more than one", (await ivan.getByText(/from 500 THB/).count()) === 1);
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
  check("a cancellation before the cutoff, or covered by a free late cancellation, refunds the lesson", /back on your package|no lesson was taken/.test(cancelNote ?? ""), cancelNote?.trim());

  // Olga books Ivan from her book in two taps.
  await olga.goto(BASE + "/coach");
  await olga.getByRole("button", { name: "Book a lesson" }).click();
  await olga.locator("#book-student").waitFor({ timeout: 10000 });
  check("the book form offers Ivan", (await olga.locator("#book-student option", { hasText: "Ivan" }).count()) === 1);
  await olga.locator("#book-student").selectOption({ label: "Ivan" });
  const when = await pickFirstFreeTime(olga, olga.locator("form"));
  await olga.locator("form").getByRole("button", { name: "Book", exact: true }).click();
  await olga.getByText(/^Booked Ivan/).waitFor({ timeout: 20000 });
  check("the coach books a student from the book", when !== "", when);
  await shot(olga, "63-coach-home");

  // Dasha came through the link and holds no package, so a lesson booked for her carries a price — and
  // the coach's row shows it, which is what Erik's test found missing. Booked as a pair: 500 each.
  await olga.goto(BASE + "/coach");
  await olga.getByRole("button", { name: "Book a lesson" }).click();
  await olga.locator("#book-student").waitFor({ timeout: 10000 });
  await olga.locator("#book-student").selectOption({ label: "Dasha" });
  await olga.locator("form").locator('button[data-heads="2"]').click();
  const dashaWhen = await pickFirstFreeTime(olga, olga.locator("form"));
  await olga.locator("form").getByRole("button", { name: "Book", exact: true }).click();
  await olga.getByText(/^Booked Dasha/).waitFor({ timeout: 20000 });
  const dashaRow = olga.locator("li", { hasText: "Dasha" }).first();
  await dashaRow.getByTestId("lesson-money").waitFor({ timeout: 20000 });
  check("a priced lesson shows its price and that it is not paid, on the coach's row, at the pair price", /500 THB · not paid/.test(await dashaRow.getByTestId("lesson-money").innerText()), dashaWhen);
  await shot(olga, "65-coach-home-money");
  await olga.goto(BASE + "/coach/students");
  const dashaStudent = olga.locator("li", { hasText: "Dasha" }).first();
  await dashaStudent.getByTestId("unpaid-lessons").waitFor({ timeout: 20000 });
  check("the students screen lists the unpaid lesson under the figure it adds up to", (await dashaStudent.getByTestId("mark-lesson-paid").count()) === 1 && /Owes 500/.test(await dashaStudent.innerText()));
  const milaStudent = olga.locator('[data-testid="student-row"]', { hasText: "Mila" }).first();
  check("the package a student took from the page is on the coach's students screen, unpaid", /10 of 10 left · 70 days · Not paid yet/.test(await milaStudent.innerText()) && /Owes 7000/.test(await milaStudent.innerText()), (await milaStudent.innerText()).slice(0, 120));
  await dashaStudent.getByTestId("mark-lesson-paid").click();
  await olga.getByText(/Owes 500/).waitFor({ state: "detached", timeout: 20000 });
  check("mark paid takes the lesson off what is owed", (await olga.getByText(/Owes 500/).count()) === 0);
  await olga.goto(BASE + "/coach");
  await olga.locator("li", { hasText: "Dasha" }).first().getByTestId("lesson-money").waitFor({ timeout: 20000 });
  check("and the coach's row says paid", /500 THB · paid/.test(await olga.locator("li", { hasText: "Dasha" }).first().getByTestId("lesson-money").innerText()));
  // Erik: a tip, a rounding. The coach changes the figure on the row, and the row shows the new one.
  promptText.value = "550";
  await olga.locator("li", { hasText: "Dasha" }).first().getByTestId("edit-amount").click();
  await olga.locator("li", { hasText: "Dasha" }).first().getByText(/550 THB/).waitFor({ timeout: 20000 });
  promptText.value = "";
  check("the coach can change what a lesson costs, for a tip or a rounding", true);
  check("the student's name on the book is a door to their row on the students screen", ((await olga.locator("li", { hasText: "Dasha" }).first().getByTestId("lesson-student").getAttribute("href")) ?? "").startsWith("/coach/students#s-"));
  // "More" was a toggle over a list. The three other screens are three buttons now, and the link
  // that used to hide there lives on the students screen, where a student is added.
  check("the three other screens are three buttons, not a More toggle", (await olga.getByTestId("coach-nav").locator("a").count()) === 3 && (await olga.getByRole("button", { name: /^▸ More/ }).count()) === 0);
  await olga.getByTestId("coach-nav").getByRole("link", { name: /Students/ }).click();
  await olga.getByTestId("student-link-card").waitFor({ timeout: 20000 });
  check("the students screen carries the link to hand out, with the share buttons", (await olga.getByTestId("student-link-card").getByText(/\/c\//).count()) === 1);
  // Pausing dims the student, not the button that undoes it: a dimmed "Resume bookings" read as disabled.
  const dashaRowS = olga.locator('[data-testid="student-row"]', { hasText: "Dasha" }).first();
  await dashaRowS.getByTestId("pause-toggle").click();
  await dashaRowS.getByRole("button", { name: "Resume bookings" }).waitFor({ timeout: 20000 });
  check("resume bookings reads as a live button, with the student marked paused", ((await dashaRowS.getByTestId("pause-toggle").getAttribute("class")) ?? "").includes("btn-secondary") && (await dashaRowS.getByText("Paused").count()) === 1);
  await dashaRowS.getByTestId("pause-toggle").click();
  await dashaRowS.getByRole("button", { name: "Pause bookings" }).waitFor({ timeout: 20000 });

  // Ivan sees it on My matches with the package line.
  await ivan.goto(BASE + "/me");
  await ivan.getByTestId("lesson-row").first().waitFor({ timeout: 20000 });
  check("My matches lists the lesson among the upcoming things, with the package line", (await ivan.getByText("Lesson with Olga").count()) === 1 && (await ivan.getByText(/9 of 10 left/).count()) === 1 && (await ivan.getByTestId("book-more").count()) === 1);
  check("the lesson row leads to the coach's page", ((await ivan.getByTestId("lesson-row").first().locator("a").getAttribute("href")) ?? "").startsWith("/c/"));

  // The chain: Olga books Pavel on the next day with a free time (a weekend day is off in her hours); Ivan waits for that exact time; Olga cancels; Ivan is offered it and takes it.
  await olga.goto(BASE + "/coach");
  await olga.getByRole("button", { name: "Book a lesson" }).click();
  await olga.locator("#book-student").waitFor({ timeout: 10000 });
  await olga.locator("#book-student").selectOption({ label: "Pavel" });
  const olgaForm = olga.locator("form");
  // The next day with a free time, not "tomorrow": Saturday and Sunday are off in this suite, so a run on a Friday or a Saturday finds none tomorrow.
  const olgaDays = olgaForm.locator('button[data-kind="day"]');
  let dayText = "";
  let dayOffset = 1;
  for (let i = 1, n = await olgaDays.count(); i < Math.min(n, 15) && !dayText; i++) {
    await olgaDays.nth(i).click();
    if ((await olgaForm.locator('button[data-kind="time"]').count()) > 0) {
      dayText = (await olgaDays.nth(i).textContent())?.trim() ?? "";
      dayOffset = i;
    }
  }
  check("the coach's book has a free day after today for the chain", dayText !== "", dayText);
  const lastTime = olgaForm.locator('button[data-kind="time"]').last();
  const timeText = (await lastTime.textContent())?.trim() ?? "";
  await lastTime.click();
  await olgaForm.getByRole("button", { name: "Book", exact: true }).click();
  await olga.getByText(/^Booked Pavel/).waitFor({ timeout: 20000 });

  await ivan.goto(`${BASE}/c/${handle}`);
  await ivan.getByRole("heading", { name: "Book a lesson" }).waitFor({ timeout: 20000 });
  await ivan.locator('button[data-kind="day"]', { hasText: dayText }).first().click();
  const takenChip = ivan.locator('button[data-kind="taken"]', { hasText: timeText }).first();
  check("a taken time shows as waitable on the student's page", (await takenChip.count()) === 1, `${dayText} ${timeText}`);
  await takenChip.click();
  await ivan.getByText(/^On the list for/).waitFor({ timeout: 20000 });
  check("a student joins the waitlist for a taken time with one tap", true);

  await olga.goto(BASE + "/coach");
  await olga.getByText(/1 student waiting/).waitFor({ timeout: 20000 });
  check("the coach's book shows who is waiting", true);
  await olga.locator("li", { hasText: "Pavel" }).getByRole("button", { name: "Cancel" }).first().click();
  await olga.locator("li", { hasText: "Pavel" }).getByText(/cancelled by you/).first().waitFor({ timeout: 20000 });

  await ivan.goto(`${BASE}/c/${handle}`);
  await ivan.getByTestId("offers").waitFor({ timeout: 20000 });
  check("the freed time is offered to the waiting student with the minutes left", (await ivan.getByText(/yours for \d+ more minutes/).count()) === 1);
  await ivan.getByTestId("offer-take").click();
  await ivan.getByText(/^Booked /).waitFor({ timeout: 20000 });
  await ivan.getByText(/8 of 10 left/).waitFor({ timeout: 20000 });
  check("taking the offer books the lesson and draws from the package", true);
  await shot(ivan, "64-student-offer");

  // A special request outside the hours: Ivan asks for tomorrow 23:30; Olga says yes from her book.
  await ivan.getByTestId("other-time").click();
  const tomorrow = new Date(Date.now() + dayOffset * 86400000).toISOString().slice(0, 10);
  await ivan.locator('input[type="datetime-local"]').fill(`${tomorrow}T23:30`);
  await ivan.getByPlaceholder("A word for the coach, optional").fill("after work?");
  await ivan.getByRole("button", { name: "Ask Olga" }).click();
  await ivan.getByText(/^Asked Olga for/).waitFor({ timeout: 20000 });
  check("a time outside the hours becomes a request, not an error", true);
  await olga.goto(BASE + "/coach");
  await olga.getByTestId("coach-requests").waitFor({ timeout: 20000 });
  check("the coach sees the request with the student's note", (await olga.getByText(/after work\?/).count()) === 1);
  await olga.getByTestId("coach-requests").getByRole("button", { name: /Yes/ }).click();
  await olga.getByTestId("coach-requests").waitFor({ state: "detached", timeout: 20000 });
  await ivan.goto(`${BASE}/c/${handle}`);
  await ivan.getByText(/7 of 10 left/).waitFor({ timeout: 20000 });
  check("the coach's yes books the lesson at the requested time", (await ivan.getByText(/23:30/).count()) >= 1);
  // 23:30 is outside Olga's hours, so Benji's extra applies — on top of the package, which paid for the lesson itself.
  await ivan.getByTestId("owed").waitFor({ timeout: 20000 });
  check("a lesson outside the hours carries the extra, on top of the package", (await ivan.getByTestId("owed").getByText(/23:30 · 300 THB/).count()) === 1, await ivan.getByTestId("owed").innerText());

  // A manager: Olga makes one link; Nina opens it, gives a name, and sees Olga's book.
  await olga.goto(BASE + "/coach/settings");
  // The section opens with the question it answers and stays shut until somebody is helping.
  check("the helper section says what it is for before it asks for anything", (await olga.getByTestId("managers-fold").getAttribute("open")) === null && (await olga.getByText("Does someone else take your bookings?").count()) === 1);
  await olga.getByTestId("managers-fold").locator("summary").click();
  await olga.getByRole("button", { name: "Make a link for them" }).click();
  const managerLink = (await olga.getByTestId("manager-link").textContent({ timeout: 20000 }))?.trim() ?? "";
  check("the coach gets one manager link", /\/coach\/join\/[a-z0-9]{8}$/.test(managerLink), managerLink);
  const nina = await newPage();
  await nina.goto(managerLink);
  await nina.getByPlaceholder("e.g. Alex").fill("Nina");
  await nina.getByTestId("manager-join").click();
  await nina.getByRole("heading", { name: "Today" }).waitFor({ timeout: 20000 });
  check("the manager lands in the coach's book after one name", (await nina.getByText("Pavel").count()) >= 1 || (await nina.getByText("Ivan").count()) >= 1);
  // Nina has no channel of her own, and cannot set Olga's. The "pick a channel" screen is the coach's,
  // so it never stands in the way of somebody running a book that is already reachable.
  check("the channel screen does not block a manager", (await nina.getByTestId("notify-done").count()) === 0);
  await olga.reload();
  check("the coach sees the manager listed", (await olga.getByTestId("coach-managers").getByText("Nina").count()) === 1);

  // Findable: Olga lists her page; the city list, the API and the MCP server see her; an assistant asks, Olga accepts, it books and cancels.
  await olga.goto(BASE + "/coach/settings");
  await olga.getByRole("checkbox", { name: /Listed publicly/ }).check();
  // The browser here runs in UTC; a Phuket coach's phone says Asia/Bangkok, which is what puts her on the Phuket list.
  await olga.getByLabel("Time zone").fill("Asia/Bangkok");
  // Who she is for: the thing that made three coaches read alike. "Anyone can book" comes later, so
  // the assistant walk below still meets the closed door it was written for.
  await olga.getByTestId("teaches-min").selectOption("2");
  await olga.getByTestId("teaches-max").selectOption("4.5");
  await olga.getByRole("button", { name: "Save" }).click();
  await olga.getByText("Saved.").waitFor({ timeout: 20000 });
  const listed = await fetch(`${BASE}/api/v1/coaches?city=phuket`).then((r) => r.json());
  check("the API lists the coach in her city without anything private", listed.coaches.some((c) => c.handle === handle && c.rules.cutoffHours === 12) && !JSON.stringify(listed).includes("0899999999"), JSON.stringify(listed).slice(0, 200));
  await ivan.goto(`${BASE}/coaches/phuket`);
  check("the city list shows the listed coach with structured data", (await ivan.getByTestId("coach-list").getByText("Olga").count()) >= 1 && (await ivan.locator('script[type="application/ld+json"]').count()) === 1);
  const apiKey = await fetch(`${BASE}/api/v1/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "e2e coach", agent: "playwright" }) }).then((r) => r.json());
  const authed = { "content-type": "application/json", authorization: `Bearer ${apiKey.key}` };
  const rpc = (body) => fetch(`${BASE}/mcp`, { method: "POST", headers: { ...authed, accept: "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const found = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_coaches", arguments: { city: "phuket" } } });
  check("MCP find_coaches returns her", Boolean(found.result?.structuredContent?.coaches?.some((c) => c.handle === handle)), JSON.stringify(found).slice(0, 200));
  const slotsRpc = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "coach_slots", arguments: { handle, days: 7 } } });
  const slotList = slotsRpc.result?.structuredContent?.slots ?? [];
  check("MCP coach_slots returns free starts", slotList.length > 3, JSON.stringify(slotsRpc).slice(0, 200));
  const askRpc = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "request_coach", arguments: { handle, name: "Agent Ann" } } });
  const annToken = askRpc.result?.structuredContent?.student?.personalToken;
  check("MCP request_coach creates the student and returns a private token", askRpc.result?.structuredContent?.status === "requested" && typeof annToken === "string", JSON.stringify(askRpc).slice(0, 200));
  const tooEarly = await fetch(`${BASE}/api/v1/coaches/${handle}/lessons`, { method: "POST", headers: authed, body: JSON.stringify({ token: annToken, startsAt: slotList[2] }) });
  check("booking before the coach accepts is refused with a hint", tooEarly.status === 403 && (await tooEarly.json()).error?.hint?.includes("request_coach"));
  await olga.goto(BASE + "/coach/students");
  await olga.getByText("Waiting for your yes").waitFor({ timeout: 20000 });
  await olga.locator("li", { hasText: "Agent Ann" }).getByRole("button", { name: "Accept" }).click();
  await olga.locator("li", { hasText: "Agent Ann" }).getByRole("button", { name: /New package/ }).waitFor({ timeout: 20000 });
  const bookedRes = await fetch(`${BASE}/api/v1/coaches/${handle}/lessons`, { method: "POST", headers: authed, body: JSON.stringify({ token: annToken, startsAt: slotList[2] }) });
  const bookedJ = await bookedRes.json();
  check("an accepted student's assistant books a lesson through the API", bookedRes.status === 201 && bookedJ.lesson?.startsAt === slotList[2], JSON.stringify(bookedJ).slice(0, 200));
  const cancelRes = await fetch(`${BASE}/api/v1/coaches/${handle}/lessons/${bookedJ.lesson.id}`, { method: "DELETE", headers: authed, body: JSON.stringify({ token: annToken }) });
  const cancelJ = await cancelRes.json();
  check("and cancels it under the coach's rules", cancelRes.status === 200 && ["none", "refunded", "free_pass", "counted"].includes(cancelJ.outcome), JSON.stringify(cancelJ));
  const sitemap = await fetch(`${BASE}/sitemap.xml`).then((r) => r.text());
  check("the listed coach and the city list are in the sitemap in three languages", sitemap.includes(`/c/${handle}</loc>`) && sitemap.includes(`/ru/c/${handle}</loc>`) && sitemap.includes("/coaches/phuket</loc>"));
  const llms = await fetch(`${BASE}/llms.txt`).then((r) => r.text());
  check("llms.txt tells assistants about coaches and the tools", llms.includes("/api/v1/coaches") && llms.includes("find_coaches"));

  // Olga opens the door: from here anybody may take a free hour without asking her first.
  await olga.goto(BASE + "/coach/settings");
  await olga.getByTestId("open-booking").check();
  await olga.getByRole("button", { name: "Save" }).click();
  await olga.getByText("Saved.").waitFor({ timeout: 20000 });

  // ---- The player's list: somebody who wants a lesson, not an assistant ----
  // `/coaches` used to be the coach's own front door, so a player who typed the word for what they
  // wanted met a page selling software to coaches. It is the directory now.
  await ivan.goto(`${BASE}/coaches`);
  const olgaCard = ivan.getByTestId("coach-list-card").filter({ hasText: "Olga" });
  check("the player's list carries the coach, and the card answers what a player asks", (await olgaCard.count()) === 1 && (await olgaCard.getByText("from 800 THB").count()) === 1 && (await olgaCard.getByTestId("card-levels").getByText(/2\.0.4\.5/).count()) === 1 && (await olgaCard.getByTestId("card-next-free").getByText(/Next free/).count()) === 1);
  check("and the card says she takes anybody, with a button that says so", (await olgaCard.getByText("Book without asking").count()) === 1 && (await olgaCard.getByRole("link", { name: "Book with Olga" }).count()) === 1);
  await shot(ivan, "68-coach-directory");
  // The coach's own door is one line at the foot of the list, not the list itself.
  check("the coach's door sits at the foot of the player's list", (await ivan.getByText(/^Padel coach\? Your students book themselves, and your calendar stays yours\.$/).count()) === 1 && (await ivan.getByRole("link", { name: "Set up your lessons" }).getAttribute("href")) === "/coaches/join?s=coachlist");

  // ---- "Anyone can book": a stranger takes an hour, and the booking is the joining ----
  // The wall was the third click of every walk: three coach cards, then "Ask to become a student",
  // then nothing until a person answered. Nadia has never been here before.
  const nadia = await newPage();
  await nadia.goto(`${BASE}/coaches`);
  await nadia.getByTestId("coach-list-card").filter({ hasText: "Olga" }).getByRole("link", { name: "Book with Olga" }).click();
  await nadia.getByRole("heading", { name: "Book a lesson" }).waitFor({ timeout: 20000 });
  check("a visitor who never asked meets the times, not a wall", (await nadia.getByTestId("ask-to-join").count()) === 0 && (await nadia.getByTestId("open-booking-note").count()) === 1);
  await nadia.getByLabel("Your name").fill("Nadia");
  const nadiaPicked = await pickFirstFreeTime(nadia, nadia.locator("main"));
  check("and free times to pick from", nadiaPicked !== "", nadiaPicked);
  await shot(nadia, "69-open-booking");
  await nadia.getByRole("button", { name: /^Book / }).click();
  await nadia.getByText(/^Booked:/).waitFor({ timeout: 20000 });
  await shot(nadia, "70-open-booking-done");
  await olga.goto(BASE + "/coach/students");
  check("the coach finds the stranger on her list, accepted by the booking itself", (await olga.locator("li", { hasText: "Nadia" }).getByRole("button", { name: /New package/ }).count()) === 1);

  // ---- Coaches arrive on their own: every coach-facing page is a door ----
  await ivan.goto(`${BASE}/coaches/join`);
  check("the front door for coaches renders with one button to the book", (await ivan.getByText("Your students book themselves. Your calendar stays yours.").count()) === 1 && (await ivan.getByTestId("coach-front-cta").getAttribute("href")) === "/coach");
  await ivan.goto(`${BASE}/coaches/join?s=invite`);
  check("a tagged front door passes the door on to the setup link", (await ivan.getByTestId("coach-front-cta").getAttribute("href")) === "/coach?s=invite");
  // The door is for a visitor who is nobody here. Ivan is a student by now, and offering him his own
  // assistant mid-booking was the thing that made the page feel silly, so both halves are checked.
  await wrong.goto(`${BASE}/c/${handle}`);
  check("the coach page carries the quiet door for a visitor who is nobody here", (await wrong.getByTestId("own-book").getAttribute("href")) === "/coaches/join?s=coachpage");
  await ivan.goto(`${BASE}/c/${handle}`);
  check("and never offers it to the coach's own student", (await ivan.getByTestId("own-book").count()) === 0);
  // Her own page names no city: Warehaus is no club row here, and a time zone is not a city (Bangkok shares Asia/Bangkok with Phuket). The city list, which is the city, still says Phuket below.
  check("the coach's own page carries the founding badge without a city", (await ivan.getByText(/Founding coach/).count()) === 1 && (await ivan.getByText("Founding coach · Phuket").count()) === 0);
  await ivan.goto(`${BASE}/coaches/phuket`);
  check("the first coach in the city carries the founding badge", (await ivan.getByText("Founding coach · Phuket").count()) >= 1);
  // The other half of the list: Ivan says he wants a coach here, with his level and when.
  const want = ivan.getByTestId("want-coach");
  check("the city list carries the door for somebody who wants a coach", (await want.count()) === 1);
  await want.getByRole("combobox").selectOption({ label: "2.0" });
  await want.getByLabel("When").fill("evenings");
  await want.getByTestId("want-coach-send").click();
  await ivan.getByTestId("want-coach-done").waitFor({ timeout: 20000 });
  check("the want is noted, and the coaches' door counts it", (await ivan.getByText(/You hear from us when a coach lists in Phuket/).count()) === 1 && (await ivan.getByTestId("coach-waiting").count()) === 0);
  // One person is below the three the door shows from; the want is recorded all the same.
  await ivan.goto(`${BASE}/`);
  check("the landing tile for coaches speaks to the player who wants a lesson", (await ivan.getByTestId("landing-coaches").getByText("Find a coach: prices, free hours, book a lesson").count()) === 1);
  const front = await fetch(`${BASE}/sitemap.xml`).then((r) => r.text());
  check("both doors are in the sitemap in three languages", front.includes("/coaches</loc>") && front.includes("/ru/coaches</loc>") && front.includes("/es/coaches</loc>") && front.includes("/coaches/join</loc>") && front.includes("/es/coaches/join</loc>"));

  // Russian path renders the coach page in Russian (last: it switches Ivan's language).
  await ivan.goto(`${BASE}/ru/c/${handle}`);
  check("the coach page has a Russian URL", (await ivan.getByText("Тренер по паделу").count()) === 1);
} catch (e) {
  await crashed(browser, results, e);
} finally {
  await browser.close();
}

finish(results);
