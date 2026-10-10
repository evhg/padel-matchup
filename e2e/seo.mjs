// Search pages: /levels (FAQ markup, CTA), the pre-generated americano schedules, and the fine print (/privacy, /terms).
import { BASE, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);

try {
  // Raw HTML doubles every string in the RSC payload, so counts come from the rendered page.
  const ctx = await browser.newContext(iphone);
  const page = await ctx.newPage();
  // Language paths: /ru and /es serve the same pages in Russian and Spanish, set the cookie, and carry hreflang.
  const ru = await fetch(`${BASE}/ru/phuket`, { redirect: "manual" });
  const ruHtml = await ru.text();
  check("/ru/phuket renders in Russian with hreflang and sets the language cookie", ru.status === 200 && ruHtml.includes('<html lang="ru"') && /hreflang="es"/i.test(ruHtml) && ruHtml.includes('rel="canonical" href="' + BASE + '/ru/phuket"') && /NEXT_LOCALE=ru/.test(ru.headers.get("set-cookie") ?? ""), `${ru.status} ${ru.headers.get("set-cookie")}`);
  const es = await fetch(`${BASE}/es/levels`);
  const esHtml = await es.text();
  check("/es/levels renders in Spanish", es.status === 200 && esHtml.includes('<html lang="es"') && esHtml.includes("nivel"));
  const plain = await fetch(`${BASE}/levels`);
  check("the plain path stays English with x-default pointing at itself", new RegExp('hreflang="x-default" href="' + BASE + '/levels"', "i").test(await plain.text()));
  const sm = await fetch(`${BASE}/sitemap.xml`).then((r) => r.text());
  check("the sitemap lists the language variants with alternates", sm.includes(`${BASE}/ru/phuket`) && sm.includes(`${BASE}/es/americano/8`) && /hreflang="ru"/i.test(sm));
  // The fine print in full: /privacy and /terms answer in every language, sit in the sitemap, and the
  // promise on /about leads to /privacy. The figures come from the code, so "14 days" proves they rendered.
  const privacy = await fetch(`${BASE}/privacy`);
  const privacyHtml = await privacy.text();
  check("/privacy names the operator, the cookies and the figures", privacy.status === 200 && privacyHtml.includes("Kicksmash, Phuket, Thailand") && privacyHtml.includes("km_player") && privacyHtml.includes("14 days"), String(privacy.status));
  const ruPrivacy = await fetch(`${BASE}/ru/privacy`);
  check("/ru/privacy renders in Russian", ruPrivacy.status === 200 && (await ruPrivacy.text()).includes("Конфиденциальность"));
  const terms = await fetch(`${BASE}/terms`);
  check("/terms renders with Thai law", terms.status === 200 && (await terms.text()).includes("the law of Thailand"), String(terms.status));
  const esTerms = await fetch(`${BASE}/es/terms`);
  check("/es/terms renders in Spanish", esTerms.status === 200 && (await esTerms.text()).includes("Condiciones de uso"));
  check("the sitemap lists /privacy and /terms in every language", sm.includes(`${BASE}/privacy`) && sm.includes(`${BASE}/ru/privacy`) && sm.includes(`${BASE}/es/terms`));
  await page.goto(`${BASE}/about`);
  await page.getByRole("link", { name: "The full privacy page →" }).click();
  await page.waitForURL(`${BASE}/privacy`);
  check("the promise on /about leads to the privacy page", (await page.getByRole("heading", { name: "Privacy", exact: true }).count()) === 1);
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
  check("schedule page: live CTA prefills a 12-player tournament and is counted", (await page.getByTestId("gen-live").getAttribute("href")) === "/?type=tournament&capacity=12&s=gen");
  // The card leads with what the app is and keeps the door under it, so this asserts both.
  check("the ready-made schedule says who builds the app, and offers the door", (await page.getByRole("heading", { name: /built by the players on it/ }).count()) === 1 && (await page.getByRole("button", { name: /Tell us what should change/ }).count()) === 1);
  await shot(page, "s1-americano-12");
  await page.goto(`${BASE}/levels`);
  check("levels page: CTA to set the level", (await page.getByRole("link", { name: "Set your level" }).count()) + (await page.getByRole("link", { name: /Set/ }).count()) > 0);
  await shot(page, "s2-levels");
} finally {
  await browser.close();
}
finish(results);
