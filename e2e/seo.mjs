// Search pages: /levels (FAQ markup, CTA) and the pre-generated americano schedules.
import { BASE, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);

try {
  // Raw HTML doubles every string in the RSC payload, so counts come from the rendered page.
  const ctx = await browser.newContext(iphone);
  const page = await ctx.newPage();
  const levels = await fetch(`${BASE}/levels`);
  const levelsHtml = await levels.text();
  check("/levels renders with FAQ structured data", levels.status === 200 && levelsHtml.includes('"@type":"FAQPage"') && levelsHtml.includes("What your padel level means"));
  await page.goto(`${BASE}/levels`);
  check("/levels names the bands and the presets", (await page.getByText("Intermediate", { exact: true }).count()) === 1 && (await page.getByText(/Gold · 3\.0–4\.5/).count()) === 1);

  await page.goto(`${BASE}/americano/8`);
  const rounds8 = await page.getByRole("heading", { name: /^Round \d+$/ }).count();
  const courts8 = await page.getByText("Court 1", { exact: true }).count();
  // Names render as pairs ("Player 7 + Player 8"), so match the pair cell, not an exact string.
  const p8 = await page.getByText(/\bPlayer 8\b/).count();
  check("/americano/8: seven rounds, two courts each, players numbered", rounds8 === 7 && courts8 === 7 && p8 === 7, `${rounds8} rounds, ${courts8} court-1 rows, ${p8} cells with Player 8`);
  await page.goto(`${BASE}/americano/24`);
  check("/americano/24: 23 rounds", (await page.getByRole("heading", { name: /^Round \d+$/ }).count()) === 23);
  check("odd field sizes are not pages", (await fetch(`${BASE}/americano/9`)).status === 404 && (await fetch(`${BASE}/americano/abc`)).status === 404);

  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  check("sitemap lists /levels and the schedule pages", sitemap.includes("/levels") && sitemap.includes("/americano/8") && sitemap.includes("/americano/24"));

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
