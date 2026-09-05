// Core journeys on a fresh local server (see e2e/run.mjs): join, waitlist, invites,
// calendar, personal links, cancellation, about/unsubscribe/delete-account.
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
  // ---- Context A: Dana ----
  const a = await newPage();
  await a.goto(BASE + "/");
  await shot(a, "01-landing");
  check("no quick picks for a first-timer", (await a.getByText("Your usual times").count()) === 0);
  check("footer carries only the faint privacy link", (await a.locator("footer a").count()) === 1 && (await a.locator("footer a").getAttribute("href")) === "/about");
  await a.goto(BASE + "/PLAY");
  await shot(a, "02-event-anon");
  check("event page shows 2/4 players", (await a.getByText("2/4 players").count()) > 0);
  check("reserved slot visible", (await a.getByText("Reserved for Jordi").count()) > 0);

  await a.getByRole("button", { name: "Join this match" }).click();
  check("join without identity expands an open spot inline (no popup)", (await a.locator(".fixed.inset-0").count()) === 0 && (await a.locator("main form input").count()) > 0);
  await a.getByPlaceholder("e.g. Alex").fill("Dana");
  await a.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
  await a.getByText("You're in").waitFor({ timeout: 20000 });
  await shot(a, "03-event-joined");
  check("joined → 3/4 players", (await a.getByText("3/4 players").count()) > 0);

  await a.goto(BASE + "/me");
  await shot(a, "04-me");
  check("/me lists PLAY", (await a.content()).includes('href="/PLAY"'));

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
  await a.getByPlaceholder("Court TBD · or type a club").fill("Club Padel Test");
  await a.getByPlaceholder("e.g. 3 or Centre court").fill("3");
  await a.getByRole("button", { name: "Create & get the link" }).click();
  await a.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code = a.url().split("/").slice(-2)[0];
  await shot(a, "06-share");
  check("share page renders QR", (await a.locator("svg path").count()) > 0, code);
  check("share page says match is live + Go to match", (await a.getByText("Your match is live").count()) > 0 && (await a.getByRole("link", { name: /Go to match/ }).count()) > 0);
  check("share text includes court", (await a.locator('a[href^="https://wa.me"]').first().getAttribute("href")).includes(encodeURIComponent("Court 3")));

  await a.goto(`${BASE}/${code}`);
  await shot(a, "07-event-creator");
  check("creator sees organizer tools", (await a.getByText("Organizer tools").count()) > 0);
  check("event page shows venue with court", (await a.getByText("Club Padel Test · Court 3").count()) > 0);
  check("no Play again before a score", (await a.getByRole("button", { name: /Play again/ }).count()) === 0);
  check("no calendar buttons; member without email sees the add-to-calendar email form", (await a.getByRole("link", { name: "Google Calendar" }).count()) === 0 && (await a.getByText("Add to your calendar").count()) > 0);
  await a.getByPlaceholder("you@example.com").first().fill("dana@example.com");
  await a.getByRole("button", { name: "Send invite" }).click();
  await a.getByText(/Calendar invite sent to dana@example.com/).waitFor({ timeout: 20000 });
  await a.getByRole("switch").waitFor({ timeout: 20000 });
  check("after entering an email: invite sent line + email row with notifications switch, form gone", (await a.getByText("Add to your calendar").count()) === 0 && (await a.getByText("dana@example.com").count()) >= 2 && (await a.getByRole("switch").getAttribute("aria-checked")) === "true");
  const ics = await a.evaluate(async (c) => { const r = await fetch(`/${c}/calendar.ics`); return { status: r.status, body: await r.text() }; }, code);
  check("calendar.ics serves a VCALENDAR with court in title", ics.status === 200 && ics.body.includes("BEGIN:VCALENDAR") && ics.body.includes("Court 3"), String(ics.status));
  check("calendar.ics carries one short private link, no personal-link line", /URL:http:\/\/localhost:3001\/p\/[A-Za-z0-9]{12}\//.test(ics.body) && !ics.body.includes("COMPLETE") && !ics.body.includes("personal link") && (ics.body.match(/http:\/\/localhost:3001/g) || []).length === 2);

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
  const inviteUrl = hrefs.map(decodeURIComponent).map((h) => h.match(/(http:\/\/localhost:3001\/[^/\s]{4}\/i\/[^\s]{6})/)?.[1]).find(Boolean);
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

  await a.reload();
  check("creator sees Confirmed chip", (await a.getByText("Confirmed", { exact: true }).count()) > 0);
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
  await shot(a, "11-score-locked");
  // Jordi (player) is now locked out
  await b.reload();
  check("player locked out after organizer confirms", (await b.getByText("Only they can change it").count()) > 0);
  await a.goto(BASE + "/me");
  check("/me shows the entered score", (await a.getByText("6-3").count()) > 0);
  check("/me shows the personal link card", (await a.getByText("Your personal link").count()) > 0);
  const meHtml = await a.content();
  check("/me: upcoming matches come before the personal link card", meHtml.indexOf(">Upcoming<") > 0 && meHtml.indexOf(">Upcoming<") < meHtml.indexOf("Your personal link"));
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

  // ---- Private event link: signs a fresh device in and opens the match ----
  const pd = await newPage();
  await pd.goto(`${personalHref}/PLAY`);
  await pd.getByText("Organized by").first().waitFor({ timeout: 20000 });
  check("private event link lands on the match signed in as Dana", new URL(pd.url()).pathname === "/PLAY" && (await pd.getByText("you", { exact: true }).count()) > 0);
  await pd.context().close();

  // ---- Line-up complete → calendar entry updated (title suffix, players, SEQUENCE) ----
  await a.goto(BASE + "/");
  await a.getByRole("button", { name: "Create & get the link" }).click();
  await a.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code3 = a.url().split("/").slice(-2)[0];
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
  await lastJoiner.getByRole("button", { name: "Leave" }).click();
  await lastJoiner.getByRole("button", { name: "Join this match" }).waitFor({ timeout: 20000 });
  await lastJoiner.context().close();
  const ics4 = await icsWhen(code3, 2);
  check("someone left: suffix removed, SEQUENCE bumped again", !ics4.includes("COMPLETE") && ics4.includes("SEQUENCE:2"), ics4.match(/SUMMARY:.*/)?.[0]);

  // ---- RU toggle ----
  await a.goto(`${BASE}/PLAY`);
  await a.getByRole("button", { name: "ru", exact: true }).click();
  await a.getByText("Организатор").first().waitFor({ timeout: 20000 });
  await shot(a, "12-event-ru");
  check("RU renders", true);
  await a.getByRole("button", { name: "en", exact: true }).click();
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
  await a.goto(`${BASE}/ZZZZ`);
  await shot(a, "16-notfound");
  check("invalid code → real page", (await a.getByText("Link not found").count()) > 0);
  await a.goto(`${BASE}/PAST`);
  await shot(a, "17-past-result");
  check("past match shows organizer-confirmed result", (await a.getByText("Confirmed by organizer").count()) > 0);

  // ---- Desktop landing for good measure ----
  const d = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const dp = await d.newPage();
  await dp.goto(`${BASE}/PLAY`);
  await shot(dp, "18-desktop-event");

  // ---- Hardening round: about, unsubscribe, Spanish, delete account ----
  await a.goto(`${BASE}/about`);
  await shot(a, "19-about");
  check("about page renders the short legal text", (await a.getByText("The fine print, kept short").count()) > 0 && (await a.getByText("Open source").count()) > 0);
  await a.goto(`${BASE}/unsubscribe?e=someone%40example.com&s=forged`);
  check("forged unsubscribe link is rejected", (await a.getByText("That link doesn't check out").count()) > 0);
  await a.goto(`${BASE}/unsubscribe`);
  check("unsubscribe without params is rejected", (await a.getByText("That link doesn't check out").count()) > 0);
  await a.goto(`${BASE}/me`);
  await a.getByRole("button", { name: "es", exact: true }).click();
  await a.getByText("Mis partidos").first().waitFor({ timeout: 20000 });
  check("Spanish locale switch", true);
  await shot(a, "20-me-es");
  check("delete link is faint and at the bottom", (await a.getByRole("button", { name: "Eliminar mi cuenta" }).count()) === 1);
  await a.getByRole("button", { name: "Eliminar mi cuenta" }).click(); // dialog auto-accepted
  await a.waitForURL((u) => new URL(u).pathname === "/", { timeout: 20000 });
  check("delete account signs out and lands on home", true);
  await a.goto(`${BASE}/me`);
  check("no matches left after deletion", (await a.getByText("Dana").count()) === 0);
  await a.getByRole("button", { name: "en", exact: true }).click().catch(() => undefined);
} catch (e) {
  console.error("E2E crashed:", e);
  results.push({ name: "crash", ok: false });
} finally {
  await browser.close();
}
finish(results);
