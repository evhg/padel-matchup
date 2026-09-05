// Formats and the Russian round: mexicano and King of the Court rounds, scores gating,
// organizer-confirmed levels, opt-in rankings, city pages.
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
const api = async (path, body, key) => {
  const res = await fetch(BASE + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};
/** Text of one round's card, whitespace collapsed. */
const roundText = async (page, n) => (await page.getByText(`Round ${n}`, { exact: true }).locator("xpath=../..").innerText()).replace(/\s+/g, " ");
/** Names on a court, in the order they appear (side A first). */
const court = (txt, n, names) => {
  // Court labels render uppercase; innerText keeps the transform.
  const parts = txt.split(/court (\d+)/i);
  const idx = parts.findIndex((p, i) => i % 2 === 1 && Number(p) === n);
  const seg = (idx >= 0 ? parts[idx + 1] : "").split(/ vs /i);
  const a = names.filter((x) => (seg[0] ?? "").includes(x));
  const b = names.filter((x) => (seg[1] ?? "").includes(x));
  return { a, b, all: [...a, ...b].sort() };
};
const untilEnabled = async (locator, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await locator.isDisabled())) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};
const fillScores = async (page, values) => {
  // values: [[a, b], ...] by court order of the latest round (rows render newest round first).
  for (let i = 0; i < values.length; i++) {
    await page.locator('input[aria-label="A"]').nth(i).fill(String(values[i][0]));
    await page.locator('input[aria-label="B"]').nth(i).fill(String(values[i][1]));
    await page.locator('input[aria-label="B"]').nth(i).blur();
    await page.getByText("✓ Saved").first().waitFor({ timeout: 15000 });
  }
};
const fillUntilFull = async (code, prefix, key, level = 3) => {
  const names = [];
  for (let i = 1; i <= 8; i++) {
    const r = await api(`/api/v1/matches/${code}/join`, { name: `${prefix}${i}`, level }, key);
    if (r.status !== 200) throw new Error(`join ${prefix}${i}: ${r.status} ${JSON.stringify(r.json)}`);
    names.push(`${prefix}${i}`);
    if (r.json.match.spotsLeft === 0) break;
  }
  return names;
};

