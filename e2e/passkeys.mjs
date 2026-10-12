// Passkeys (DECIDING rule 39; the owner, 12 October 2026): "One Face ID makes any browser on the phone
// know the player." Each browser context here is one browser on one phone, and Chromium's own virtual
// authenticator (CDP WebAuthn, ctap2 over the internal transport, with a resident key and user
// verification) is the phone's password manager. A passkey that browser A saves is read off its
// authenticator and put into browser B's and C's, as Apple Passwords or Google Password Manager makes
// it there: B and C are other browsers on the same phone, with none of A's cookies.
import { BASE, crashed, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);

/** A browser on a phone whose password manager can keep a passkey (Face ID or a fingerprint, always passed). */
async function phoneBrowser() {
  const ctx = await browser.newContext(iphone);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { ctx, page, cdp, authenticatorId };
}

/**
 * The passkey as the phone holds it now. A synced passkey of Apple or Google counts nothing (0), but
 * Chromium's virtual one counts each use, and the server refuses a count that did not go up (a copy
 * replayed), so each browser takes the copy the last one left.
 */
const heldBy = async (phone) => (await phone.cdp.send("WebAuthn.getCredentials", { authenticatorId: phone.authenticatorId })).credentials[0];

/** A browser with no passkey support set up: the counter-check that the card is not offered for another reason. */
async function plainBrowser() {
  const ctx = await browser.newContext(iphone);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  return { ctx, page };
}

const CRON = { authorization: `Bearer ${process.env.CRON_SECRET || "e2e-cron-secret"}` };
/** One read through the operator's read-only door: the database's own answer, not the page's. */
const ask = async (q) => {
  const r = await fetch(`${BASE}/api/admin/sql?q=${encodeURIComponent(q)}`, { headers: CRON }).then((x) => x.json());
  if (!r.ok) throw new Error(`${r.error} in: ${q}`);
  return r.rows;
};
const recordsNamed = async (name) => Number((await ask(`select count(*)::int as n from players where display_name = '${name}'`))[0]?.n ?? -1);

/** A match made through the public API, as an assistant makes one; its organiser has an email, so nobody here is them. */
async function newMatch(page, venue) {
  const made = await page.request.post(`${BASE}/api/v1/matches`, { data: { startsAt: new Date(Date.now() + 30 * 3600 * 1000).toISOString(), tz: "Asia/Bangkok", venue, organizer: { name: "Kai" } } });
  return (await made.json())?.match?.code;
}

