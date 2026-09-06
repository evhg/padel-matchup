// Embeds and oEmbed: iframe-safe board and match views, the oEmbed provider, discovery links, the snippet on the board.
import { BASE, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);

try {
  const startsAt = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
  const created = await fetch(`${BASE}/api/v1/matches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ startsAt, tz: "Asia/Singapore", venue: "Embed Club", listOnVenueBoard: true, organizer: { name: "Emi", level: 3 } }) }).then((r) => r.json());
  const code = created.match.code;
  check("match created for the embed checks", typeof code === "string" && code.length === 4, JSON.stringify(created).slice(0, 200));

  const oe = await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(`${BASE}/${code}`)}&format=json`);
  const oj = await oe.json();
  check("oEmbed for a match: rich, provider Kicksmash, iframe html", oe.status === 200 && oj.type === "rich" && oj.provider_name === "Kicksmash" && /<iframe /.test(oj.html) && oj.html.includes(`/embed/match/${code}`), JSON.stringify(oj).slice(0, 200));
  const ob = await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(`${BASE}/v/embed-club`)}&format=json&maxwidth=300`).then((r) => r.json());
  check("oEmbed for a board honours maxwidth", ob.width === 300 && ob.html.includes('width="300"') && ob.html.includes("/embed/board/embed-club"), JSON.stringify(ob).slice(0, 200));
  check("oEmbed rejects foreign urls", (await fetch(`${BASE}/api/oembed?url=${encodeURIComponent("https://example.com/x")}`)).status === 404);
  check("oEmbed xml is declined politely", (await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(`${BASE}/${code}`)}&format=xml`)).status === 501);

  const matchHtml = await fetch(`${BASE}/${code}`).then((r) => r.text());
  check("match page advertises its oEmbed endpoint", /type="application\/json\+oembed"/.test(matchHtml) && matchHtml.includes("/api/oembed?url="));
  const boardHtml = await fetch(`${BASE}/v/embed-club`).then((r) => r.text());
  check("venue board advertises its oEmbed endpoint", /type="application\/json\+oembed"/.test(boardHtml));

  const ctx = await browser.newContext(iphone);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/embed/board/embed-club`);
  check("embed board: no site header, the match listed, opens on kicksma.sh", (await page.getByRole("link", { name: "My matches" }).count()) === 0 && (await page.getByText("Padel at Embed Club").count()) === 1 && (await page.getByText(/Open on kicksma\.sh/).count()) === 1 && (await page.locator(`a[href$="/${code}"]`).count()) === 1);
  const target = await page.locator(`a[href$="/${code}"]`).getAttribute("target");
  check("embed links open in a new tab", target === "_blank");
  await shot(page, "e1-embed-board");
  await page.goto(`${BASE}/embed/match/${code}`);
  check("embed match: organizer on the roster and a join button with spots left", (await page.getByText("Emi").count()) >= 1 && (await page.getByRole("link", { name: /3 spots left/ }).count()) === 1);
  await shot(page, "e2-embed-match");
  check("embed pages stay out of the index", /noindex/.test(await page.locator('meta[name="robots"]').getAttribute("content").catch(() => "")));

  await page.goto(`${BASE}/v/embed-club`);
  await page.getByRole("button", { name: /Embed this board/ }).click();
  check("board shows the iframe snippet with a copy button", (await page.locator("pre code").innerText()).includes(`/embed/board/embed-club`) && (await page.getByRole("button", { name: "Copy code" }).count()) === 1);
  check("unknown embed targets are 404", (await fetch(`${BASE}/embed/board/nope-nope`)).status === 404 && (await fetch(`${BASE}/embed/match/ZZZZ`)).status === 404);
} finally {
  await browser.close();
}
finish(results);
