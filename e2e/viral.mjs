// Viral pieces: robots/sitemap, the public americano generator with its prefill link,
// and the shareable result card.
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
  const p = await newPage();
  const robots = await p.request.get(`${BASE}/robots.txt`);
  check("robots.txt served with a sitemap line", robots.status() === 200 && (await robots.text()).includes("Sitemap:"));
  const sitemap = await p.request.get(`${BASE}/sitemap.xml`);
  check("sitemap lists /americano", sitemap.status() === 200 && (await sitemap.text()).includes("/americano"));

  // ---- Generator: 8 players → 7 exact rounds on 2 courts ----
  await p.goto(`${BASE}/americano`);
  check("generator page title", (await p.getByRole("heading", { name: "Americano schedule generator" }).count()) === 1);
  check("8 players default to the exact rotation note", (await p.getByText("7 rounds and every pair has partnered exactly once.").count()) > 0);
  await p.getByRole("button", { name: "Generate schedule" }).click();
  await p.getByText("Round 7").waitFor({ timeout: 10000 });
  check("7 rounds generated, not 8", (await p.getByText("Round 8").count()) === 0 && (await p.getByText("Court 2").count()) === 7);
  await shot(p, "v1-generator");
  const live = p.getByRole("link", { name: /Run it live on Kicksmash/ });
  check("live CTA prefills a tournament of 8", (await live.getAttribute("href")) === "/?type=tournament&capacity=8");

  // ---- Names path: 5 names → 1 court, one sits out each round ----
  await p.getByLabel("Names (optional, one per line)").fill("Ana\nBo\nCy\nDi\nEd");
  check("names override the count", (await p.getByText("5 players on 1 courts: 1 sit out each round, spread fairly.").count()) > 0);
  await p.getByRole("button", { name: "Generate schedule" }).click();
  await p.getByText("Round 5").waitFor({ timeout: 10000 });
  check("sit-outs listed by name", (await p.getByText(/Sitting out: (Ana|Bo|Cy|Di|Ed)/).count()) === 5);
  check("live CTA rounds the field up to fours", (await live.getAttribute("href")) === "/?type=tournament&capacity=8");

  // ---- Prefill on the landing page ----
  await p.goto(`${BASE}/?type=tournament&capacity=12`);
  check("landing prefilled as a 12-player tournament", (await p.locator('button[aria-pressed="true"]', { hasText: "Tournament" }).count()) === 1 && (await p.locator("main select").first().inputValue()) === "12");
  check("landing links to the generator", (await p.getByRole("link", { name: /schedule generator/ }).count()) === 1);

  // ---- Result card ----
  await p.goto(`${BASE}/PAST`);
  check("finished match offers Share result", (await p.getByRole("link", { name: /Share result/ }).count()) === 1);
  await p.goto(`${BASE}/PAST/card`);
  await shot(p, "v2-card");
  check("card page shows the image and the result line", (await p.locator('img[src="/PAST/card/opengraph-image"]').count()) === 1 && (await p.getByText(/beat|drew|Result/).count()) > 0);
  const img = await p.request.get(`${BASE}/PAST/card/opengraph-image`);
  check("card image is a PNG", img.status() === 200 && (img.headers()["content-type"] ?? "").startsWith("image/png") && (await img.body()).length > 10000);
  const html = await p.request.get(`${BASE}/PAST/card`);
  check("card page carries og:image for messenger previews", (await html.text()).includes('property="og:image"'));
  check("card CTA leads back to creating a match", (await p.getByRole("link", { name: "Organize your own match" }).count()) === 1);
  await p.goto(`${BASE}/PLAY/card`);
  check("no result yet → back to the match page", new URL(p.url()).pathname === "/PLAY");
} catch (e) {
  console.error("✗ crashed:", e);
  results.push({ name: "crash", ok: false });
} finally {
  await browser.close();
}
finish(results);