/** Joins the match from a browser that knows nobody, by the open spot's name field. */
async function joinAs(page, code, name) {
  await page.goto(`${BASE}/${code}`);
  await page.getByRole("button", { name: "Join this match" }).click();
  await page.getByTestId("open-spot-name").first().fill(name);
  await page.getByTestId("open-spot-name").first().press("Enter");
  await page.locator("main li", { hasText: name }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
}

const NAME = "Ana Passkey";

try {
  // ---- A: a browser that made the record saves the passkey ----
  const a = await phoneBrowser();
  const code = await newMatch(a.page, "Rawai Padel");
  check("a match exists for the passkey checks", Boolean(code), String(code));
  await a.page.goto(`${BASE}/${code}`);
  // Nothing about passkeys reaches the server on a plain view (rule 12): the help opens only with the join form.
  let actions = 0;
  a.page.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) actions += 1;
  });
  await a.page.waitForTimeout(500);
  check("a view of the match page sends no call for passkeys", actions === 0 && (await a.page.getByTestId("back-in-open").count()) === 0, `posts=${actions}`);
  check(
    "under the line-up, one closed line \"Played before? Sign in\" stands where the fold was",
    (await a.page.getByTestId("event-back-in").count()) === 0 && (await a.page.getByTestId("event-back-in-line").getByRole("button", { name: "Played before? Sign in", exact: true }).count()) === 1,
  );
  await shot(a.page, "passkeys-00-closed-line");
  await a.page.getByRole("button", { name: "Join this match" }).click();
  const help = a.page.getByTestId("back-in-open");
  await help.waitFor({ timeout: 10000 });
  await help.getByTestId("passkey-signin").waitFor({ timeout: 10000 });
  // The owner's routine change: "Played before?" stands open beside the name field, Face ID or a fingerprint first, then the email code.
  const helpText = (await help.innerText()).replace(/\s+/g, " ");
  check(
    "the join form shows \"Played before?\" open under the name field: Face ID or fingerprint first, then the email code",
    (await a.page.getByTestId("open-spot-name").first().isVisible()) &&
      helpText.startsWith("Played before? Get your matches back.") &&
      helpText.indexOf("Sign in with Face ID or fingerprint") < helpText.indexOf("Enter the email you used before") &&
      (await help.getByPlaceholder("you@example.com").isVisible()),
    helpText.slice(0, 160),
  );
  check(
    "beside the open help, neither the closed fold nor the closed line shows under the line-up: one way back in at a time",
    (await a.page.getByTestId("event-back-in").count()) === 0 && (await a.page.getByTestId("event-back-in-line").count()) === 0,
  );
  check("the page never says WebAuthn, credential or authenticator", !/webauthn|credential|authenticator/i.test(await a.page.locator("body").innerText()));
  await shot(a.page, "passkeys-01-join-help");
  check("still no call before a tap", actions === 0, `posts=${actions}`);

  await a.page.getByTestId("open-spot-name").first().fill(NAME);
  await a.page.getByTestId("open-spot-name").first().press("Enter");
  await a.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  const offer = a.page.getByTestId("remember-phone");
  await offer.waitFor({ timeout: 15000 });
  check(
    "after the join, a quiet card offers \"Remember me on this phone\", and says what it does",
    ((await offer.innerText()) ?? "").includes("any browser on this phone signs you in with Face ID or fingerprint") && ((await offer.innerText()) ?? "").includes("never sees your face"),
  );
  // The card stood flush against the card above it (review, 12 October 2026): measure the gap, since a full-page shot puts the fixed bar over that seam.
  const gap = await offer.evaluate((el) => {
    const prev = el.previousElementSibling;
    return prev ? Math.round(el.getBoundingClientRect().top - prev.getBoundingClientRect().bottom) : null;
  });
  check("the card stands apart from the card above it", gap === null || gap >= 8, `gap=${gap}px`);
  await shot(a.page, "passkeys-02-offer");
  await offer.getByRole("button", { name: "Remember this phone", exact: true }).click();
  // The confirmation, or the card's own line saying why not: a wait that names what replaced it.
  await a.page.locator('[data-testid="remember-phone-done"], [data-testid="remember-phone"] [role="status"]').first().waitFor({ timeout: 20000 });
  const refusedSave = await a.page.getByTestId("remember-phone").locator('[role="status"]').textContent().catch(() => null);
  if (refusedSave) console.log(`  the card said: ${refusedSave}`);
  check("the phone saved it: \"This phone remembers you now.\"", ((await a.page.getByTestId("remember-phone-done").textContent()) ?? "").includes("This phone remembers you now."));
  const { credentials } = await a.cdp.send("WebAuthn.getCredentials", { authenticatorId: a.authenticatorId });
  check("the phone's password manager holds one passkey for this site, a resident one", credentials.length === 1 && credentials[0].isResidentCredential === true && credentials[0].rpId === new URL(BASE).hostname, JSON.stringify(credentials.map((c) => ({ rp: c.rpId, resident: c.isResidentCredential }))));
  const saved = await ask(`select count(*)::int as n, min(label) as label from passkeys k join players p on p.id = k.player_id where p.display_name = '${NAME}'`);
  check("the database keeps one passkey for the record, under the browser's words", saved[0]?.n === 1, JSON.stringify(saved));
  await a.page.reload();
  check("the card does not come back once the record has a passkey", (await a.page.getByTestId("remember-phone").count()) === 0);
  await a.page.goto(`${BASE}/me`);
  const phones = a.page.getByTestId("my-phones");
  await phones.waitFor({ timeout: 10000 });
  check("My matches lists the phone under \"Phones that remember you\", with Remove", (await phones.getByTestId("my-phone").count()) === 1 && (await phones.getByRole("button", { name: /^Remove / }).count()) === 1);

  // ---- B: another browser on the same phone, no cookies, signs in with Face ID ----
  const b = await phoneBrowser();
  await b.cdp.send("WebAuthn.addCredential", { authenticatorId: b.authenticatorId, credential: credentials[0] });
  await b.page.goto(`${BASE}/${code}`);
  check("a second browser on the phone does not know the player", (await b.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).count()) === 0);
  // The player is seated already, so no Join: the closed line under the line-up opens the help.
  await b.page.getByRole("button", { name: "Played before? Sign in", exact: true }).click();
  await b.page.getByTestId("back-in-open").getByTestId("passkey-signin").click();
  await b.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  check("Face ID in the second browser, from the closed line with no Join, signs it in as the same player, on the plain match link", (await b.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).count()) === 1);
  const lineup = await b.page.request.get(`${BASE}/api/v1/matches/${code}`).then((r) => r.json());
  check("the line-up holds one of them, and the database one record", (lineup.players ?? []).filter((p) => p.name === NAME).length === 1 && (await recordsNamed(NAME)) === 1, JSON.stringify((lineup.players ?? []).map((p) => p.name)));
  const cookies = await b.ctx.cookies();
  check("the second browser holds a full session, not one by name", cookies.some((c) => c.name === "km_player" && c.value.split(".").length === 2));

  // ---- C: a third browser first joins as a new record, then signs in: the new record folds ----
  const c = await phoneBrowser();
  await c.cdp.send("WebAuthn.addCredential", { authenticatorId: c.authenticatorId, credential: await heldBy(b) });
  const code2 = await newMatch(c.page, "Kata Padel");
  await joinAs(c.page, code2, NAME);
  check("the third browser made a second record of the name, as Join does today", (await recordsNamed(NAME)) === 2);
  const offer2 = c.page.getByTestId("remember-phone");
  await offer2.waitFor({ timeout: 15000 });
  await offer2.getByTestId("passkey-signin").click();
  // The answer folds before it returns; the page then renders again as the passkey's record, which has
  // a passkey, so the card goes. Its going is the sign that the page heard the answer.
  await offer2.waitFor({ state: "detached", timeout: 20000 });
  check("Face ID folds the new record into the passkey's: one record remains", (await recordsNamed(NAME)) === 1);
  const seats = await ask(`select count(*)::int as n from slots s join players p on p.id = s.player_id join events e on e.id = s.event_id where p.display_name = '${NAME}' and e.code in ('${code}', '${code2}')`);
  check("and that record holds both places, the old match's and the new one's", seats[0]?.n === 2, JSON.stringify(seats));
  await c.page.goto(`${BASE}/${code2}`);
  check("the third browser is that player on the new match", (await c.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).count()) === 1);

  // ---- G: a browser that knows nobody, on a match the player is not in yet, signs in from the join form ----
  const g = await phoneBrowser();
  await g.cdp.send("WebAuthn.addCredential", { authenticatorId: g.authenticatorId, credential: await heldBy(c) });
  const code5 = await newMatch(g.page, "Surin Padel");
  await g.page.goto(`${BASE}/${code5}`);
  await g.page.getByRole("button", { name: "Join this match" }).click();
  await g.page.getByTestId("back-in-open").getByTestId("passkey-signin").click();
  const welcome = g.page.getByTestId("open-spot-welcome");
  await welcome.waitFor({ timeout: 20000 });
  check(
    "signed in from the join form, the open spot says \"Welcome back\" and asks to join, with no level to pick and no name field",
    ((await welcome.innerText()) ?? "").includes(`Welcome back, ${NAME}! Join this match?`) && (await g.page.getByText("What's your level?").count()) === 0 && (await g.page.getByTestId("open-spot-name").count()) === 0,
    ((await welcome.innerText()) ?? "").replace(/\s+/g, " "),
  );
  await shot(g.page, "passkeys-03-welcome-join");
  await welcome.getByRole("button", { name: "Join", exact: true }).click();
  await g.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  check("its Join seats the passkey's own record: one record of the name remains", (await recordsNamed(NAME)) === 1);

  // ---- D: a session by name ("That's me") is never offered a passkey ----
  const e = await plainBrowser();
  const code3 = await newMatch(e.page, "Chalong Padel");
  await joinAs(e.page, code3, "Dee Byname");
  const d = await phoneBrowser();
  await d.page.goto(`${BASE}/${code3}`);
  const deeRow = d.page.locator("main li", { hasText: "Dee Byname" });
  await deeRow.getByRole("button", { name: "That's me", exact: true }).click();
  await d.page.getByRole("button", { name: "Sign in as Dee Byname?", exact: true }).click();
  await deeRow.getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  await d.page.waitForTimeout(1500);
  check("a browser signed in by name (\"That's me\") is offered no passkey on the match page", (await d.page.getByTestId("remember-phone").count()) === 0);
  await d.page.goto(`${BASE}/me`);
  await d.page.waitForTimeout(1500);
  check("nor on My matches", (await d.page.getByTestId("my-phones").count()) === 0);
  // The control: the browser that made Dee's record, on a phone that can keep one, is offered it.
  const e2 = await phoneBrowser();
  const code4 = await newMatch(e2.page, "Nai Harn Padel");
  await joinAs(e2.page, code4, "Eve Maker");
  await e2.page.getByTestId("remember-phone").waitFor({ timeout: 15000 });
  check("the control: a browser that made its record is offered it, on the same kind of phone", (await e2.page.getByTestId("remember-phone").count()) === 1);
  await e2.page.getByTestId("remember-phone").getByRole("button", { name: "Not now", exact: true }).click();
  await e2.page.reload();
  await e2.page.waitForTimeout(1500);
  check("\"Not now\" hides the card in this browser", (await e2.page.getByTestId("remember-phone").count()) === 0);

  // ---- Remove: the phone's copy then signs in nobody ----
  await a.page.goto(`${BASE}/me`);
  await a.page.getByTestId("my-phones").getByRole("button", { name: /^Remove / }).click();
  await a.page.getByTestId("my-phone").waitFor({ state: "detached", timeout: 20000 });
  check("Remove takes the passkey away", Number((await ask(`select count(*)::int as n from passkeys k join players p on p.id = k.player_id where p.display_name = '${NAME}'`))[0]?.n) === 0);
  const f = await phoneBrowser();
  await f.cdp.send("WebAuthn.addCredential", { authenticatorId: f.authenticatorId, credential: await heldBy(g) });
  await f.page.goto(`${BASE}/${code}`);
  await f.page.getByRole("button", { name: "Join this match" }).click();
  await f.page.getByTestId("back-in-open").getByTestId("passkey-signin").click();
  await f.page.getByText("Your phone did not sign you in.").waitFor({ timeout: 20000 });
  check("a removed passkey signs in nobody, and the page says so plainly", (await f.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).count()) === 0);
} catch (e) {
  await crashed(browser, results, e);
} finally {
  await browser.close();
}
finish(results);
