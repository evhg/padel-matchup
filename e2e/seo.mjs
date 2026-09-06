// Search pages: /levels (FAQ markup, CTA) and the pre-generated americano schedules.
import { BASE, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);

try {
  const levels = await fetch(`${BASE}/levels`);
  const levelsHtml = await levels.text();
  check("/levels renders with FAQ structured data", levels.status === 200 && levelsHtml.includes('"@type":"FAQPage"') && levelsHtml.includes("What your padel level means"));
  check("/levels names the bands and the presets", levelsHtml.includes("Intermediate") && levelsHtml.includes("Gold") && levelsHtml.includes("3.0–4.5"));

  const eight = await fetch(`${BASE}/americano/8`);
  const eightHtml = await eight.text();
  const rounds = (eightHtml.match(/Round \d+/g) ?? []).length;
  check("/americano/8: seven rounds, two courts each, players numbered", eight.status === 200 && rounds === 7 && (eightHtml.match(/Court 1/g) ?? []).length === 7 && eightHtml.includes("Player 8"));
  const twentyFour = await fetch(`${BASE}/americano/24`);
  check("/americano/24: 23 rounds", twentyFour.status === 200 && ((await twentyFour.text()).match(/Round \d+/g) ?? []).length === 23);
  check("odd field sizes are not pages", (await fetch(`${BASE}/americano/9`)).status === 404 && (await fetch(`${BASE}/americano/abc`)).status === 404);

  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  check("sitemap lists /levels and the schedule pages", sitemap.includes("/levels") && sitemap.includes("/americano/8") && sitemap.includes("/americano/24"));

  const ctx = await browser.newContext(iphone);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/americano`);
  check("generator links to the ready-made sizes and the levels page", (await page.getByRole("link", { name: "16", exact: true }).count()) === 1 && (await page.getByRole("link", { name: "Padel levels" }).count()) === 1);
  await page.goto(`${BASE}/americano/12`);
  check("schedule page: live CTA prefills a 12-player tournament", (await page.getByRole("link", { name: "Run it live on Kicksmash" }).getAttribute("href")) === "/?type=tournament&capacity=12");
  await shot(page, "s1-americano-12");
  await page.goto(`${BASE}/levels`);
  check("levels page: CTA to set the level", (await page.getByRole("link", { name: "Set your level" }).count()) + (await page.getByRole("link", { name: /Set/ }).count()) > 0);
  await shot(page, "s2-levels");
} finally {
  await browser.close();
}
finish(results);
