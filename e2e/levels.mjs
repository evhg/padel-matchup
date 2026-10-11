// Levels: ranged match (Gold preset), level chips, out-of-range request → approve/decline,
// in-range direct join, level editor on My matches, the "Your level?" card after an open join.
import { BASE, crashed, finish, iphone, launch, makeCheck, shot, switchLang } from "./lib.mjs";

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
  // ---- Organizer creates a Gold match and declares her own level ----
  const org = await newPage();
  await org.goto(BASE + "/");
  await org.getByPlaceholder("e.g. Alex").fill("Olga");
  check("level presets stay behind the level chip until asked", (await org.getByRole("button", { name: "Gold", exact: true }).count()) === 0 && /any level/i.test(await org.getByTestId("level-chip").innerText()));
  await org.getByTestId("level-chip").click();
  await org.getByRole("button", { name: "Gold", exact: true }).click();
  check("gold preset explains the range and asks the organizer's level", (await org.getByText("3.0–4.5. Players outside can ask to join").count()) > 0 && (await org.getByLabel("Your level").count()) === 1);
  await org.getByLabel("Your level").selectOption({ label: "3.5" });
  await shot(org, "l1-create-gold");
  await org.getByRole("button", { name: "Create & get the link" }).click();
  await org.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code = org.url().split("/").slice(-2)[0];
  await org.goto(`${BASE}/${code}`);
  await shot(org, "l2-event-gold");
  check("hero shows the level chip", (await org.getByText("Gold · 3.0–4.5").count()) > 0, code);
  check("organizer's level chip next to her name", (await org.locator("li", { hasText: "Olga" }).getByText("3.5", { exact: true }).count()) > 0);

  // ---- Bea (2.0) is below the range: asks to join ----
  const bea = await newPage();
  await bea.goto(`${BASE}/${code}`);
  await bea.getByRole("button", { name: "Join this match" }).click();
  check("no-identity join on a ranged event asks name and level inline", (await bea.locator("main form input").count()) > 0 && (await bea.locator("main form select").count()) === 1);
  await bea.getByPlaceholder("e.g. Alex").fill("Bea");
  await bea.locator("main form").getByLabel("Your level").selectOption({ label: "2.0" });
  await bea.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
  await bea.getByText("Request sent").waitFor({ timeout: 20000 });
  await shot(bea, "l3-request-sent");
  check("out-of-range join becomes a request", (await bea.getByText("Waiting for Olga").count()) > 0 && (await bea.getByText("You're in").count()) === 0);

  // ---- Organizer sees and approves ----
  await org.reload();
  await org.getByText("Requests to join").waitFor({ timeout: 20000 });
  check("organizer sees the request with the level", (await org.getByText("Bea", { exact: true }).count()) > 0 && (await org.locator("li", { hasText: "Bea" }).getByText("2.0", { exact: true }).count()) > 0);
  await shot(org, "l4-requests");
  await org.getByRole("button", { name: "Approve" }).click();
  await org.getByText("2/4 players").waitFor({ timeout: 20000 });
  check("approved player is seated", (await org.getByText("Requests to join").count()) === 0);
  check("activity says you approved", (await org.getByText("You approved Bea").count()) > 0);
  await bea.reload();
  check("Bea sees she's in", (await bea.getByText("You're in").count()) > 0);

  // ---- Cal (4.0) is in range: joins directly ----
  const cal = await newPage();
  await cal.goto(`${BASE}/${code}`);
  await cal.getByRole("button", { name: "Join this match" }).click();
  await cal.getByPlaceholder("e.g. Alex").fill("Cal");
  await cal.locator("main form").getByLabel("Your level").selectOption({ label: "4.0" });
  await cal.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
  await cal.getByText("You're in").waitFor({ timeout: 20000 });
  check("in-range player joins directly", (await cal.getByText("3/4 players").count()) > 0);

  // ---- Dee (5.0) above the range: request, then declined ----
  const dee = await newPage();
  await dee.goto(`${BASE}/${code}`);
  await dee.getByRole("button", { name: "Join this match" }).click();
  await dee.getByPlaceholder("e.g. Alex").fill("Dee");
  await dee.locator("main form").getByLabel("Your level").selectOption({ label: "5.0" });
  await dee.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
  await dee.getByText("Request sent").waitFor({ timeout: 20000 });
  check("declared level shows as out of range in the bar", (await dee.getByText("Request sent").count()) > 0);
  await org.reload();
  await org.getByRole("button", { name: "Decline" }).click();
  await org.getByText("Requests to join").waitFor({ state: "detached", timeout: 20000 });
  check("activity (collapsed) records the decline", (await org.getByText("You declined Dee's request").count()) > 0);
  await dee.reload();
  await shot(dee, "l5-declined");
  check("declined requester sees the outcome", (await dee.getByText("Olga didn't approve your request this time.").count()) > 0);
  check("still 3/4 after decline", (await dee.getByText("3/4 players").count()) > 0);

  // ---- Withdraw: Eve asks, then withdraws ----
  const eve = await newPage();
  await eve.goto(`${BASE}/${code}`);
  await eve.getByRole("button", { name: "Join this match" }).click();
  await eve.getByPlaceholder("e.g. Alex").fill("Eve");
  await eve.locator("main form").getByLabel("Your level").selectOption({ label: "1.0" });
  await eve.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
  await eve.getByText("Request sent").waitFor({ timeout: 20000 });
  await eve.getByRole("button", { name: "Withdraw" }).click();
  await eve.getByRole("button", { name: "Ask to join" }).waitFor({ timeout: 20000 });
  check("withdrawn request returns to 'Ask to join' with the out-of-range note", (await eve.getByText("Your level (1.0) is outside 3.0–4.5.").count()) > 0);

  // ---- My matches: level editor ----
  await cal.goto(`${BASE}/me`);
  check("my matches shows the declared level", (await cal.getByText("Self-declared").count()) > 0 && (await cal.locator("section", { hasText: "Your level" }).getByText("4.0", { exact: true }).count()) > 0);
  await cal.locator("section", { hasText: "Your level" }).getByRole("button", { name: "Edit", exact: true }).click();
  await cal.getByLabel("Your level").selectOption({ label: "3.75" });
  await cal.locator("section", { hasText: "Your level" }).getByRole("button", { name: "Save", exact: true }).click();
  await cal.locator("section", { hasText: "Your level" }).getByText("3.75", { exact: true }).waitFor({ timeout: 20000 });
  check("level edited from My matches", true);
  await shot(cal, "l6-me-level");
  await cal.goto(`${BASE}/${code}`);
  check("roster chip follows the edit", (await cal.locator("li", { hasText: "Cal" }).getByText("3.75", { exact: true }).count()) > 0);

  // ---- Organizer can switch the range off later ----
  await org.goto(`${BASE}/${code}`);
  await org.getByRole("button", { name: "Edit match" }).click();
  // The presets sit behind the chip on the edit form too: the chip reads the range, one tap opens them.
  await org.getByTestId("level-chip").click();
  await org.getByRole("button", { name: "Any level", exact: true }).click();
  await org.getByRole("button", { name: "Save changes" }).click();
  await org.getByText("Gold · 3.0–4.5").waitFor({ state: "detached", timeout: 20000 }).catch(() => undefined);
  check("range removed via edit", (await org.getByText("Gold · 3.0–4.5").count()) === 0);

  // ---- Fay joins the open match with no level: one tap under the join sets it ----
  const fay = await newPage();
  await fay.goto(`${BASE}/${code}`);
  await fay.getByRole("button", { name: "Join this match" }).click();
  await fay.getByPlaceholder("e.g. Alex").fill("Fay");
  await fay.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
  await fay.getByText("You're in").waitFor({ timeout: 20000 });
  const ask = fay.getByTestId("level-after-join");
  await ask.waitFor({ timeout: 20000 });
  check("a new player on an open match is asked 'Your level?' with the named bands, Playtomic and Skip", (await ask.getByText("Your level?").count()) === 1 && (await ask.getByRole("button", { name: "Intermediate", exact: true }).count()) === 1 && (await ask.getByRole("button", { name: "I have a Playtomic number" }).count()) === 1 && (await ask.getByRole("button", { name: "Skip", exact: true }).count()) === 1);
  await shot(fay, "l7-level-after-join");
  // The longest band is Russian ("Продвинутый"): at 390 px every band button must hold its word and stay inside the card.
  const bandsFit = () => ask.evaluate((card) => { const edge = card.getBoundingClientRect().right; return [...card.querySelectorAll("[data-testid=level-bands] button")].map((b) => ({ text: b.textContent, fits: b.scrollWidth <= b.clientWidth + 1 && b.getBoundingClientRect().right <= edge + 0.5 })); });
  await switchLang(fay, "ru");
  await ask.getByRole("button", { name: "Продвинутый", exact: true }).waitFor({ timeout: 20000 });
  const ruBands = await bandsFit();
  check("in Russian the three band buttons fit inside the card at 390 px", ruBands.length === 3 && ruBands.every((b) => b.fits), JSON.stringify(ruBands));
  await shot(fay, "l7b-level-after-join-ru");
  await switchLang(fay, "en");
  await ask.getByRole("button", { name: "Intermediate", exact: true }).waitFor({ timeout: 20000 });
  const enBands = await bandsFit();
  check("in English they fit too", enBands.length === 3 && enBands.every((b) => b.fits), JSON.stringify(enBands));
  await ask.getByRole("button", { name: "Intermediate", exact: true }).click();
  await fay.locator("li", { hasText: "Fay" }).getByText("3.0", { exact: true }).waitFor({ timeout: 20000 });
  check("one tap on Intermediate puts the 3.0 chip on her roster row and the card is gone", (await fay.getByTestId("level-after-join").count()) === 0);
  await fay.goto(`${BASE}/me`);
  check("the tap saved it as self-declared, as My matches does", (await fay.getByText("Self-declared").count()) > 0 && (await fay.locator("section", { hasText: "Your level" }).getByText("3.0", { exact: true }).count()) > 0);

  // ---- Played together (DECIDING rule 21, the owner, 11 October 2026): Quin (1.5) sat in a scored match
  // with Pia, so Pia's Gold match lets him straight in. The match is half an hour old and scored at the
  // court: a score is what makes it finished, not the end of the booked length. ----
  const api = await newPage();
  const key = await api.request.post(`${BASE}/api/v1/keys`, { data: { name: "e2e levels", agent: "playwright" } }).then((r) => r.json());
  const auth = { authorization: `Bearer ${key.key}` };
  const past = await api.request.post(`${BASE}/api/v1/matches`, { headers: auth, data: { startsAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), durationMinutes: 90, tz: "Asia/Bangkok", venue: "Rawai Padel Club", organizer: { name: "Pia", level: 3.5 } } }).then((r) => r.json());
  const pcode = past.match?.code;
  const joined = [];
  for (const [name, level] of [["Quin", 1.5], ["Rae", 3.5], ["Sol", 3.5]]) joined.push(await api.request.post(`${BASE}/api/v1/matches/${pcode}/join`, { headers: auth, data: { name, level } }).then((r) => r.json()));
  const pia = await newPage();
  await pia.goto(`${past.organizer.personalUrl}?next=/${pcode}`);
  await pia.waitForURL((u) => u.pathname === `/${pcode}`, { timeout: 20000 });
  await pia.getByRole("button", { name: "Enter score" }).click();
  await pia.getByRole("button", { name: /^Pia/ }).click();
  await pia.getByRole("button", { name: /^Rae/ }).click();
  await pia.getByRole("button", { name: "Save score" }).click();
  await pia.getByText("Confirmed by organizer").waitFor({ timeout: 20000 });
  const gold = await api.request.post(`${BASE}/api/v1/matches`, { headers: auth, data: { startsAt: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(), tz: "Asia/Bangkok", venue: "Rawai Padel Club", levelMin: 3, levelMax: 4.5, organizer: { name: "Pia", token: past.organizer.personalToken } } }).then((r) => r.json());
  const gcode = gold.match?.code;
  const quin = await newPage();
  await quin.goto(`${joined[0].player.personalUrl}?next=/${gcode}`);
  await quin.waitForURL((u) => u.pathname === `/${gcode}`, { timeout: 20000 });
  await quin.getByRole("button", { name: "Join this match" }).waitFor({ timeout: 20000 });
  check("a player who sat in a scored match with the organiser meets Join on her Gold match, not Ask to join", (await quin.getByRole("button", { name: "Ask to join" }).count()) === 0, `${pcode} → ${gcode}`);
  await quin.getByRole("button", { name: "Join this match" }).click();
  await quin.getByText("You're in").waitFor({ timeout: 20000 });
  await shot(quin, "l8-played-together");
  check("and the tap seats him at once, with no request to wait for", (await quin.getByText("Request sent").count()) === 0 && (await quin.getByText("2/4 players").count()) > 0);
} catch (e) {
  await crashed(browser, results, e);
} finally {
  await browser.close();
}
finish(results);
