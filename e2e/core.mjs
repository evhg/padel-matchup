// Core journeys on a fresh local server (see e2e/run.mjs): join, waitlist, invites,
// calendar, personal links, cancellation, about/unsubscribe/delete-account.
import { BASE, BASE_RE, crashed, finish, iphone, launch, makeCheck, rawKeysOn, resendEvent, shot, switchLang } from "./lib.mjs";

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
// Where two headings sit on the screen: their places among the headings in <main>, -1 when one is missing.
// Not a position in page.content(): the source also carries React's inline payload, whose messages hold the
// same words, and when React recovers from a hydration mismatch (React error 418, a busy CI runner) it renders
// the page again after those scripts. "Upcoming" then sat behind "Your personal link" in the source while the
// screen was right (CI, 11 October 2026).
// A message key shown as text is a message the browser was not given: each page hands its client
// components only the namespaces they read (withClientMessages), and a list that falls short shows
// "me.title" where "My matches" should be. The busiest screens, in each language, as each person.
const noRawKeys = async (page, where) => {
  const keys = await rawKeysOn(page);
  check(`${where} shows no message key as text`, keys.length === 0, keys.slice(0, 5).join(", "));
};
const headingOrder = (page, first, second) =>
  page.locator("main h2").evaluateAll((hs, [x, y]) => {
    const at = (t) => hs.findIndex((h) => h.textContent.includes(t));
    return [at(x), at(y)];
  }, [first, second]);