try {
  const keyRes = await api("/api/v1/keys", { name: "e2e formats" });
  const key = keyRes.json?.key;
  check("API key for the suite", typeof key === "string" && key.startsWith("ks_live_"), keyRes.status);

  // ---- Kira creates a mexicano from the form ----
  const org = await newPage();
  await org.goto(BASE + "/");
  await org.getByPlaceholder("e.g. Alex").fill("Kira");
  check("format chips hidden for a plain match", (await org.getByRole("button", { name: "Mexicano", exact: true }).count()) === 0);
  await org.getByRole("button", { name: /^Tournament/ }).click();
  check("tournament shows the three formats with americano selected", (await org.getByRole("button", { name: "Americano", exact: true }).getAttribute("aria-pressed")) === "true" && (await org.getByRole("button", { name: "King of the court", exact: true }).count()) === 1);
  await org.getByRole("button", { name: "Mexicano", exact: true }).click();
  check("mexicano explains itself and sets 24 points", (await org.getByText(/courts follow the standings/).count()) > 0 && (await org.locator("select").filter({ has: org.locator('option[value="21"]') }).inputValue()) === "24");
  await org.getByLabel("Players").selectOption("8");
  await org.getByPlaceholder("Court TBD · or type a club").fill("Club Mex");
  await shot(org, "f1-create-mexicano");
  await org.getByRole("button", { name: "Create & get the link" }).click();
  await org.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const mex = org.url().split("/").slice(-2)[0];
  const mexNames = await fillUntilFull(mex, "Mex", key);
  await org.goto(`${BASE}/${mex}`);
  check("panel is titled Mexicano", (await org.locator("section#score h2").innerText()) === "Mexicano", mex);
  check("format chips offered until round 1", (await org.locator("section#score").getByRole("button", { name: "King of the court", exact: true }).count()) === 1);
  await org.getByRole("button", { name: "Generate round 1" }).click();
  await org.getByText("Round 1", { exact: true }).waitFor({ timeout: 20000 });
  check("format chips gone once a round exists", (await org.locator("section#score").getByRole("button", { name: "King of the court", exact: true }).count()) === 0);
  const names = ["Kira", ...mexNames];
  const r1 = await roundText(org, 1);
  const c1 = court(r1, 1, names);
  const c2 = court(r1, 2, names);
  check("round 1 seats eight players on two courts", c1.all.length === 4 && c2.all.length === 4, r1);
  const gen2 = org.getByRole("button", { name: "Generate round 2" });
  check("round 2 waits for the scores", (await gen2.isDisabled()) && (await org.getByText("Enter all scores of round 1 first.").count()) > 0);
  // Court 1: A 16-8. Court 2: A 20-4 (fixed points fill the other side).
  await org.locator('input[aria-label="A"]').nth(0).fill("16");
  await org.locator('input[aria-label="A"]').nth(0).blur();
  await org.getByText("✓ Saved").first().waitFor({ timeout: 15000 });
  await org.locator('input[aria-label="A"]').nth(1).fill("20");
  await org.locator('input[aria-label="A"]').nth(1).blur();
  check("scores unlock round 2", await untilEnabled(gen2));
  await gen2.click();
  await org.getByText("Round 2", { exact: true }).waitFor({ timeout: 20000 });
  const r2 = court(await roundText(org, 2), 1, names);
  check("round 2 court 1 = court-2 winners + court-1 winners", r2.all.join() === [...c2.a, ...c1.a].sort().join(), JSON.stringify({ got: r2.all, want: [...c2.a, ...c1.a].sort() }));
  check("1st+4th against 2nd+3rd: each pair mixes a 20 and a 16", r2.a.filter((n) => c2.a.includes(n)).length === 1 && r2.b.filter((n) => c2.a.includes(n)).length === 1);
  await shot(org, "f2-mexicano-round2");
  await org.locator('input[aria-label="A"]').nth(0).fill("13");
  await org.locator('input[aria-label="A"]').nth(0).blur();
  await org.getByText("✓ Saved").first().waitFor({ timeout: 15000 });
  await org.locator('input[aria-label="A"]').nth(1).fill("12");
  await org.locator('input[aria-label="A"]').nth(1).blur();
  await org.getByText("✓ Saved").first().waitFor({ timeout: 15000 });
  await org.getByRole("button", { name: /Finalize scores/ }).click();
  await org.getByText("Final standings").waitFor({ timeout: 20000 });
  check("mexicano finalized", true);

  // ---- King of the Court, created through the API in Phuket, driven with the manage link ----
  const startsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const kingRes = await api("/api/v1/matches", { type: "tournament", format: "king", capacity: 8, startsAt, tz: "Asia/Bangkok", venue: "Rawai Padel Club", listOnVenueBoard: true, organizer: { name: "Kai", level: 3 } }, key);
  check("API creates a King of the Court tournament", kingRes.status === 201 && kingRes.json?.match?.format === "king", kingRes.status);
  const king = kingRes.json.match.code;
  const kingNames = await fillUntilFull(king, "King", key);
  await org.goto(kingRes.json.organizer.manageUrl);
  await org.waitForURL(new RegExp(`/${king}$`), { timeout: 20000 });
  check("panel is titled King of the court", (await org.locator("section#score h2").innerText()) === "King of the court", king);
  await org.getByRole("button", { name: "Generate round 1" }).click();
  await org.getByText("Round 1", { exact: true }).waitFor({ timeout: 20000 });
  const kn = ["Kai", ...kingNames];
  const k1 = await roundText(org, 1);
  const k1c1 = court(k1, 1, kn);
  const k1c2 = court(k1, 2, kn);
  // Court 1: A wins 21-10. Court 2: B wins 8-21.
  await fillScores(org, [
    [21, 10],
    [8, 21],
  ]);
  const kgen2 = org.getByRole("button", { name: "Generate round 2" });
  check("king round 2 unlocked by the scores", await untilEnabled(kgen2));
  await kgen2.click();
  await org.getByText("Round 2", { exact: true }).waitFor({ timeout: 20000 });
  const k2 = await roundText(org, 2);
  const k2c1 = court(k2, 1, kn);
  const k2c2 = court(k2, 2, kn);
  check("king: court-1 winners stay, court-2 winners come up", k2c1.all.join() === [...k1c1.a, ...k1c2.b].sort().join(), JSON.stringify({ got: k2c1.all, want: [...k1c1.a, ...k1c2.b].sort() }));
  check("king: losers meet on court 2", k2c2.all.join() === [...k1c1.b, ...k1c2.a].sort().join());
  check("king: last round's partners split", !(k2c1.a.join() === k1c1.a.join() || k2c1.b.join() === k1c1.a.join()));
  check("king standings show the court", (await org.locator("section#score table").getByText(/· Court 1/).count()) >= 2);
  await shot(org, "f3-king-round2");
  await fillScores(org, [
    [21, 15],
    [21, 12],
  ]);
  await org.getByRole("button", { name: /Finalize scores/ }).click();
  await org.getByText("Final standings").waitFor({ timeout: 20000 });

  // ---- Organizer confirms levels after the result ----
  const confirmRow = org.getByRole("button", { name: /Confirm levels/ });
  check("confirm-levels row appears once the result is final, folded", (await confirmRow.count()) === 1 && (await org.getByRole("button", { name: /Confirm all/ }).count()) === 0);
  await confirmRow.click();
  check("seven players to confirm, none yet", (await org.getByText("7 players to confirm").count()) > 0 && (await org.getByRole("button", { name: "Looks right" }).count()) === 7);
  await org.getByRole("button", { name: "Looks right" }).first().click();
  await org.getByText("✓ Confirmed").first().waitFor({ timeout: 15000 });
  await org.getByRole("button", { name: /Confirm all 6/ }).click();
  await org.getByText("7 levels confirmed").waitFor({ timeout: 15000 });
  await shot(org, "f4-confirm-levels");
  await org.reload();
  check("roster shows the tick next to confirmed levels", (await org.locator("li", { hasText: "King1" }).getByText("✓").count()) === 1 && (await org.locator("li", { hasText: "Kai" }).getByText("✓").count()) === 0);

  // ---- Rankings are opt-in ----
  await org.goto(`${BASE}/v/rawai-padel-club/ranking`);
  check("club ranking exists but nobody opted in yet", (await org.getByRole("heading", { name: "Rawai Padel Club ranking" }).count()) === 1 && (await org.getByText(/nobody has opted in/).count()) > 0);
  await org.goto(`${BASE}/me`);
  const optIn = org.getByLabel(/Show me in rankings/);
  check("My matches offers the ranking opt-in, off by default", (await optIn.count()) === 1 && !(await optIn.isChecked()));
  await optIn.check();
  await org.waitForTimeout(800);
  await org.goto(`${BASE}/v/club-mex/ranking`);
  check("opted-in organizer appears in her club's ranking", (await org.locator("table").getByText("Kira").count()) === 1 && (await org.locator("table").getByText("Mex1").count()) === 0);
  await shot(org, "f5-club-ranking");
  check("venue board links to the ranking", await org.goto(`${BASE}/v/club-mex`).then(async () => (await org.getByRole("link", { name: /Ranking/ }).count()) === 1));

  // ---- City pages ----
  await org.goto(`${BASE}/phuket`);
  check("Phuket page lists the Rawai tournament and the club", (await org.getByRole("heading", { name: "Padel in Phuket" }).count()) === 1 && (await org.getByText("Rawai Padel Club").count()) >= 2);
  check("Phuket ranking says results exist but nobody opted in", (await org.getByText(/nobody has opted in/).count()) > 0);
  await shot(org, "f6-phuket");
  await org.goto(`${BASE}/singapore`);
  // Other suites may have listed Singapore matches before this one runs: only the shell is asserted.
  check("Singapore page renders", (await org.getByRole("heading", { name: "Padel in Singapore" }).count()) === 1 && (await org.getByRole("heading", { name: "Open matches" }).count()) === 1 && (await org.getByRole("heading", { name: "How it works here" }).count()) === 1);
  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  check("sitemap lists the city pages", sitemap.includes("/phuket") && sitemap.includes("/singapore"));
  const pub = await api(`/api/v1/matches/${king}`);
  check("public match shape carries the format", pub.json?.format === "king");
} finally {
  await browser.close();
}
finish(results);
