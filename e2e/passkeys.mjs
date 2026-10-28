// Passkeys (DECIDING rule 39; the owner, 12 October 2026): "One Face ID makes any browser on the phone
// know the player." Each browser context here is one browser on one phone, and Chromium's own virtual
// authenticator (CDP WebAuthn, ctap2 over the internal transport, with a resident key and user
// verification) is the phone's password manager. A passkey that browser A saves is read off its
// authenticator and put into browser B's and C's, as Apple Passwords or Google Password Manager makes
// it there: B and C are other browsers on the same phone, with none of A's cookies.
import { BASE, crashed, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";

const browser = await launch();
/** What a phone shows, 390 px wide, around the element the walk just scrolled to: the full-page shot of a long page is too tall to read. */
const view = (p, name) => (process.env.SHOTS ? p.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : Promise.resolve());
const results = [];
const check = makeCheck(results);

/**
 * A browser on a phone whose password manager can keep a passkey (Face ID or a fingerprint, always passed).
 * Chromium's virtual authenticator answers a waiting conditional request at once, as a player who picks
 * their passkey above the keyboard would, so a page for a browser that knows nobody signs it in by itself
 * (the autofill on the own name field, the owner, 28 October 2026). The walks of the button, the offer and
 * the question take a browser with no autofill (`autofill: false`): one that says no to
 * `isConditionalMediationAvailable()` and to the capability `conditionalGet`, as an older phone does.
 * `init` runs in every page of the browser before the app's own scripts.
 */
async function phoneBrowser({ autofill = true, init = null } = {}) {
  const ctx = await browser.newContext(iphone);
  if (init) await ctx.addInitScript(init);
  if (!autofill)
    await ctx.addInitScript(() => {
      const P = window.PublicKeyCredential;
      if (!P) return;
      P.isConditionalMediationAvailable = async () => false;
      const caps = P.getClientCapabilities?.bind(P);
      if (caps) P.getClientCapabilities = async () => ({ ...(await caps()), conditionalGet: false });
    });
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
/** A counter's total over all days, from `metrics_daily`: a walk compares it before and after. */
const counter = async (key) => Number((await ask(`select coalesce(sum(value), 0)::int as n from metrics_daily where key = '${key}'`))[0]?.n ?? 0);
const recordsNamed = async (name) => Number((await ask(`select count(*)::int as n from players where display_name = '${name}'`))[0]?.n ?? -1);

/** A match made through the public API, as an assistant makes one; its organiser has an email, so nobody here is them. */
async function newMatch(page, venue) {
  return (await newMatchWithManage(page, venue)).code;
}
/** The same, with the organiser's manage link, which opens the organiser's view in a browser that knows nobody. */
async function newMatchWithManage(page, venue) {
  const made = await page.request.post(`${BASE}/api/v1/matches`, { data: { startsAt: new Date(Date.now() + 30 * 3600 * 1000).toISOString(), tz: "Asia/Bangkok", venue, organizer: { name: "Kai" } } });
  const j = await made.json();
  return { code: j?.match?.code, manage: j?.organizer?.manageUrl };
}
/** The autocomplete a field carries once the page's autofill had its moment to put the token on. */
const tokenOf = async (field) => {
  await field.waitFor({ timeout: 10000 });
  await field.page().waitForTimeout(800);
  return field.getAttribute("autocomplete");
};

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
  // Nothing about passkeys reaches the server on a plain view (rule 12): the help opens only with the join form.
  // The listener stands before the first navigation, so a call made while the page loads or hydrates counts too
  // (review, 12 October 2026: attached after `goto`, it could not see one).
  let actions = 0;
  a.page.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) actions += 1;
  });
  await a.page.goto(`${BASE}/${code}`, { waitUntil: "load" });
  await a.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
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
  // A record with a passkey gets no second offer there: only the small link for another phone (DECIDING rule 39).
  await phones.getByTestId("remember-also").waitFor({ timeout: 10000 });
  check(
    "a record with a passkey gets no \"Remember me\" card on My matches, only the small link \"Also remember this phone\"",
    (await a.page.getByTestId("remember-phone").count()) === 0 && (await phones.getByRole("button", { name: "Also remember this phone", exact: true }).count()) === 1,
  );
  // The owner, 28 October 2026: a saved passkey tells the record's own channel, and the inbox keeps it.
  const inbox = ((await a.page.locator("main").textContent()) ?? "").replace(/\s+/g, " ");
  check("the inbox on My matches says a phone now signs the player in, by its label, and where to remove it", /A phone now signs you in: [^.]+\. Not you\? Remove it on My matches\./.test(inbox), inbox.match(/A phone now[^.]*\./)?.[0] ?? "no line");

  // ---- B: another browser on the same phone, no cookies, signs in with Face ID ----
  const b = await phoneBrowser({ autofill: false });
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
  const c = await phoneBrowser({ autofill: false });
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
  const g = await phoneBrowser({ autofill: false });
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

  // ---- H: the owner's decision of 15 October 2026 (D2): a browser that knows nobody types the name of a seated record with a passkey, and taps Join ----
  // Before this, Join made a second record of the name. Now the join answers "Ana Passkey is in this
  // match. Sign in as Ana Passkey?" with the record's own doors, because "That's me" refuses a record
  // with a passkey, and Face ID there signs this browser in as the seated record.
  const h = await phoneBrowser({ autofill: false });
  await h.cdp.send("WebAuthn.addCredential", { authenticatorId: h.authenticatorId, credential: await heldBy(g) });
  await h.page.goto(`${BASE}/${code}`);
  await h.page.getByRole("button", { name: "Join this match" }).click();
  await h.page.getByTestId("open-spot-name").first().fill(NAME.toLowerCase());
  await h.page.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
  const seatedAsk = h.page.getByTestId("seated-ask");
  await seatedAsk.waitFor({ timeout: 20000 });
  check(
    "Join with the typed name of a seated record that has a passkey asks first, with Face ID or fingerprint in the question and no \"That's me\", and makes no record",
    ((await seatedAsk.innerText()) ?? "").includes(`${NAME} is in this match. Sign in as ${NAME}?`) &&
      (await seatedAsk.getByTestId("passkey-signin").count()) === 1 &&
      (await seatedAsk.getByRole("button", { name: "That's me", exact: true }).count()) === 0 &&
      (await recordsNamed(NAME)) === 1,
    ((await seatedAsk.innerText()) ?? "").replace(/\s+/g, " "),
  );
  // The owner's decision of 16 October 2026 (D4): only the record's own doors. Ana has a passkey and no
  // address and no Telegram, so the question shows Face ID alone, and the page's general help steps aside.
  check(
    "the question shows only the record's own door: Face ID, and no email code and no Telegram, here or beside it",
    (await seatedAsk.getByTestId("seated-door-passkey").count()) === 1 &&
      (await seatedAsk.getByTestId("seated-door-email").count()) === 0 &&
      (await seatedAsk.getByTestId("seated-door-telegram").count()) === 0 &&
      (await h.page.getByTestId("back-in-open").count()) === 0 &&
      (await h.page.getByPlaceholder("you@example.com").count()) === 0,
  );
  // Nor the closed "Played before? Sign in" under the line-up: the question is the way back in while it stands.
  check(
    "no \"Played before? Sign in\" line stands beside the question as a second, dead way in",
    await h.page.getByTestId("event-back-in-line").waitFor({ state: "detached", timeout: 5000 }).then(() => true).catch(() => false),
  );
  await shot(h.page, "passkeys-04-seated-ask");
  await seatedAsk.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await view(h.page, "passkeys-04-seated-ask-390");
  await seatedAsk.getByTestId("passkey-signin").click();
  await h.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  check("Face ID from the question signs the browser in as the seated record: one record of the name", (await recordsNamed(NAME)) === 1);

  // ---- K: "Sign in with Face ID or fingerprint" while the autofill's request waits (review, 28 October 2026) ----
  // On every phone that can offer a passkey above the keyboard, the page starts a conditional request when
  // it loads. The button must end that request first (the library's one ceremony at a time) and then ask
  // the phone in the open. A spy on `navigator.credentials.get` keeps each call's mediation and whether
  // its signal aborted. First what Chromium's virtual authenticator does with a waiting request: a passkey
  // added to the phone answers nothing by itself, and the own name field taking focus picks it at once.
  const spyGets = () => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    window.__gets = [];
    navigator.credentials.get = (o) => {
      const rec = { mediation: o?.mediation ?? null, aborted: false };
      window.__gets.push(rec);
      o?.signal?.addEventListener("abort", () => {
        rec.aborted = true;
      });
      return get(o);
    };
  };
  const armed = (p) => p.waitForFunction(() => (window.__gets ?? []).some((g) => g.mediation === "conditional" && !g.aborted), null, { timeout: 15000 });
  const youOn = (p) => p.locator("main li", { hasText: NAME }).getByText("you", { exact: true });
  const k0 = await phoneBrowser({ init: spyGets });
  await k0.page.goto(`${BASE}/${code}`);
  await armed(k0.page);
  const k0Autofill = await counter("signin_passkey_autofill");
  await k0.cdp.send("WebAuthn.addCredential", { authenticatorId: k0.authenticatorId, credential: await heldBy(h) });
  await k0.page.waitForTimeout(1500);
  const k0Before = await youOn(k0.page).count();
  check("Chromium: a passkey added to the phone while the conditional request waits answers nothing by itself", k0Before === 0 && (await counter("signin_passkey_autofill")) === k0Autofill, `you=${k0Before}`);
  // "Join this match" puts the cursor in the open spot's name field.
  await k0.page.getByRole("button", { name: "Join this match" }).click();
  const k0Picked = await youOn(k0.page).waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
  check("Chromium: the own name field taking focus picks the passkey for the waiting request at once", k0Picked, "so the walk below takes the passkey only after the field had its focus");

  const k = await phoneBrowser({ init: spyGets });
  const kErrors = [];
  k.page.on("pageerror", (e) => kErrors.push(e.message));
  await k.page.goto(`${BASE}/${code}`);
  await armed(k.page);
  // The help opens with the cursor in the name field while the phone has no passkey yet; the field then
  // loses the focus, as it does on a phone when the player taps the button.
  await k.page.getByRole("button", { name: "Played before? Sign in", exact: true }).click();
  const kButton = k.page.getByTestId("back-in-open").getByTestId("passkey-signin");
  await kButton.waitFor({ timeout: 10000 });
  await k.page.waitForTimeout(500);
  await k.page.evaluate(() => document.activeElement?.blur());
  const [kAutofill, kPasskey] = [await counter("signin_passkey_autofill"), await counter("signin_passkey")];
  await k.cdp.send("WebAuthn.addCredential", { authenticatorId: k.authenticatorId, credential: await heldBy(k0) });
  await k.page.waitForTimeout(1000);
  check("the conditional request still waits, unanswered, when the player reaches for the button", (await youOn(k.page).count()) === 0 && (await k.page.evaluate(() => window.__gets.some((g) => g.mediation === "conditional" && !g.aborted))));
  await kButton.click();
  await youOn(k.page).waitFor({ timeout: 20000 });
  const gets = await k.page.evaluate(() => window.__gets);
  const firstModal = gets.findIndex((g) => g.mediation === null);
  check(
    "the button ends the waiting conditional request, then asks the phone in the open, and signs in as the seated player",
    firstModal > 0 && gets.slice(0, firstModal).some((g) => g.mediation === "conditional" && g.aborted) && (await recordsNamed(NAME)) === 1 && (await k.ctx.cookies()).some((x) => x.name === "km_player" && x.value.split(".").length === 2),
    JSON.stringify(gets),
  );
  let kSigned = await counter("signin_passkey");
  for (let n = 0; n < 10 && kSigned === kPasskey; n += 1) {
    await k.page.waitForTimeout(300);
    kSigned = await counter("signin_passkey");
  }
  check("it counts as the button's sign-in, not the autofill's", kSigned === kPasskey + 1 && (await counter("signin_passkey_autofill")) === kAutofill, `passkey ${kPasskey} → ${kSigned}`);
  check("and the page threw nothing on the way", kErrors.length === 0, kErrors.join(" | "));

  // ---- J: the passkey above the keyboard sits on the player's own name field only (the owner, 28 October 2026) ----
  // A browser that knows nobody and keeps no passkey: the page's own challenge waits for a pick that never
  // comes, so the token can be read on every field, and nothing reaches the server for it.
  const j = await phoneBrowser();
  let jPosts = 0;
  j.page.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) jPosts += 1;
  });
  const six = await newMatchWithManage(j.page, "Bang Tao Padel");
  await j.page.goto(`${BASE}/${six.code}`, { waitUntil: "load" });
  await j.page.getByRole("button", { name: "Join this match" }).click();
  const ownSpot = await tokenOf(j.page.getByTestId("open-spot-name").first());
  check("the player's own name in the open spot carries the passkey token, after its own", ownSpot === "given-name webauthn", String(ownSpot));
  await j.page.goto(`${BASE}/`, { waitUntil: "load" });
  const ownCreate = await tokenOf(j.page.getByTestId("create-own-name"));
  await j.page.locator("button[aria-expanded]", { hasText: "More options" }).click();
  const others = await tokenOf(j.page.getByTestId("have-already"));
  check("the create form's own name field carries it, and \"Players you already have\" does not", ownCreate === "given-name webauthn" && !String(others ?? "").includes("webauthn"), `${ownCreate} / ${others}`);
  // Another person's name: the organiser's view (the manage link, in this browser that knows nobody) holds a place for a name.
  await j.page.goto(six.manage, { waitUntil: "load" });
  await j.page.getByText("Tap to reserve for someone").first().click();
  const reserve = await tokenOf(j.page.getByTestId("open-spot-name").first());
  check("the organiser's open spot, which holds another person's name, carries no passkey token", reserve === "off", String(reserve));
  check("no call reached the server for the autofill on any of these pages: the page carries its own challenge", jPosts === 0, `posts=${jPosts}`);

  // ---- I: a browser that knows nobody, on a phone that keeps the passkey, signs in from the name field ----
  // Chromium's virtual authenticator picks the passkey as the player taps "Ana Passkey" above the keyboard.
  const i = await phoneBrowser();
  await i.cdp.send("WebAuthn.addCredential", { authenticatorId: i.authenticatorId, credential: await heldBy(k) });
  const autofilledBefore = await counter("signin_passkey_autofill");
  await i.page.goto(`${BASE}/${code}`);
  await i.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  check(
    "the passkey in the name field's autofill signs the browser in as the seated player, with no button and no Join, and makes no record",
    (await i.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).count()) === 1 && (await recordsNamed(NAME)) === 1,
  );
  check("it is a full session, not one by name", (await i.ctx.cookies()).some((x) => x.name === "km_player" && x.value.split(".").length === 2));
  let autofilled = await counter("signin_passkey_autofill");
  for (let n = 0; n < 10 && autofilled === autofilledBefore; n += 1) {
    await i.page.waitForTimeout(300);
    autofilled = await counter("signin_passkey_autofill");
  }
  check("the sign-in counts as signin_passkey_autofill", autofilled === autofilledBefore + 1, `${autofilledBefore} → ${autofilled}`);
  check("a signed-in page carries no passkey token: the name field is gone", (await i.page.locator('input[autocomplete$="webauthn"]').count()) === 0);
  await shot(i.page, "passkeys-05-autofill-signed-in");

  // ---- L: a page whose challenge ran out while it stayed open (review, 28 October 2026) ----
  // The browser's clock runs eleven minutes ahead, so the page's own challenge reads as spent time: a tab
  // that iOS kept in memory, or a page the back button brought back. The page must not hand the phone that
  // challenge (a Face ID for an "expired"), and a view still makes no call: the tap that opens the name
  // field makes the options call, and the pick over its options signs in once.
  const l = await phoneBrowser({
    init: () => {
      const real = Date.now;
      Date.now = () => real() + 11 * 60_000;
      const get = navigator.credentials.get.bind(navigator.credentials);
      window.__gets = [];
      navigator.credentials.get = (o) => {
        window.__gets.push({ mediation: o?.mediation ?? null });
        return get(o);
      };
    },
  });
  await l.cdp.send("WebAuthn.addCredential", { authenticatorId: l.authenticatorId, credential: await heldBy(i) });
  let lPosts = 0;
  l.page.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) lPosts += 1;
  });
  const lAutofill = await counter("signin_passkey_autofill");
  await l.page.goto(`${BASE}/${code}`, { waitUntil: "load" });
  await l.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
  await l.page.waitForTimeout(1500);
  const lGets = await l.page.evaluate(() => window.__gets.length);
  const lEarly = await l.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).count();
  check("a page whose challenge ran out hands the phone nothing, and the view makes no call", lGets === 0 && lEarly === 0 && lPosts === 0, `gets=${lGets} you=${lEarly} posts=${lPosts}`);
  // "Join this match" opens the open spot and puts the cursor in its name field: the player's tap.
  await l.page.getByRole("button", { name: "Join this match" }).click();
  await l.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  const lPostsAtSignIn = lPosts;
  let lCount = await counter("signin_passkey_autofill");
  for (let n = 0; n < 10 && lCount === lAutofill; n += 1) {
    await l.page.waitForTimeout(300);
    lCount = await counter("signin_passkey_autofill");
  }
  check(
    "the tap in the name field makes the options call, and the pick over its options signs in once, from the name field",
    lCount === lAutofill + 1 && lPostsAtSignIn === 2 && (await recordsNamed(NAME)) === 1 && (await l.page.getByText("That took too long").count()) === 0,
    `autofill ${lAutofill} → ${lCount}, posts=${lPostsAtSignIn}`,
  );

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
  check("nor on My matches", (await d.page.getByTestId("my-phones").count()) === 0 && (await d.page.getByTestId("remember-phone").count()) === 0);
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
  // My matches makes the same quiet offer to a record with no passkey, with a "Not now" of its own, so a
  // "Not now" after a join leaves the page where a player manages their phones its own choice.
  await e2.page.goto(`${BASE}/me`);
  const meOffer = e2.page.getByTestId("remember-phone");
  await meOffer.waitFor({ timeout: 15000 });
  check(
    "My matches offers \"Remember me on this phone\" to a record with no passkey, as the same quiet card with \"Not now\", and lists no phones",
    (await meOffer.getByRole("button", { name: "Remember this phone", exact: true }).count()) === 1 && (await meOffer.getByRole("button", { name: "Not now", exact: true }).count()) === 1 && (await e2.page.getByTestId("my-phones").count()) === 0,
  );
  await meOffer.getByRole("button", { name: "Not now", exact: true }).click();
  await e2.page.reload();
  await e2.page.waitForTimeout(1500);
  check("\"Not now\" hides it on My matches too", (await e2.page.getByTestId("remember-phone").count()) === 0);

  // ---- Remove: the phone's copy then signs in nobody ----
  await a.page.goto(`${BASE}/me`);
  await a.page.getByTestId("my-phones").getByRole("button", { name: /^Remove / }).click();
  await a.page.getByTestId("my-phone").waitFor({ state: "detached", timeout: 20000 });
  check("Remove takes the passkey away", Number((await ask(`select count(*)::int as n from passkeys k join players p on p.id = k.player_id where p.display_name = '${NAME}'`))[0]?.n) === 0);
  const f = await phoneBrowser({ autofill: false });
  await f.cdp.send("WebAuthn.addCredential", { authenticatorId: f.authenticatorId, credential: await heldBy(l) });
  await f.page.goto(`${BASE}/${code}`);
  await f.page.getByRole("button", { name: "Join this match" }).click();
  await f.page.getByTestId("back-in-open").getByTestId("passkey-signin").click();
  await f.page.getByText("Your phone did not sign you in.").waitFor({ timeout: 20000 });
  check("a removed passkey signs in nobody, and the page says so plainly", (await f.page.locator("main li", { hasText: NAME }).getByText("you", { exact: true }).count()) === 0);

  // ---- Device hints (the owner's decision of 28 October 2026, design B): the join keeps a key, outside Europe only ----
  // An iPhone in Phuket: its join keeps a key made from what the browser tells every site, a label and two
  // days, and My matches lists it with "Forget this phone". Every other context in this suite is in
  // Europe/Madrid (`iphone` in e2e/lib.mjs), and those joins keep nothing.
  const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  const hintsOf = async (name) => (await ask(`select count(*)::int as n, min(h.label) as label from device_hints h join players p on p.id = h.player_id where p.display_name = '${name}'`))[0];
  const phuket = await browser.newContext({ ...iphone, timezoneId: "Asia/Bangkok", userAgent: IPHONE_UA });
  const hp = await phuket.newPage();
  hp.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  const code6 = await newMatch(hp, "Rawai Padel");
  await joinAs(hp, code6, "Hana Hint");
  // The key is kept after the answer: give the after() a moment.
  await hp.waitForTimeout(1000);
  const kept = await hintsOf("Hana Hint");
  check("a join from a phone in Phuket keeps one device hint, under the words \"iPhone\"", kept?.n === 1 && kept?.label === "iPhone", JSON.stringify(kept));
  const keyRead = await fetch(`${BASE}/api/admin/sql?q=${encodeURIComponent("select key from device_hints")}`, { headers: CRON }).then((x) => x.json());
  check("the operator's read-only door is refused the key itself", keyRead.ok !== true && /permission denied/.test(String(keyRead.error)), JSON.stringify(keyRead).slice(0, 160));
  await hp.goto(`${BASE}/me`);
  const hints = hp.getByTestId("my-hints");
  await hints.waitFor({ timeout: 10000 });
  await hints.scrollIntoViewIfNeeded();
  const hintsText = (await hints.innerText()).replace(/\s+/g, " ");
  check(
    "My matches lists the phone under \"Phones we recognise\": the label, its first and last day, and \"Forget this phone\"",
    hintsText.includes("Phones we recognise") && (await hints.getByTestId("my-hint").count()) === 1 && /iPhone/.test(hintsText) && /Since .+ · last used /.test(hintsText) && (await hints.getByRole("button", { name: "Forget this phone: iPhone", exact: true }).count()) === 1,
    hintsText.slice(0, 200),
  );
  check("the card never calls it a fingerprint", !/fingerprint/i.test(hintsText));
  await view(hp, "passkeys-05-phones-we-recognise-390");
  await hints.getByRole("button", { name: "Forget this phone: iPhone", exact: true }).click();
  await hints.getByTestId("my-hint").waitFor({ state: "detached", timeout: 20000 });
  // The card stays with no phone: the privacy page sends the player to its switch at any time (PDPA s.32).
  check(
    "\"Forget this phone\" deletes the row, and the card stays with no phone and the switch \"Don't recognise my phones\"",
    (await hintsOf("Hana Hint"))?.n === 0 && (await hints.getByTestId("my-hint").count()) === 0 && (await hints.getByRole("switch", { name: "Don't recognise my phones", exact: true }).count()) === 1,
  );
  // "Don't recognise my phones" (Thai PDPA s.32; DECIDING rule 40): the player's lasting objection, under the
  // list. Another join keeps the key again; the switch then deletes it at once, and the block lists no phone.
  const code8 = await newMatch(hp, "Chalong Padel");
  await hp.goto(`${BASE}/${code8}`);
  await hp.getByRole("button", { name: "Join this match" }).click();
  await hp.locator("main li", { hasText: "Hana Hint" }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  await hp.waitForTimeout(1000);
  check("another join from the same phone keeps the key again", (await hintsOf("Hana Hint"))?.n === 1);
  await hp.goto(`${BASE}/me`);
  const objection = hints.getByRole("switch", { name: "Don't recognise my phones", exact: true });
  await objection.waitFor({ timeout: 10000 });
  await objection.scrollIntoViewIfNeeded();
  check("the block carries the switch \"Don't recognise my phones\", off, under the phone", (await objection.getAttribute("aria-checked")) === "false" && (await hints.getByTestId("my-hint").count()) === 1);
  await objection.click();
  await hints.locator('[role="switch"][aria-checked="true"]').waitFor({ timeout: 20000 });
  const marked = (await ask("select count(*)::int as n from players where display_name = 'Hana Hint' and hints_off is not null"))[0]?.n;
  check(
    "after the switch the block lists no phone, the database keeps no key, and the moment is kept",
    (await hints.getByTestId("my-hint").count()) === 0 && (await hintsOf("Hana Hint"))?.n === 0 && marked === 1,
    (await hints.innerText()).replace(/\s+/g, " ").slice(0, 200),
  );
  await view(hp, "passkeys-06-dont-recognise-my-phones-390");
  // The control: the same join from a browser set to a European zone keeps nothing.
  const madrid = await phoneBrowser();
  const code7 = await newMatch(madrid.page, "Kata Padel");
  await joinAs(madrid.page, code7, "Ivo Europe");
  await madrid.page.waitForTimeout(1000);
  check("the control: a join from a browser in Europe/Madrid keeps no hint at all", (await hintsOf("Ivo Europe"))?.n === 0);
} catch (e) {
  await crashed(browser, results, e);
} finally {
  await browser.close();
}
finish(results);