try {
  // ---- Context A: Dana ----
  const a = await newPage();
  await a.goto(BASE + "/");
  await shot(a, "01-landing");
  await noRawKeys(a, "the landing page");
  check("no quick picks for a first-timer", (await a.getByText("Your usual times").count()) === 0);
  // The first page is the ten-second match and nothing else (the owner, 24 September 2026): the share
  // card belongs after the match, when every player gets it, not between the name and the time.
  check("the first page leads with the form, with no card in the way", (await a.getByTestId("card-preview").count()) === 0);
  // A new browser knows nobody. Somebody who has played before needs a door here, not a tour of the
  // app to find My matches, and it stays shut so it takes nothing from the name field above it.
  const backIn = a.getByText("Played before? Get your matches back.");
  check("the landing page offers a way back in, closed", (await backIn.count()) === 1 && (await a.getByPlaceholder("you@example.com").isVisible().catch(() => false)) === false);
  await backIn.click();
  check("opening it asks for the email, in place", await a.getByPlaceholder("you@example.com").isVisible());
  // And the button reaches its own handler. It did not: this door renders inside the create form, a
  // form inside a form is invalid HTML, and "Send code" did nothing at all on the busiest page while
  // the same component worked on My matches. The answer to an address nobody knows proves it ran.
  check("nothing on the landing page is nested inside another form", (await a.evaluate(() => [...document.querySelectorAll("form")].some((f) => f.parentElement?.closest("form")))) === false);
  await a.getByPlaceholder("you@example.com").fill("nobody-here@example.com");
  await a.getByRole("button", { name: "Send code" }).click();
  await a.getByText(/We don't know that email yet/).waitFor({ timeout: 20000 });
  check("the landing page's way back in answers when it is used", (await a.getByText(/We don't know that email yet/).count()) === 1);
  check("footer carries only the faint privacy link, named \"Privacy and terms\"", (await a.locator("footer a").count()) === 1 && (await a.locator("footer a").getAttribute("href")) === "/privacy" && (await a.locator("footer a").textContent())?.trim() === "Privacy and terms");
  // The doors for the organiser and the club: two links under the form, and the More menu everyone gets.
  // "there should be a feedback option on the main landing page which explains that kicksmash is a
  // self-learning app with community feedback." Eight pages carried this door; the busiest did not.
  check(
    "the landing page carries the feedback door and says the app is built from what players say",
    (await a.getByRole("button", { name: /Tell us what should change/ }).count()) === 1 && (await a.getByText(/built from what players say/).count()) === 1,
  );
  check("the landing page links to the tournaments and to the clubs", (await a.getByTestId("landing-tournaments").getAttribute("href")) === "/t" && (await a.getByTestId("landing-clubs").getAttribute("href")) === "/clubs");
  check("the header's More menu holds the four public doors for a visitor", (await a.getByTestId("nav-more").count()) === 1 && (await a.getByTestId("nav-find").getAttribute("href")) === "/play" && (await a.getByTestId("nav-coaches").getAttribute("href")) === "/coaches" && (await a.getByTestId("nav-clubs").getAttribute("href")) === "/clubs" && (await a.getByTestId("nav-tournaments").getAttribute("href")) === "/t" && (await a.getByTestId("nav-play").count()) === 1);
  // "Bigger text" in the same menu, for a visitor with no account: a tap grows the page in place,
  // the cookie keeps it from the first paint of the next page, and a phone still has no sideways scroll.
  const rootSize = () => a.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  await a.getByTestId("nav-more").click();
  await a.getByRole("switch", { name: "Bigger text" }).click();
  check("Bigger text raises the root to 18px at once", (await rootSize()) === "18px");
  await a.reload();
  check("Bigger text holds after a reload, and nothing runs off a phone", (await rootSize()) === "18px" && (await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)));
  // The pictures of /me at the big size, in the light theme and the dark one; then back to the landing page.
  await a.goto(BASE + "/me");
  // The e-mail field holds its whole placeholder at the big size: it read "you@example.c" beside "Send code".
  const placeholderFits = () => a.locator('main input[type="email"]').first().evaluate((e) => { const v = e.value; e.value = e.placeholder; const ok = e.scrollWidth <= e.clientWidth; e.value = v; return ok; }).catch(() => false);
  check("with Bigger text the e-mail field on My matches shows its whole placeholder", await placeholderFits());
  await shot(a, "04b-me-bigger-text");
  // A fresh render in the dark theme: a picture taken as the scheme flips catches the buttons halfway through their colour transition.
  await a.emulateMedia({ colorScheme: "dark" });
  await a.reload();
  await shot(a, "04c-me-bigger-text-dark");
  await a.emulateMedia({ colorScheme: "light" });
  await a.goto(BASE + "/");
  await a.getByTestId("nav-more").click();
  await a.getByRole("switch", { name: "Bigger text" }).click();
  check("switched off, the text is back to 16px", (await rootSize()) === "16px" && (await a.getByRole("switch", { name: "Bigger text" }).getAttribute("aria-checked")) === "false");
  await a.goto(BASE + "/PLAY");
  const story = await fetch(BASE + "/PLAY/story");
  check("story image renders as a 9:16 PNG", story.status === 200 && (story.headers.get("content-type") || "").startsWith("image/png"), `${story.status} ${story.headers.get("content-type")}`);
  await shot(a, "02-event-anon");
  check("event page shows 2/4 players", (await a.getByText("2/4 players").count()) > 0);
  check("reserved slot visible", (await a.getByText("Reserved for Jordi").count()) > 0);

  await a.getByRole("button", { name: "Join this match" }).click();
  check("join without identity expands an open spot inline (no popup)", (await a.locator(".fixed.inset-0").count()) === 0 && (await a.locator("main form input").count()) > 0);
  await a.getByPlaceholder("e.g. Alex").fill("Dana");
  await a.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
  await a.getByText("You're in").waitFor({ timeout: 20000 });
  await shot(a, "03-event-joined");
  await noRawKeys(a, "the match page, as a player who just joined");
  check("joined → 3/4 players", (await a.getByText("3/4 players").count()) > 0);

  await a.goto(BASE + "/me");
  await shot(a, "04-me");
  await noRawKeys(a, "My matches, as a player");
  // A player's My matches at the big size, with its own switch on, in both themes; then the normal size again.
  await a.getByTestId("text-size-switch").click();
  check("the switch on My matches raises the text to 18px", (await rootSize()) === "18px");
  // The header's word Kicksmash is whole or gone at the big size, never cut to "Kicksm…".
  const brandWhole = await a.locator('header a[aria-label="Kicksmash"] span.truncate').evaluate((e) => getComputedStyle(e).display === "none" || e.scrollWidth <= e.clientWidth).catch(() => false);
  check("with Bigger text the header shows the whole word Kicksmash or the mark alone, never a cut word", brandWhole);
  const emailFields = a.locator('main input[type="email"]');
  const allPlaceholdersFit = await emailFields.evaluateAll((es) => es.every((e) => { const v = e.value; e.value = e.placeholder; const ok = e.scrollWidth <= e.clientWidth; e.value = v; return ok; })).catch(() => false);
  check("with Bigger text every e-mail field on a player's My matches shows its whole placeholder", (await emailFields.count()) > 0 && allPlaceholdersFit);
  await shot(a, "04d-me-player-bigger-text");
  await a.emulateMedia({ colorScheme: "dark" });
  await a.reload();
  await shot(a, "04e-me-player-bigger-text-dark");
  await a.emulateMedia({ colorScheme: "light" });
  await a.reload();
  await a.getByTestId("text-size-switch").click();
  check("switched off on My matches, the text is back to 16px", (await rootSize()) === "16px");
  check("/me lists PLAY", (await a.content()).includes('href="/PLAY"'));
  // The feedback card is the app saying what it is, not a suggestion box at the foot of the page.
  check("the feedback card says the app is built by the players on it", (await a.getByText(/built by the players on it/).count()) === 1);
  // And it claims no number until three have shipped: on a fresh database that is none at all.
  check("no count is claimed before three ideas have shipped", (await a.getByTestId("feedback-shipped").count()) === 0);

  // ---- Create an event that started 1h ago (score entry open) ----
  await a.goto(BASE + "/new");
  check("/new redirects to the landing form", new URL(a.url()).pathname === "/");
  check("quick picks come from history once you have played", (await a.getByText("Your usual times").count()) > 0);
  await shot(a, "05-new");
  const past = new Date(Date.now() - 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(past);
  const g = (t) => parts.find((p) => p.type === t).value;
  await a.locator("input[type=date]").fill(`${g("year")}-${g("month")}-${g("day")}`);
  await a.locator("input[type=time]").fill(`${g("hour")}:${g("minute")}`);
  await a.getByPlaceholder("Court TBD · or pick a club").fill("Club Padel Test");
  await a.getByPlaceholder("e.g. 3 or Centre court").fill("3");
  await a.getByRole("button", { name: "Create & get the link" }).click();
  await a.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code = a.url().split("/").slice(-2)[0];
  await shot(a, "06-share");
  await noRawKeys(a, "the share page");
  check("share page renders QR", (await a.locator("svg path").count()) > 0, code);
  check("share page says match is live + Go to match", (await a.getByText("Your match is live").count()) > 0 && (await a.getByRole("link", { name: /Go to match/ }).count()) > 0);
  check("share text includes court", (await a.locator('a[href^="https://wa.me"]').first().getAttribute("href")).includes(encodeURIComponent("Court 3")));
  // Each share button tags the match link it sends, so the step from a shared link to a seat is counted (docs/OPERATING.md).
  check("the Telegram share tags its link ?s=tg", new URL(await a.locator('a[href^="https://t.me/share"]').first().getAttribute("href")).searchParams.get("url").endsWith(`/${code}?s=tg`), code);
  // "Copy link" puts the link on the clipboard and nowhere in the page, so the clipboard is caught here.
  await a.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (v) => void (window.__copied = v) } }));
  await a.getByRole("button", { name: "Copy link" }).first().click();
  await a.waitForFunction(() => typeof window.__copied === "string", null, { timeout: 5000 }).catch(() => undefined);
  check("the copied link is tagged ?s=link", String(await a.evaluate(() => window.__copied)).endsWith(`/${code}?s=link`), code);
  // The phone's own share sheet ("Share…") renders only where navigator.share exists, and headless
  // Chromium on Linux has none, so a stand-in catches what the button hands it. Only on the share page,
  // so no later page of this browser grows a share button.
  await a.addInitScript(() => {
    if (location.pathname.endsWith("/share")) navigator.share = async (d) => void (window.__shared = d);
  });
  await a.reload();
  await a.getByTestId("native-share").click({ timeout: 10000 }).catch(() => undefined);
  await a.waitForFunction(() => typeof window.__shared === "object", null, { timeout: 5000 }).catch(() => undefined);
  check("the phone's share sheet sends the link tagged ?s=share", String(await a.evaluate(() => window.__shared?.url)).endsWith(`/${code}?s=share`), code);
  await a.evaluate(() => void delete navigator.share);
  // A stranger who opens the WhatsApp link is the funnel's second step: one view_src_wa, written after
  // the response (`later`), so it is read back until it lands.
  const viewsWa = async () => {
    const r = await fetch(`${BASE}/api/admin/sql?q=${encodeURIComponent("select coalesce(sum(value), 0)::int as n from metrics_daily where key = 'view_src_wa'")}`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET || "e2e-cron-secret"}` } }).then((x) => x.json());
    return Number(r.rows?.[0]?.n ?? -1);
  };
  const wasViews = await viewsWa();
  const viewer = await newPage();
  await viewer.goto(`${BASE}/${code}?s=wa`);
  let views = wasViews;
  for (let i = 0; i < 20 && views <= wasViews; i++) {
    await viewer.waitForTimeout(500);
    views = await viewsWa();
  }
  check("a stranger's view of a ?s=wa link counts once under view_src_wa", wasViews >= 0 && views === wasViews + 1, `${wasViews} -> ${views}`);
  // A refresh of the open page is no view: router.refresh() is what the live night's AutoRefresh calls
  // every 20 seconds. Next.js removes the RSC header before the page reads it, so the page reads the
  // browser's Sec-Fetch-Dest instead (isFullPageLoad in src/lib/source.ts). A reload by hand is a view.
  // (A refresh's response never reports finished() to Playwright, so the wait is for its answer, then time
  // for the write after it, which a counted refresh would make.)
  for (let i = 0; i < 2; i++) {
    const refreshed = viewer.waitForResponse((r) => r.request().headers()["rsc"] === "1" && new URL(r.url()).pathname === `/${code}`, { timeout: 15000 });
    await viewer.evaluate(() => window.next.router.refresh());
    await refreshed;
  }
  await viewer.waitForTimeout(3000);
  const afterRefresh = await viewsWa();
  check("a refresh of the open match page adds no view", afterRefresh === wasViews + 1, `${wasViews + 1} -> ${afterRefresh}`);
  await viewer.reload();
  let reloaded = afterRefresh;
  for (let i = 0; i < 20 && reloaded <= afterRefresh; i++) {
    await viewer.waitForTimeout(500);
    reloaded = await viewsWa();
  }
  check("a full load of the match page adds one view", reloaded === afterRefresh + 1, `${afterRefresh} -> ${reloaded}`);
  await viewer.context().close();

  await a.goto(`${BASE}/${code}`);
  await shot(a, "07-event-creator");
  await noRawKeys(a, "the match page, as its organiser");
  check("creator sees organizer tools", (await a.getByText("Organizer tools").count()) > 0);
  check("event page shows venue with court", (await a.getByText("Club Padel Test · Court 3").count()) > 0);
  check("no Play again before a score", (await a.getByRole("button", { name: /Play again/ }).count()) === 0);
  // The moment somebody is in, the card asks where they will hear about it. This run has a bot and email and no WhatsApp number.
  const stay = a.getByTestId("stay-updated");
  const tgChoice = (await stay.getByTestId("stay-telegram").getAttribute("href")) ?? "";
  check("a member with no channel is asked where to stay updated: Telegram in one tap with the match in the link, email, no WhatsApp without a number, no calendar buttons", (await a.getByRole("link", { name: "Google Calendar" }).count()) === 0 && (await stay.getByText("Stay updated").count()) === 1 && /^https:\/\/t\.me\/kicksmash_bot\?start=p_[0-9a-f]{32}_[0-9a-z]+_[0-9a-f]{16}_/.test(tgChoice) && tgChoice.endsWith(`_${code}`) && (await stay.getByTestId("stay-whatsapp").count()) === 0, tgChoice);
  await stay.getByTestId("stay-email").click();
  await a.getByPlaceholder("you@example.com").first().fill("dana@example.com");
  await a.getByRole("button", { name: "Send invite" }).click();
  await a.getByText(/Calendar invite sent to dana@example.com/).waitFor({ timeout: 20000 });
  // The organiser's tools carry a second switch (banter), so the email row's is named by what it is not;
  // and the header's ⋯ menu carries "Bigger text", so the search stays inside the page's own content.
  const emailSwitch = a.locator('main [role="switch"]:not([data-testid="banter-switch"])');
  await emailSwitch.waitFor({ timeout: 20000 });
  check("after entering an email: one quiet line says where updates go, the invite line + email row with notifications switch, the question gone", (await a.getByText("Stay updated").count()) === 0 && (await stay.getByText("Updates reach you by email ✓").count()) === 1 && (await a.getByText("dana@example.com").count()) >= 2 && (await emailSwitch.getAttribute("aria-checked")) === "true");
  const ics = await a.evaluate(async (c) => { const r = await fetch(`/${c}/calendar.ics`); return { status: r.status, body: await r.text() }; }, code);
  check("calendar.ics serves a VCALENDAR with court in title", ics.status === 200 && ics.body.includes("BEGIN:VCALENDAR") && ics.body.includes("Court 3"), String(ics.status));
  check("calendar.ics carries one short private link, no personal-link line", new RegExp(`URL:${BASE_RE}/p/[A-Za-z0-9]{12}/`).test(ics.body) && !ics.body.includes("COMPLETE") && !ics.body.includes("personal link") && (ics.body.match(new RegExp(BASE_RE, "g")) || []).length === 2);

  // ---- The invite really went out: the test server writes every email to a file instead of sending ----
  const { existsSync, readFileSync } = await import("node:fs");
  const unfoldIcs = (t) => t.replace(/\r?\n[ \t]/g, "");
  const mails = () => (process.env.EMAIL_SINK_FILE && existsSync(process.env.EMAIL_SINK_FILE) ? readFileSync(process.env.EMAIL_SINK_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const invitesFor = (c) => mails().filter((m) => m.to === "dana@example.com" && m.ics?.method === "REQUEST" && unfoldIcs(m.ics.content).includes(`/${c}`));
  const waitUntil = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 400)); } };
  const firstInvite = await waitUntil(() => invitesFor(code)[0]);
  check("entering an email sent a real invite: METHOD:REQUEST, Dana as attendee, the private link", Boolean(firstInvite) && unfoldIcs(firstInvite.ics.content).includes("METHOD:REQUEST") && unfoldIcs(firstInvite.ics.content).includes("mailto:dana@example.com"), firstInvite ? firstInvite.subject : "no invite in the sink");
  await a.getByRole("button", { name: /Send it again/ }).click();
  await a.getByText(/Sent again/).waitFor({ timeout: 20000 });
  check("'Send it again' sends the same invite once more", Boolean(await waitUntil(() => invitesFor(code).length >= 2)), String(invitesFor(code).length));

  // ---- With an email on file, creating a match puts it in the organizer's calendar at once ----
  await a.goto(BASE + "/new");
  const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const sp = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(soon);
  const sg = (t) => sp.find((p) => p.type === t).value;
  await a.locator("input[type=date]").fill(`${sg("year")}-${sg("month")}-${sg("day")}`);
  await a.locator("input[type=time]").fill("11:30");
  await a.getByPlaceholder("Court TBD · or pick a club").fill("Club Padel Test");
  // Who it is for (the owner's decision of 9 October 2026): behind the level chip, so the form is not
  // one line longer for anybody who skips it. "Men" is inside "Women" and the chip repeats both: exact.
  check("the tag stays folded behind the level chip until asked", (await a.getByRole("button", { name: "Women", exact: true }).count()) === 0);
  await a.getByTestId("level-chip").click();
  await a.getByTestId("tag-category").getByRole("button", { name: "Women", exact: true }).click();
  await a.getByTestId("tag-age").getByRole("button", { name: "45+", exact: true }).click();
  // Chips are set in capitals by CSS, and innerText carries that: read textContent, or match blind to case.
  check("the level chip reads the tag once it is picked", /any level · women · 45\+/i.test(await a.getByTestId("level-chip").innerText()));
  await shot(a, "05b-new-tagged");
  await a.getByRole("button", { name: "Create & get the link" }).click();
  await a.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code2 = a.url().split("/").slice(-2)[0];
  const organizerInvite = await waitUntil(() => invitesFor(code2)[0]);
  check("organizer with an email on file gets the calendar invite the moment the match exists", Boolean(organizerInvite) && unfoldIcs(organizerInvite.ics.content).includes("DTSTART:"), organizerInvite ? organizerInvite.subject : `no invite for ${code2}`);
  await a.goto(`${BASE}/${code2}`);
  const tagText = ((await a.getByTestId("tag-chip").textContent().catch(() => null)) ?? "no chip").trim();
  check("the match page shows who it is for, as one chip", tagText === "Women · 45+", tagText);
  await shot(a, "05c-match-tagged");
  await a.goto(`${BASE}/${code}`);
  check("an untagged match shows no tag chip", (await a.getByTestId("tag-chip").count()) === 0);

  // ---- Reserve a spot for Jordi by tapping an open spot ----
  check("creator sees tappable open spots", (await a.getByText("Tap to reserve for someone").count()) === 3);
  await a.getByRole("button", { name: /Open spot/ }).first().click();
  await a.getByText("Reserve this spot for…").waitFor({ timeout: 10000 });
  check("reserve expands inline, no overlay", (await a.locator(".fixed.inset-0").count()) === 0);
  await a.getByPlaceholder("Name").fill("Jordi");
  await a.getByRole("button", { name: "Done", exact: true }).click();
  await a.getByText("Reserved for Jordi").first().waitFor({ timeout: 20000 });
  check("reserved row shows forward buttons right away", (await a.getByText("Send them their personal link").count()) > 0 && (await a.locator('a[href^="https://wa.me"]').count()) > 0);
  await shot(a, "08-reserved");
  const hrefs = await a.locator('a[href^="https://wa.me"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  const inviteUrl = hrefs.map(decodeURIComponent).map((h) => h.match(new RegExp(`(${BASE_RE}/[^/\\s]{4}/i/[^\\s]{6})`))?.[1]).find(Boolean);
  check("invite url extracted from forward button", !!inviteUrl, inviteUrl);
  // Rolodex suggestions never include people already in the match
  await a.getByRole("button", { name: /Open spot/ }).first().click();
  await a.getByText("Reserve this spot for…").waitFor({ timeout: 10000 });
  check("suggestions exclude Jordi (already reserved) and Dana (organizer)", (await a.locator("main form button.chip-muted").filter({ hasText: /Jordi|Dana/ }).count()) === 0);
  await a.locator("main form").filter({ has: a.getByPlaceholder("Name") }).getByRole("button", { name: "Cancel" }).click();

  // ---- Context B: Jordi confirms ----
  const b = await newPage();
  await b.goto(inviteUrl);
  await shot(b, "09-invite");
  check("invite page addressed to Jordi", (await b.getByText("Reserved for Jordi").count()) > 0);
  await b.getByRole("button", { name: /I'm in/ }).click();
  await b.getByText("You're confirmed").waitFor({ timeout: 20000 });
  await shot(b, "10-invite-confirmed");
  await b.goto(`${BASE}/${code}`);
  check("Jordi (live match) sees Happening right now + YOU chip", (await b.getByText("Happening right now").count()) > 0 && (await b.getByText("you", { exact: true }).count()) > 0);
  check("activity: Jordi reads 'Jordi was added by Dana' and 'You confirmed your spot'", (await b.getByText("Jordi was added by Dana").count()) > 0 && (await b.getByText("You confirmed your spot").count()) > 0);

  // A friend's link in a WhatsApp group opens the phone's default browser, which may never have seen
  // this person. The name field alone makes them a second row with none of their matches on it: in
  // one week 29 players arrived and 3 joined anything. The way back in existed on the landing page and
  // on My matches, and not on the one screen every shared link opens.
  const w = await newPage();
  await w.goto(`${BASE}/${code}`);
  const backInHere = w.getByTestId("event-back-in");
  check(
    "a stranger on a shared match link is offered a way back in, closed",
    (await backInHere.count()) === 1 && (await w.getByPlaceholder("you@example.com").isVisible().catch(() => false)) === false,
  );
  await backInHere.getByText("Played before? Get your matches back.").click();
  check("opening it asks for the email, on the match page", await w.getByPlaceholder("you@example.com").isVisible());

  await w.close();

  // "That's me" (DECIDING rule 34; the owner, 10 October 2026): the browser a WhatsApp tap opens sees
  // Jordi on the line-up and is Jordi in two taps, with no email, no code and no second row. Dana
  // organises this match, so her row carries no such button.
  const j2 = await newPage();
  await j2.goto(`${BASE}/${code}`);
  const thatsMe = j2.getByRole("button", { name: "That's me", exact: true });
  check(
    "a browser that knows nobody sees \"That's me\" on the one row the rule allows: Jordi's, not the organiser's",
    (await thatsMe.count()) === 1 && (await j2.locator("main li", { has: thatsMe }).getByText("Jordi", { exact: true }).count()) === 1,
  );
  // Two taps, not one (the owner, 10 October 2026): the first only arms the row and asks, and a tap
  // anywhere else disarms it, so a thumb on the wrong row signs nobody in. Nothing reaches the server
  // until the second tap.
  let thatsMeSends = 0;
  j2.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) thatsMeSends += 1;
  });
  const jordiRow = j2.locator("main li", { hasText: "Jordi" });
  const sure = j2.getByRole("button", { name: "Sign in as Jordi?", exact: true });
  await thatsMe.click();
  await sure.waitFor({ timeout: 10000 });
  await j2.waitForTimeout(1000);
  check(
    "the first tap on \"That's me\" signs nobody in: the button asks \"Sign in as Jordi?\" and nothing is sent",
    thatsMeSends === 0 && (await jordiRow.getByText("you", { exact: true }).count()) === 0 && (await sure.count()) === 1,
    `sends=${thatsMeSends}`,
  );
  await j2.locator("main h1").first().click();
  await thatsMe.waitFor({ timeout: 10000 });
  check(
    "a tap anywhere else disarms it: the button says \"That's me\" again, and still nothing is sent",
    thatsMeSends === 0 && (await sure.count()) === 0 && (await thatsMe.count()) === 1,
    `sends=${thatsMeSends}`,
  );
  await thatsMe.click();
  await sure.click();
  await jordiRow.getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  const lineup = await j2.request.get(`${BASE}/api/v1/matches/${code}`).then((r) => r.json());
  const jordis = (lineup.players ?? []).filter((p) => p.name === "Jordi").length;
  check(
    "\"That's me\" signs that browser in as Jordi, and the line-up still holds one Jordi, not two",
    jordis === 1 && (await j2.getByRole("button", { name: "That's me", exact: true }).count()) === 0 && (await j2.getByTestId("event-back-in").count()) === 0,
    JSON.stringify((lineup.players ?? []).map((p) => p.name)),
  );
  await shot(j2, "12a-thats-me");
  // A sign-in by name hands over no lasting key (DECIDING rule 34): until Jordi proves something, My
  // matches shows that browser no personal link and no way to mail it, and the manifest gives it the
  // plain start page instead of the personal link.
  await j2.goto(`${BASE}/me`);
  const byNameManifest = await j2.request.get(`${BASE}/manifest.webmanifest`).then((r) => r.json());
  check(
    "after \"That's me\", My matches shows no personal link and the manifest no personal start page",
    (await j2.getByRole("heading", { name: /Your personal link/ }).count()) === 0 &&
      (await j2.getByRole("button", { name: /Email me this link/ }).count()) === 0 &&
      /came in by tapping your name/.test((await j2.getByTestId("identity-help").textContent()) ?? "") &&
      byNameManifest.start_url === "/?source=homescreen",
    byNameManifest.start_url,
  );
  await j2.close();

  // The duplicate is born in the open spot, not in the fold. A stranger on the future match — Dana
  // is its only player — types "Dana", which is what somebody who has played before does on a phone
  // the page has never seen. A fresh context, so the fold starts closed and the last check means
  // something.
  const dup = await newPage();
  await dup.goto(`${BASE}/${code2}`);
  await dup.getByRole("button", { name: "Join this match" }).click();
  const spot = dup.getByTestId("open-spot-name").first();
  await spot.fill("Someone New");
  check("a name nobody in this match has is left alone", (await dup.getByTestId("already-here").count()) === 0);
  await spot.fill("Dana");
  check("a name already in this match is recognised before it becomes a second row", (await dup.getByTestId("already-here").count()) === 1, (await dup.getByTestId("already-here").textContent().catch(() => "(none)")) ?? "(none)");
  check("the way back in is still shut until they say it is them", (await dup.getByPlaceholder("you@example.com").isVisible().catch(() => false)) === false);
  await dup.getByTestId("already-here").getByRole("button").click();
  check("\"That's me\" opens the way back in, on the spot", await dup.getByPlaceholder("you@example.com").isVisible());
  await shot(dup, "12b-already-here");
  await dup.close();

  // ---- The organiser pastes the names from the group (the owner, 10 October 2026: "you have to leave the chat group") ----
  // The players said "in" in WhatsApp and never leave it: the organiser carries the names across once.
  // The future match, where Dana is the only player and three spots are open.
  await a.goto(`${BASE}/${code2}`);
  await a.getByTestId("paste-names").locator("summary").click();
  await a.getByTestId("paste-names-box").fill("1. Ana 2. Bo\n+1 Cy 🎾\nDana\ncan't make it");
  const preview = a.getByTestId("paste-preview");
  // The preview shows once the page is interactive; on a loaded machine that can take a while.
  await preview.waitFor({ timeout: 20000 });
  check(
    "a pasted chat shows its names before anything is held, skips the organiser already in, and drops the chat",
    ((await preview.textContent()) ?? "").trim() === "Reserves a spot for: Ana, Bo, Cy" && (await a.getByText("Already in, skipped: Dana", { exact: true }).count()) === 1,
    (await preview.textContent()) ?? "(none)",
  );
  await a.getByRole("button", { name: "Reserve 3 spots", exact: true }).click();
  await a.getByText("Reserved for Cy", { exact: true }).waitFor({ timeout: 20000 });
  const heldCounts = await Promise.all(["Ana", "Bo", "Cy"].map((n) => a.getByText(`Reserved for ${n}`, { exact: true }).count()));
  check("three names pasted are three reserved spots", heldCounts.every((c) => c === 1), heldCounts.join(","));
  await shot(a, "12c-paste-names");

  // ---- A held name takes its place on the plain link (DECIDING rule 34; the owner, 11 October 2026: "Yes, two taps") ----
  // Cy is a pasted name: a held place with no email and no phone. Cy opens the match link from the
  // group in a browser that has never seen anybody and types "cy". Before this, "Join" made a second
  // Cy on the open seat and left the held place empty. The organiser removes Bo first, so the name
  // field has an open seat to sit in, and that seat must still be open at the end.
  await a.locator("main li", { hasText: "Reserved for Bo" }).getByRole("button", { name: "Remove player" }).click();
  await a.getByText("Reserved for Bo", { exact: true }).waitFor({ state: "detached", timeout: 20000 });
  const cyp = await newPage();
  let heldSends = 0;
  cyp.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) heldSends += 1;
  });
  await cyp.goto(`${BASE}/${code2}`);
  await cyp.getByText("Reserved for Cy", { exact: true }).waitFor({ timeout: 20000 });
  // The owner chose the typed name, not the row: a stranger who has typed nothing is offered no held
  // place, whoever's row it is.
  const heldOnRows = await cyp.getByTestId("take-held").count();
  check("a held row offers nothing until the name is typed", heldOnRows === 0, `take-held buttons=${heldOnRows}`);
  await cyp.getByRole("button", { name: "Join this match" }).click();
  await cyp.getByTestId("open-spot-name").first().fill("cy");
  const alreadyCy = cyp.getByTestId("already-here");
  const takeCy = alreadyCy.getByRole("button", { name: "Take Cy's held place", exact: true });
  const sureCy = alreadyCy.getByRole("button", { name: "Take Cy's held place?", exact: true });
  await takeCy.waitFor({ timeout: 10000 });
  await shot(cyp, "12d0-held-offer");
  check("a typed held name reads \"cy is already in this match.\" and offers \"Take Cy's held place\"", ((await alreadyCy.textContent()) ?? "").startsWith("cy is already in this match.") && (await takeCy.count()) === 1, (await alreadyCy.textContent()) ?? "(none)");
  // The keyboard's Go key while the offer is on screen: before this it sent Join and made a second Cy.
  heldSends = 0;
  await cyp.getByTestId("open-spot-name").first().press("Enter");
  await cyp.waitForTimeout(1000);
  check("the Go key sends no Join while \"Take Cy's held place\" is on screen, and says why", heldSends === 0 && (await cyp.getByText("This name has a held place.", { exact: false }).count()) === 1, `sends=${heldSends}`);
  heldSends = 0;
  await takeCy.click();
  await sureCy.waitFor({ timeout: 10000 });
  await cyp.waitForTimeout(1000);
  check("the first tap takes nothing: it asks \"Take Cy's held place?\" and sends nothing", heldSends === 0 && (await cyp.getByText("Reserved for Cy", { exact: true }).count()) === 1, `sends=${heldSends}`);
  await cyp.locator("main h1").first().click();
  await takeCy.waitFor({ timeout: 10000 });
  check("a tap anywhere else takes the question back, and still nothing is sent", heldSends === 0 && (await sureCy.count()) === 0, `sends=${heldSends}`);
  await takeCy.click();
  await sureCy.click();
  await cyp.locator("main li", { hasText: "Cy" }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  const afterTake = await cyp.request.get(`${BASE}/api/v1/matches/${code2}`).then((r) => r.json());
  const cys = (afterTake.players ?? []).filter((p) => /^cy$/i.test(p.name));
  check(
    "the second tap fills Cy's held place: one Cy, confirmed, no held row left, and the open seat still open",
    cys.length === 1 && cys[0].status === "confirmed" && (await cyp.getByText("Reserved for Cy", { exact: true }).count()) === 0 && afterTake.spotsLeft === 1,
    JSON.stringify({ players: (afterTake.players ?? []).map((p) => `${p.name}:${p.status}`), spotsLeft: afterTake.spotsLeft }),
  );
  const cyNote = await waitUntil(() => mails().find((m) => m.to === "dana@example.com" && /^Cy confirmed/.test(m.subject ?? "")));
  check("the organiser hears \"Cy confirmed\", as from the personal link", Boolean(cyNote), cyNote ? cyNote.subject : "no mail to the organiser");
  await shot(cyp, "12d-held-by-name");
  await cyp.close();

  // ---- The same on a full match (the audit of 11 October 2026: TDsv was full, and Alberto could not take his place) ----
  // The organiser holds one more name, Eve, in the seat Bo left: every place is taken now. A browser that
  // knows nobody opens the link of the "I'm in" email (`?join=1`): the waiting list's name field is open
  // at once. Eve types her name, and the held place is offered there, not a place on the waiting list.
  await a.goto(`${BASE}/${code2}`);
  await a.getByTestId("paste-names").locator("summary").click();
  await a.getByTestId("paste-names-box").fill("Eve");
  await a.getByTestId("paste-preview").waitFor({ timeout: 20000 });
  await a.getByRole("button", { name: "Reserve 1 spot", exact: true }).click();
  await a.getByText("Reserved for Eve", { exact: true }).waitFor({ timeout: 20000 });
  const fullNow = await a.request.get(`${BASE}/api/v1/matches/${code2}`).then((r) => r.json());
  check("with Eve held, every place of the match is taken", fullNow.spotsLeft === 0, JSON.stringify({ spotsLeft: fullNow.spotsLeft }));
  const evp = await newPage();
  let eveSends = 0;
  evp.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) eveSends += 1;
  });
  await evp.goto(`${BASE}/${code2}?join=1`);
  const waitName = evp.getByTestId("waitlist-name");
  await waitName.waitFor({ timeout: 20000 });
  check("the \"I'm in\" link opens the join step by itself: on a full match, the waiting list's name field", await waitName.isVisible());
  await waitName.fill("eve");
  const alreadyEve = evp.getByTestId("already-here");
  const takeEve = alreadyEve.getByRole("button", { name: "Take Eve's held place", exact: true });
  await takeEve.waitFor({ timeout: 10000 });
  await shot(evp, "12e0-held-offer-full");
  eveSends = 0;
  await waitName.press("Enter");
  await evp.waitForTimeout(1000);
  const notWaiting = await evp.request.get(`${BASE}/api/v1/matches/${code2}`).then((r) => r.json());
  check(
    "on a full match a typed held name is offered its place, and the Go key puts nobody on the waiting list",
    eveSends === 0 && (notWaiting.waitlist ?? 0) === 0 && (await takeEve.count()) === 1,
    JSON.stringify({ sends: eveSends, waitlist: notWaiting.waitlist }),
  );
  await takeEve.click();
  await alreadyEve.getByRole("button", { name: "Take Eve's held place?", exact: true }).click();
  await evp.locator("main li", { hasText: "Eve" }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  const afterEve = await evp.request.get(`${BASE}/api/v1/matches/${code2}`).then((r) => r.json());
  const eves = (afterEve.players ?? []).filter((p) => /^eve$/i.test(p.name));
  check(
    "two taps fill Eve's held place on the full match: one Eve, confirmed, and nobody waiting",
    eves.length === 1 && eves[0].status === "confirmed" && (afterEve.waitlist ?? 0) === 0 && (await evp.getByText("Reserved for Eve", { exact: true }).count()) === 0,
    JSON.stringify({ players: (afterEve.players ?? []).map((p) => `${p.name}:${p.status}`), waitlist: afterEve.waitlist }),
  );
  await evp.close();

  // A browser that already knows a record called Ana, with no place in the match: before this, "Join the
  // waitlist" put a second Ana on the waiting list in one tap. Now Join offers Ana's held place.
  const anp = await newPage();
  await anp.goto(BASE + "/");
  await anp.getByPlaceholder("e.g. Alex").fill("Ana");
  await anp.locator("input[type=date]").fill(`${sg("year")}-${sg("month")}-${sg("day")}`);
  await anp.locator("input[type=time]").fill("19:00");
  await anp.getByRole("button", { name: "Create & get the link" }).click();
  await anp.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  let anaSends = 0;
  anp.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) anaSends += 1;
  });
  await anp.goto(`${BASE}/${code2}`);
  await anp.getByText("Reserved for Ana", { exact: true }).waitFor({ timeout: 20000 });
  anaSends = 0;
  await anp.getByRole("button", { name: "Join the waitlist", exact: true }).click();
  const heldForAna = anp.getByTestId("held-for-you");
  await heldForAna.waitFor({ timeout: 10000 });
  await anp.waitForTimeout(500);
  check(
    "a browser that knows Ana taps Join on the full match: it sends nothing and offers \"Take Ana's held place\"",
    anaSends === 0 && ((await heldForAna.textContent()) ?? "").startsWith("A place in this match is held for Ana.") && (await heldForAna.getByRole("button", { name: "Take Ana's held place", exact: true }).count()) === 1,
    `sends=${anaSends} ${(await heldForAna.textContent()) ?? ""}`,
  );
  // Review of 11 October 2026: a different person known as Ana had no way in and no word why. The
  // offer now says how: a last name on My matches, then Join.
  const notAna = heldForAna.getByTestId("held-not-you");
  check(
    "the offer tells a different Ana the way in: a last name on My matches",
    (await notAna.count()) === 1 && (await notAna.getAttribute("href")) === "/me" && ((await notAna.textContent()) ?? "") === "Not Ana? Add your last name on My matches, then join.",
    (await notAna.count()) ? `${await notAna.getAttribute("href")} ${await notAna.textContent()}` : "(no link)",
  );
  await shot(anp, "12f-held-for-known-browser");
  await heldForAna.getByRole("button", { name: "Take Ana's held place", exact: true }).click();
  await heldForAna.getByRole("button", { name: "Take Ana's held place?", exact: true }).click();
  await anp.locator("main li", { hasText: "Ana" }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  const afterAna = await anp.request.get(`${BASE}/api/v1/matches/${code2}`).then((r) => r.json());
  const anas = (afterAna.players ?? []).filter((p) => /^ana$/i.test(p.name));
  check(
    "the second tap seats that browser's Ana in her held place: one Ana, confirmed, nobody waiting",
    anas.length === 1 && anas[0].status === "confirmed" && (afterAna.waitlist ?? 0) === 0,
    JSON.stringify({ players: (afterAna.players ?? []).map((p) => `${p.name}:${p.status}`), waitlist: afterAna.waitlist }),
  );
  await anp.close();
  await a.goto(`${BASE}/${code}`);

  await a.reload();
  check("creator sees Confirmed chip", (await a.getByText("Confirmed", { exact: true }).count()) > 0);
  check("somebody the page already knows is not asked whether they have been here before", (await a.getByTestId("event-back-in").count()) === 0);
  check("activity: organizer reads 'You added Jordi' and 'Jordi confirmed their spot'", (await a.getByText("You added Jordi").count()) > 0 && (await a.getByText("Jordi confirmed their spot").count()) > 0 && (await a.getByText(/was invited/).count()) === 0);

  // ---- Score entry as creator ----
  await a.getByRole("button", { name: "Enter score" }).click();
  await a.getByText("Dana").first().click(); // team A pick
  const inputs = a.locator("input[type=number]");
  await inputs.nth(0).fill("6");
  await inputs.nth(1).fill("3");
  await a.getByRole("button", { name: /Add set/ }).click();
  await inputs.nth(2).fill("7");
  await inputs.nth(3).fill("5");
  await a.getByRole("button", { name: "Save score" }).click();
  await a.getByText("Confirmed by organizer").waitFor({ timeout: 20000 });
  check("Play again appears after the score", (await a.getByRole("button", { name: /Play again/ }).count()) === 1);
  // Dana's next game at the same club exists already (the match three days ahead, made by hand): the panel
  // names it and the control defaults to its day and time, so one tap lands on it, not beside it (the
  // audit of 11 October 2026: EfUa offered a Friday while the group's Saturday game TDsv existed).
  const nextLine = (await a.getByTestId("play-again-next").textContent().catch(() => null)) ?? "";
  const nextDefault = await a.getByTestId("play-again-when").inputValue();
  check(
    "after the score, Play again names the organiser's next game at the club and defaults to its day and time",
    nextLine.startsWith("Next game:") && nextLine.endsWith(`· ${code2}`) && nextDefault === `${sg("year")}-${sg("month")}-${sg("day")}T11:30` && (await a.getByText("At that day and time, a tap opens that game.", { exact: false }).count()) === 1,
    JSON.stringify({ nextLine, nextDefault }),
  );
  await shot(a, "11-score-locked");
  // ---- Four sets, one of them unusual (decision H; the owner's note "we played 4 sets but we couldn't add the result!") ----
  // 6-3 stays the first set, because /me is read for it below. The organiser's "Confirmed" chip stays
  // up while they edit, so a save is over when "Edit score" comes back, not when the chip shows.
  const setInputs = a.locator("#score input[type=number]");
  await a.getByRole("button", { name: "Edit score" }).click();
  await a.getByRole("button", { name: /Add set/ }).click();
  await a.getByRole("button", { name: /Add set/ }).click();
  await setInputs.nth(4).fill("4");
  await setInputs.nth(5).fill("6");
  await setInputs.nth(6).fill("6");
  await setInputs.nth(7).fill("5");
  await a.getByRole("button", { name: "Save score" }).click();
  const scoreCheck = a.getByTestId("score-check");
  await scoreCheck.waitFor({ timeout: 20000 });
  check("an unusual set asks before it saves, naming the set", (await scoreCheck.getByText("Is 6-5 right?").count()) === 1 && (await a.getByRole("button", { name: "Save score" }).count()) === 0);
  await shot(a, "11a-score-question");
  await scoreCheck.getByRole("button", { name: "Fix it" }).click();
  check("\"Fix it\" goes back to the sets with nothing saved", (await a.getByTestId("score-check").count()) === 0 && (await setInputs.count()) === 8);
  await a.getByRole("button", { name: "Save score" }).click();
  // The second Save of the same score must save, not ask again. Counting the question at once proves
  // nothing (it is not on screen yet either way), so wait for whichever comes: the saved view or the question.
  const settled = (p, v) => p.then(() => v, () => "timeout");
  const second = await Promise.race([settled(a.getByRole("button", { name: "Edit score" }).waitFor({ timeout: 20000 }), "saved"), settled(scoreCheck.waitFor({ timeout: 20000 }), "asked")]);
  check("the same score is asked about once, not twice", second === "saved" && (await a.getByTestId("score-check").count()) === 0, second);
  // Asked twice is a failure above; answer it so the checks after this one still run.
  if (second === "asked") await scoreCheck.getByRole("button", { name: "Yes, save" }).click();
  await a.getByRole("button", { name: "Edit score" }).waitFor({ timeout: 20000 });
  const fourSets = await a.request.get(`${BASE}/api/v1/matches/${code}`).then((r) => r.json());
  check("a four-set score saves", JSON.stringify(fourSets.result?.sets) === JSON.stringify([{ a: 6, b: 3 }, { a: 7, b: 5 }, { a: 4, b: 6 }, { a: 6, b: 5 }]), JSON.stringify(fourSets.result));
  // A fifth set with an unusual score, answered with "Yes, save" this time.
  await a.getByRole("button", { name: "Edit score" }).click();
  await a.getByRole("button", { name: /Add set/ }).click();
  check("five sets is the most", (await a.getByRole("button", { name: /Add set/ }).count()) === 0);
  // A 0-0 set is refused with the server's own words before any question: never "Is 0-0 right?", then a refusal.
  await setInputs.nth(8).fill("0");
  await setInputs.nth(9).fill("0");
  await a.getByRole("button", { name: "Save score" }).click();
  const refused = await a.getByText("Please check the details and try again.").waitFor({ timeout: 20000 }).then(() => true, () => false);
  check("a 0-0 set is refused before the question", refused && (await a.getByTestId("score-check").count()) === 0 && (await a.getByRole("button", { name: "Save score" }).count()) === 1);
  // Asked instead is a failure above; go back to the sets so the checks after this one still run.
  if ((await a.getByTestId("score-check").count()) === 1) await a.getByTestId("score-check").getByRole("button", { name: "Fix it" }).click();
  await setInputs.nth(8).fill("3");
  await setInputs.nth(9).fill("1");
  await a.getByRole("button", { name: "Save score" }).click();
  await a.getByTestId("score-check").getByRole("button", { name: "Yes, save" }).click();
  await a.getByRole("button", { name: "Edit score" }).waitFor({ timeout: 20000 });
  const fiveSets = await a.request.get(`${BASE}/api/v1/matches/${code}`).then((r) => r.json());
  check("\"Yes, save\" saves the five sets as they are", fiveSets.result?.sets?.length === 5 && fiveSets.result.sets[4].a === 3 && fiveSets.result.sets[4].b === 1, JSON.stringify(fiveSets.result));
  // Jordi (player) is now locked out
  await b.reload();
  check("player locked out after organizer confirms", (await b.getByText("Only they can change it").count()) > 0);
  await a.goto(BASE + "/me");
  check("/me shows the entered score", (await a.getByText("6-3").count()) > 0);
  check("/me shows the personal link card", (await a.getByText("Your personal link").count()) > 0);
  const meOrder = await headingOrder(a, "Upcoming", "Your personal link");
  check("/me: upcoming matches come before the personal link card", meOrder[0] >= 0 && meOrder[0] < meOrder[1], meOrder.join(" "));
  check("/me: no restore offer when history exists", (await a.getByText("Played before").count()) === 0);
  check("/me: no 'Not now' anywhere", (await a.getByText("Not now").count()) === 0);
  check("/me: personal link card emails the link (no WhatsApp)", (await a.locator('a[href^="https://wa.me"]').count()) === 0 && (await a.getByRole("button", { name: /Email me this link/ }).count()) > 0);
  // Email can be changed but not removed
  await a.goto(`${BASE}/${code}`);
  await a.getByRole("button", { name: "Edit", exact: true }).first().click();
  const emailBox = a.locator('input[type="email"]').first();
  await emailBox.fill("");
  check("clearing the email leaves Save disabled", await a.getByRole("button", { name: "Save", exact: true }).first().isDisabled());
  await emailBox.fill("dana2@example.com");
  await a.getByRole("button", { name: "Save", exact: true }).first().click();
  await a.getByText("dana2@example.com").first().waitFor({ timeout: 20000 });
  check("email changed to dana2@example.com", (await a.getByText("dana2@example.com").count()) > 0);
  await a.goto(`${BASE}/me`);
  check("service worker registered", await a.evaluate(() => navigator.serviceWorker.getRegistration("/").then((r) => Boolean(r))));
  const health = await a.evaluate(async () => (await fetch("/api/health")).json());
  const cronPush = await a.evaluate(async (secret) => (await fetch("/api/cron/push", { headers: secret ? { authorization: `Bearer ${secret}` } : {} })).json(), process.env.CRON_SECRET ?? "");
  check("push enabled + cron push endpoint answers", health.push === "enabled" && cronPush.ok === true && cronPush.push === "enabled", JSON.stringify(cronPush));
  const personalHref = await a.locator('a[href*="/p/"]').first().getAttribute("href");
  check("personal link extracted (12-char token)", /\/p\/[A-Za-z0-9]{12}$/.test(personalHref ?? ""), personalHref);
  const manifest = await a.evaluate(async () => (await fetch("/manifest.webmanifest", { credentials: "include" })).json());
  check("manifest start_url is the personal link", manifest.start_url === new URL(personalHref, "http://x").pathname + "?source=homescreen", manifest.start_url);
  // Fresh device opens the personal link → sees Dana's matches and gets the cookie
  const nd = await newPage();
  await nd.goto(personalHref);
  await nd.getByText("My matches").first().waitFor({ timeout: 20000 });
  await nd.waitForFunction(() => document.cookie.includes("km_has_id"), null, { timeout: 20000 }).catch(() => {});
  check("personal link shows Dana's matches on a new device", (await nd.content()).includes('href="/PLAY"') && (await nd.getByText("Dana").count()) > 0);
  await nd.goto(BASE + "/me");
  check("new device is now signed in as Dana via cookie", (await nd.getByText("Dana").count()) > 0 && (await nd.content()).includes('href="/PLAY"'));
  await nd.context().close();
  await shot(a, "11b-me-outcome");

  // ---- Signed out, /me leads with the way back (email or Telegram) and puts the first-time path second ----
  const so = await newPage();
  await so.goto(BASE + "/me");
  const soHtml = await so.content();
  const soOrder = await headingOrder(so, "Been here before?", "First time here?");
  check("/me signed out: returning players first, newcomers second", soOrder[0] >= 0 && soOrder[0] < soOrder[1], soOrder.join(" "));
  check("/me signed out: no 'enter your name to see your matches'", !soHtml.includes("Enter your name to see your matches"));
  await so.context().close();

  // ---- Private event link: signs a fresh device in and opens the match ----
  const pd = await newPage();
  await pd.goto(`${personalHref}/PLAY`);
  await pd.getByText("Organized by").first().waitFor({ timeout: 20000 });
  check("private event link lands on the match signed in as Dana", new URL(pd.url()).pathname === "/PLAY" && (await pd.getByText("you", { exact: true }).count()) > 0);
  await pd.context().close();

  // ---- Line-up complete → calendar entry updated (title suffix, players, SEQUENCE) ----
  await a.goto(BASE + "/");
  // How long: three taps under the time, 90 already chosen (the owner, 30 September 2026, after Erik
  // could not tell whether his match was 60 or 90 minutes). Dana books an hour.
  const lengths = a.getByTestId("length-choice");
  check("the form offers three lengths, 90 minutes chosen", (await lengths.getByRole("button").count()) === 3 && (await lengths.getByRole("button", { name: "90 min", exact: true }).getAttribute("aria-pressed")) === "true");
  await lengths.getByRole("button", { name: "60 min", exact: true }).click();
  check("a tap chooses 60 minutes", (await lengths.getByRole("button", { name: "60 min", exact: true }).getAttribute("aria-pressed")) === "true" && (await lengths.getByRole("button", { name: "90 min", exact: true }).getAttribute("aria-pressed")) === "false");
  await shot(a, "05b-length");
  await a.getByRole("button", { name: "Create & get the link" }).click();
  await a.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code3 = a.url().split("/").slice(-2)[0];
  await a.goto(`${BASE}/${code3}`);
  const lengthLine = await a.getByTestId("match-length").innerText();
  check("the match page says how long it is, beside the time", /^until \d{2}:\d{2} · 60 min$/.test(lengthLine.trim()), lengthLine);
  await shot(a, "05c-match-length");
  // Minutes from DTSTART to DTEND, both written as UTC stamps.
  const icsMinutes = (body) => {
    const at = (k) => body.match(new RegExp(`${k}:(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})\\d{2}Z`))?.slice(1).map(Number);
    const [s, e] = [at("DTSTART"), at("DTEND")];
    return s && e ? (Date.UTC(e[0], e[1] - 1, e[2], e[3], e[4]) - Date.UTC(s[0], s[1] - 1, s[2], s[3], s[4])) / 60000 : null;
  };
  let lastJoiner = null;
  for (const n of ["Bo", "Cy", "Di"]) {
    const p = await newPage();
    await p.goto(`${BASE}/${code3}`);
    await p.getByRole("button", { name: "Join this match" }).click();
    await p.getByPlaceholder("e.g. Alex").fill(n);
    await p.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
    await p.getByText("You're in").waitFor({ timeout: 20000 });
    if (n === "Di") lastJoiner = p;
    else await p.context().close();
  }
  const unfold = (t) => t.replace(/\r\n[ \t]/g, "");
  // The calendar update runs in the action's after() hook, so poll until the sequence moves.
  const icsWhen = async (c, seq) => {
    let body = "";
    for (let i = 0; i < 40; i++) {
      body = unfold(await a.evaluate(async (cc) => (await fetch(`/${cc}/calendar.ics`, { cache: "no-store" })).text(), c));
      if (body.includes(`SEQUENCE:${seq}`)) break;
      await a.waitForTimeout(250);
    }
    return body;
  };
  const ics3 = await icsWhen(code3, 1);
  check("complete line-up: title gets - COMPLETE, players listed, SEQUENCE bumped", ics3.includes("- COMPLETE") && ics3.includes("Players: ") && ics3.includes("Di") && ics3.includes("SEQUENCE:1"), `${ics3.match(/SUMMARY:.*/)?.[0]} | ${ics3.match(/SEQUENCE:.*/)?.[0]} | ${ics3.match(/Players: [^\\]*/)?.[0]}`);
  check("the calendar entry ends when the match does: 60 minutes after it starts", icsMinutes(ics3) === 60, `${ics3.match(/DTSTART:.*/)?.[0]} | ${ics3.match(/DTEND:.*/)?.[0]}`);
  await lastJoiner.getByRole("button", { name: "Leave" }).click();
  await lastJoiner.getByRole("button", { name: "Join this match" }).waitFor({ timeout: 20000 });
  await lastJoiner.context().close();
  const ics4 = await icsWhen(code3, 2);
  check("someone left: suffix removed, SEQUENCE bumped again", !ics4.includes("COMPLETE") && ics4.includes("SEQUENCE:2"), ics4.match(/SUMMARY:.*/)?.[0]);
  // A new length is a new end in everybody's calendar, so it goes out as a time change does.
  await a.goto(`${BASE}/${code3}`);
  await a.getByRole("button", { name: "Edit match" }).click();
  await a.getByTestId("length-choice").getByRole("button", { name: "120 min", exact: true }).click();
  await a.getByRole("button", { name: "Save changes" }).click();
  await a.getByTestId("match-length").getByText(/· 120 min/).waitFor({ timeout: 20000 });
  const ics5 = await icsWhen(code3, 3);
  check("two hours instead of one: the page says so, the calendar entry ends two hours in, SEQUENCE bumped", icsMinutes(ics5) === 120 && ics5.includes("SEQUENCE:3"), `${ics5.match(/SEQUENCE:.*/)?.[0]} | ${ics5.match(/DTEND:.*/)?.[0]}`);
  // The owner, 9 October 2026: any player in the match may change its details, not just the organiser.
  const ed = await newPage();
  await ed.goto(`${BASE}/${code3}`);
  await ed.getByRole("button", { name: "Join this match" }).click();
  await ed.getByPlaceholder("e.g. Alex").fill("Ed");
  await ed.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
  await ed.getByText("You're in").waitFor({ timeout: 20000 });
  await ed.getByTestId("player-edit").getByRole("button", { name: "Edit match" }).click();
  await ed.getByRole("button", { name: /More options/ }).click();
  await ed.getByPlaceholder("Bring balls, level 3.5, parking tips…").fill("Court 3 tonight, Ed brings balls");
  await ed.getByRole("button", { name: "Save changes" }).click();
  await ed.getByText("Court 3 tonight, Ed brings balls").waitFor({ timeout: 20000 });
  await shot(ed, "11b-player-edited");
  check("a player in the match changed the note, and the page shows it", true);
  await ed.context().close();
  const outsider = await newPage();
  await outsider.goto(`${BASE}/${code3}`);
  await outsider.getByText("Court 3 tonight, Ed brings balls").waitFor({ timeout: 20000 });
  check("a visitor who has not joined gets no edit form", (await outsider.getByTestId("player-edit").count()) === 0 && (await outsider.getByRole("button", { name: "Edit match" }).count()) === 0);
  await outsider.context().close();

  // ---- RU toggle ----
  await a.goto(`${BASE}/PLAY`);
  await switchLang(a, "ru");
  await a.getByText("Организатор").first().waitFor({ timeout: 20000 });
  await shot(a, "12-event-ru");
  await noRawKeys(a, "the match page in Russian");
  check("RU renders", true);
  await switchLang(a, "en");
  await a.getByText("Organized by").first().waitFor({ timeout: 20000 });

  // ---- Waitlist: PLAY is full (Alex, Maria, Jordi-invited, Dana) ----
  const c = await newPage();
  await c.goto(`${BASE}/PLAY`);
  check("full match offers waitlist", (await c.getByRole("button", { name: "Join the waitlist" }).count()) > 0);
  await c.getByRole("button", { name: "Join the waitlist" }).click();
  check("waitlist join without identity expands in flow", (await c.locator(".fixed.inset-0").count()) === 0);
  await c.getByPlaceholder("e.g. Alex").fill("Eli");
  await c.locator("main form").getByRole("button", { name: "Join the waitlist" }).click();
  await c.getByText("#1 on the waitlist").waitFor({ timeout: 20000 });
  await shot(c, "13-waitlisted");

  await a.goto(`${BASE}/PLAY`);
  await a.getByRole("button", { name: "Leave" }).click();
  await a.getByRole("button", { name: "Join the waitlist" }).waitFor({ timeout: 20000 });
  await c.reload();
  check("Eli auto-promoted after Dana left", (await c.getByText("You're in").count()) > 0);
  await shot(c, "14-promoted");

  // ---- Cancel created event ----
  await a.goto(`${BASE}/${code}`);
  await a.getByRole("button", { name: "Cancel match" }).click();
  await a.getByText("This match was cancelled").waitFor({ timeout: 20000 });
  await shot(a, "15-cancelled");
  await b.goto(inviteUrl);
  check("invite page reflects cancellation", (await b.getByText("This match was cancelled").count()) > 0);

  // ---- 404 + past result ----
  // The words are a paint, so they are waited for, as in venues.mjs. Counted at one instant after goto
  // they were missing once on 10 October 2026, while all 22 suites loaded the machine, and present when
  // the suite ran alone on the same build.
  const missing = await a.goto(`${BASE}/ZZZZ`);
  const notFoundShown = await a.getByText("Link not found").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  await shot(a, "16-notfound");
  check("invalid code → real page", notFoundShown, String(missing?.status()));
  await a.goto(`${BASE}/PAST`);
  await shot(a, "17-past-result");
  check("past match shows organizer-confirmed result", (await a.getByText("Confirmed by organizer").count()) > 0);

  // ---- A held place keeps a past player's record (the owner, 11 October 2026: "Yes, keep the record") ----
  // The seeded PAST match: Alex organised it, and Maria, Jordi and Sofia played. Sofia comes back by
  // "That's me" on PAST (she organises nothing to come), makes a match and picks Maria from "Played with
  // you". Maria's link, opened in a browser that never saw her, signs it in as the Maria who played
  // PAST, by name: no name to type, no second Maria, her old match on My matches, and no personal link.
  const sofia = await newPage();
  await sofia.goto(`${BASE}/PAST`);
  // PAST shows its score panel above the line-up, so the row is the one that wears Sofia's button.
  const sofiaThatsMe = sofia.locator("main li").filter({ hasText: "Sofia" }).getByRole("button", { name: "That's me", exact: true });
  await sofiaThatsMe.click();
  await sofia.getByRole("button", { name: "Sign in as Sofia?", exact: true }).click();
  // Signed in, the browser knows somebody: no row wears "That's me" any more.
  await sofia.waitForFunction(() => ![...document.querySelectorAll("main button")].some((b) => b.textContent?.trim() === "That's me"), null, { timeout: 20000 });
  await sofia.goto(BASE + "/new");
  const later4 = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
  const lp4 = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(later4);
  const lg4 = (t) => lp4.find((p) => p.type === t).value;
  await sofia.locator("input[type=date]").fill(`${lg4("year")}-${lg4("month")}-${lg4("day")}`);
  await sofia.locator("input[type=time]").fill("19:00");
  await sofia.getByPlaceholder("Court TBD · or pick a club").fill("Club Padel Test");
  await sofia.getByRole("button", { name: "Create & get the link" }).click();
  await sofia.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code4 = sofia.url().split("/").slice(-2)[0];
  await sofia.goto(`${BASE}/${code4}`);
  await sofia.getByRole("button", { name: /Open spot/ }).first().click();
  await sofia.getByText("Reserve this spot for…").waitFor({ timeout: 10000 });
  const playedChips = sofia.getByTestId("played-with-you");
  await playedChips.waitFor({ timeout: 10000 });
  check(
    "the reserve form offers \"Played with you\": the people Sofia played PAST with, never Sofia herself",
    (await playedChips.getByRole("button", { name: "Maria", exact: true }).count()) === 1 && (await playedChips.getByRole("button", { name: "Sofia", exact: true }).count()) === 0,
    ((await playedChips.textContent()) ?? "").trim(),
  );
  await playedChips.getByRole("button", { name: "Maria", exact: true }).click();
  check("a pick says the place keeps Maria's matches", ((await sofia.getByTestId("picked-past-player").textContent()) ?? "").includes("Keeps Maria's matches"));
  await shot(sofia, "12g-played-with-you");
  await sofia.getByRole("button", { name: "Done", exact: true }).click();
  await sofia.getByText("Reserved for Maria").first().waitFor({ timeout: 20000 });
  check("the held row says it keeps Maria's matches", (await sofia.getByTestId("keeps-record").count()) === 1);
  const mariaHrefs = await sofia.locator('a[href^="https://wa.me"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  const mariaLink = mariaHrefs.map(decodeURIComponent).map((h) => h.match(new RegExp(`(${BASE_RE}/${code4}/i/[^\\s]{6})`))?.[1]).find(Boolean);
  check("Maria's personal link is on her row", Boolean(mariaLink), String(mariaLink));
  const mariaPage = await newPage();
  await mariaPage.goto(mariaLink);
  check(
    "Maria's link in a browser that never saw her asks for no name: it says she joins as Maria, with her matches",
    (await mariaPage.getByTestId("invite-as-record").count()) === 1 && (await mariaPage.getByText("Your name", { exact: true }).count()) === 0,
  );
  await shot(mariaPage, "12h-held-record-link");
  await mariaPage.getByRole("button", { name: /I'm in/ }).click();
  await mariaPage.getByText("You're confirmed").waitFor({ timeout: 20000 });
  const lineup4 = await mariaPage.request.get(`${BASE}/api/v1/matches/${code4}`).then((r) => r.json());
  const marias = (lineup4.players ?? []).filter((p) => p.name === "Maria");
  check("the place is Maria's, confirmed, and the match holds one Maria", marias.length === 1 && marias[0].status === "confirmed", JSON.stringify(lineup4.players ?? []));
  await mariaPage.goto(`${BASE}/me`);
  check(
    "that browser is the Maria who played PAST, signed in by name: PAST on My matches, and no personal link",
    (await mariaPage.content()).includes('href="/PAST"') && (await mariaPage.getByRole("heading", { name: /Your personal link/ }).count()) === 0,
  );
  await mariaPage.close();

  // ---- A typed name a past player carries asks first (the owner, 12 October 2026: "if manually typed and it matches a previously played person it should ask if its this person to avoid creating dupes") ----
  // PAST's own day and club, read from the API, as the question names them: the day in PAST's zone, in the browser's language.
  const pastMatch = await sofia.request.get(`${BASE}/api/v1/matches/PAST`).then((r) => r.json()).then((j) => j.match ?? j);
  const pastDay = new Intl.DateTimeFormat("en", { timeZone: pastMatch.tz, day: "numeric", month: "short" }).format(new Date(pastMatch.startsAt));
  const pastClub = pastMatch.venue?.name ?? "Padel Indoor BCN";
  // The match page: Sofia types "Jordi" in an open spot of her match.
  await sofia.goto(`${BASE}/${code4}`);
  await sofia.getByRole("button", { name: /Open spot/ }).first().click();
  await sofia.getByPlaceholder("Name").fill("Jordi");
  const spotAsk = sofia.getByTestId("past-ask");
  await spotAsk.waitFor({ timeout: 10000 });
  const spotAskText = ((await spotAsk.textContent()) ?? "").trim();
  check("the open spot asks \"Is this Jordi, who played with you on <day> at <club>?\" before it holds the place", spotAskText.startsWith(`Is this Jordi, who played with you on ${pastDay} at ${pastClub}?`), spotAskText);
  await sofia.getByRole("button", { name: "Done", exact: true }).click();
  check("Done waits for the answer, and says so", (await sofia.getByText("Answer the question about Jordi first.").count()) === 1 && (await sofia.getByText("Reserved for Jordi").count()) === 0);
  await shot(sofia, "12i-open-spot-asks");
  await spotAsk.getByRole("button", { name: "Yes, that's Jordi", exact: true }).click();
  await sofia.getByText("Reserved for Jordi").first().waitFor({ timeout: 20000 });
  const heldJordi = sofia.locator("main li", { hasText: "Reserved for Jordi" });
  check("\"Yes, that's Jordi\" holds the place with Jordi's record", (await heldJordi.getByTestId("keeps-record").count()) === 1);
  const count4 = (await sofia.getByTestId("count-line").innerText()).trim();
  check("the count line names the held place", count4 === "1 spot left · 1 place held for Jordi", count4);
  await shot(sofia, "12j-held-count-line");
  // "Paste the names": a pasted Alex asks too, and the button waits for the answer.
  await sofia.getByTestId("paste-names").locator("summary").click();
  await sofia.getByTestId("paste-names-box").fill("Alex");
  const pasteAsk = sofia.getByTestId("paste-names").getByTestId("past-ask");
  await pasteAsk.waitFor({ timeout: 20000 });
  const pasteHold = sofia.getByRole("button", { name: "Reserve 1 spot", exact: true });
  check("a pasted Alex asks \"Is this Alex…?\", and \"Reserve 1 spot\" waits for the answer", ((await pasteAsk.textContent()) ?? "").startsWith(`Is this Alex, who played with you on ${pastDay} at ${pastClub}?`) && (await pasteHold.isDisabled()), ((await pasteAsk.textContent()) ?? "").trim());
  await shot(sofia, "12j2-paste-asks");
  await pasteAsk.getByRole("button", { name: "No, someone new", exact: true }).click();
  await pasteHold.click();
  await sofia.getByText("Reserved for Alex", { exact: true }).waitFor({ timeout: 20000 });
  check("\"No, someone new\" holds the pasted Alex by name", (await sofia.locator("main li", { hasText: "Reserved for Alex" }).getByTestId("keeps-record").count()) === 0);

  // The create form: "Played with you" under the names, and the question under a typed name.
  await sofia.goto(BASE + "/new");
  await sofia.getByRole("button", { name: /More options/ }).click();
  const createChips = sofia.getByTestId("create-played-with-you");
  await createChips.waitFor({ timeout: 15000 });
  const chipCounts = await Promise.all(["Alex", "Maria", "Jordi", "Sofia"].map((x) => createChips.getByRole("button", { name: x, exact: true }).count()));
  check("the create form offers \"Played with you\" under the names: Sofia's partners from PAST, never Sofia", JSON.stringify(chipCounts) === "[1,1,1,0]", ((await createChips.textContent()) ?? "").trim());
  await shot(sofia, "12k0-create-chips");
  await createChips.getByRole("button", { name: "Maria", exact: true }).click();
  check("a chip puts the name on its own line and keeps that player's record", (await sofia.getByTestId("have-already").inputValue()) === "Maria" && ((await sofia.getByTestId("past-answered").first().textContent()) ?? "").includes("Keeps Maria's matches"));
  await sofia.getByTestId("have-already").fill("Maria\nJordi\nAlex");
  const formAsks = sofia.getByTestId("create-names").getByTestId("past-ask");
  await formAsks.first().waitFor({ timeout: 10000 });
  const formAskTexts = (await formAsks.allTextContents()).map((x) => x.trim());
  check(
    "a typed Jordi and a typed Alex each ask \"Is this …, who played with you on <day> at <club>?\"",
    formAskTexts.length === 2 && formAskTexts[0].startsWith(`Is this Jordi, who played with you on ${pastDay} at ${pastClub}?`) && formAskTexts[1].startsWith(`Is this Alex, who played with you on ${pastDay} at ${pastClub}?`),
    JSON.stringify(formAskTexts),
  );
  await shot(sofia, "12k-create-asks");
  const later5 = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  const lp5 = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(later5);
  const lg5 = (t) => lp5.find((p) => p.type === t).value;
  await sofia.locator("input[type=date]").fill(`${lg5("year")}-${lg5("month")}-${lg5("day")}`);
  await sofia.locator("input[type=time]").fill("19:30");
  await sofia.getByPlaceholder("Court TBD · or pick a club").fill("Club Padel Test");
  const beforeAnswer = sofia.url();
  await sofia.getByRole("button", { name: "Create & get the link" }).click();
  await sofia.getByTestId("create-error").waitFor({ timeout: 10000 });
  check("Create waits while a question is open, and names it", (await sofia.getByTestId("create-error").innerText()).trim() === "Answer the question about Jordi first." && sofia.url() === beforeAnswer, await sofia.getByTestId("create-error").innerText());
  await formAsks.first().getByRole("button", { name: "Yes, that's Jordi", exact: true }).click();
  await sofia.getByTestId("create-names").getByRole("button", { name: "No, someone new", exact: true }).click();
  const answered = (await sofia.getByTestId("past-answered").allTextContents()).map((x) => x.trim());
  check("each answer shows under the names, with Change beside it", answered.length === 3 && answered[1].startsWith("✓ Keeps Jordi's matches") && answered[2].startsWith("Alex: someone new"), JSON.stringify(answered));
  await shot(sofia, "12l-create-answered");
  await sofia.getByRole("button", { name: "Create & get the link" }).click();
  await sofia.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code5 = sofia.url().split("/").slice(-2)[0];
  await sofia.goto(`${BASE}/${code5}`);
  const kept5 = await Promise.all(["Maria", "Jordi", "Alex"].map((x) => sofia.locator("main li", { hasText: `Reserved for ${x}` }).getByTestId("keeps-record").count()));
  check("the new match holds Maria and Jordi with their records, and Alex by name", JSON.stringify(kept5) === "[1,1,0]", JSON.stringify(kept5));
  const count5 = (await sofia.getByTestId("count-line").innerText()).trim();
  check("and its count line names the three held places", count5 === "3 places held for Maria, Jordi, Alex", count5);
  await shot(sofia, "12m-created-with-records");
  await sofia.close();

  // ---- Desktop landing for good measure ----
  const d = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const dp = await d.newPage();
  await dp.goto(`${BASE}/PLAY`);
  await shot(dp, "18-desktop-event");

  // ---- Hardening round: about, unsubscribe, Spanish, delete account ----
  await a.goto(`${BASE}/about`);
  await shot(a, "19-about");
  await a.goto(`${BASE}/privacy`);
  await shot(a, "19b-privacy");
  await a.emulateMedia({ colorScheme: "dark" });
  await a.reload();
  await shot(a, "19c-privacy-dark");
  await a.emulateMedia({ colorScheme: "light" });
  await a.goto(`${BASE}/about`);
  check("about page renders the short legal text", (await a.getByText("The fine print, kept short").count()) > 0 && (await a.getByText("Open source").count()) > 0);
  await a.goto(`${BASE}/unsubscribe?e=someone%40example.com&s=forged`);
  check("forged unsubscribe link is rejected", (await a.getByText("That link doesn't check out").count()) > 0);
  await a.goto(`${BASE}/unsubscribe`);
  check("unsubscribe without params is rejected", (await a.getByText("That link doesn't check out").count()) > 0);
  // The feedback door on a match page opens in place: no navigation, no popup.
  await a.goto(BASE + "/PLAY");
  const urlBefore = a.url();
  await a.getByRole("button", { name: /Tell us what should change/ }).click();
  await a.locator("#feedback-text").waitFor({ timeout: 10000 });
  check("feedback opens in place on the match page", a.url() === urlBefore && (await a.locator("#feedback-text").count()) === 1);
  await a.goto(`${BASE}/me`);
  await switchLang(a, "es");
  await a.getByText("Mis partidos").first().waitFor({ timeout: 20000 });
  check("Spanish locale switch", true);
  await noRawKeys(a, "My matches in Spanish");
  await shot(a, "20-me-es");
  // Dana's address bounces (src/lib/domain/emailMarks.ts). Late in the suite on purpose: from here
  // nothing more is mailed to her, and the page where she can fix it says so.
  // Her address by now is the one she changed it to on My matches, earlier in this suite.
  const bounce = await resendEvent(a, { type: "email.bounced", data: { email_id: "e2e-bounce", to: ["dana2@example.com"], bounce: { type: "Permanent", subType: "General" } } });
  check("a signed bounce from Resend marks the address", bounce.status === 200 && bounce.body?.marked === 1, JSON.stringify(bounce));
  await a.reload();
  check("My matches says the address stopped working, where it can be fixed", (await a.getByTestId("email-marked").count()) === 1);
  check("delete link is faint and at the bottom", (await a.getByRole("button", { name: "Eliminar mi cuenta" }).count()) === 1);
  await a.getByRole("button", { name: "Eliminar mi cuenta" }).click(); // dialog auto-accepted
  await a.waitForURL((u) => new URL(u).pathname === "/", { timeout: 20000 });
  check("delete account signs out and lands on home", true);
  await a.goto(`${BASE}/me`);
  check("no matches left after deletion", (await a.getByText("Dana").count()) === 0);
  await a.getByRole("button", { name: "en", exact: true }).click().catch(() => undefined);
} catch (e) {
  await crashed(browser, results, e);
} finally {
  await browser.close();
}
finish(results);
