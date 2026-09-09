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
  check("card page shows the image and the result line", (await p.locator('img[src^="/PAST/card/opengraph-image?v="]').count()) === 1 && (await p.getByText(/beat|drew|Result/).count()) > 0);
  const img = await p.request.get(`${BASE}/PAST/card/opengraph-image`);
  check("card image is a PNG", img.status() === 200 && (img.headers()["content-type"] ?? "").startsWith("image/png") && (await img.body()).length > 10000);
  const html = await p.request.get(`${BASE}/PAST/card`);
  check("card page carries og:image for messenger previews", (await html.text()).includes('property="og:image"'));
  check("card CTA leads back to creating a match", (await p.getByRole("link", { name: "Organize your own match" }).count()) === 1);
  await p.goto(`${BASE}/PLAY/card`);
  check("no result yet → back to the match page", new URL(p.url()).pathname === "/PLAY");

  // ---- Their photo, our frame; earned moments ----
  const key = await p.request.post(`${BASE}/api/v1/keys`, { data: { name: "e2e viral", agent: "playwright" } }).then((r) => r.json());
  const auth = { authorization: `Bearer ${key.key}` };
  const made = await p.request.post(`${BASE}/api/v1/matches`, { headers: auth, data: { startsAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(), tz: "Asia/Bangkok", venue: "Rawai Padel Club", organizer: { name: "Ana" } } }).then((r) => r.json());
  const mcode = made.match?.code;
  check("a match played ninety minutes ago is created for Ana", Boolean(mcode) && Boolean(made.organizer?.personalUrl), JSON.stringify(made).slice(0, 160));
  for (const name of ["Bo", "Cy", "Di"]) await p.request.post(`${BASE}/api/v1/matches/${mcode}/join`, { headers: auth, data: { name } });
  // The personal link hands the device its cookie in the browser, then sends it on to the match.
  await p.goto(`${made.organizer.personalUrl}?next=/${mcode}`);
  await p.waitForURL(`**/${mcode}`, { timeout: 20000 });
  await p.getByRole("button", { name: "Enter score" }).waitFor({ timeout: 20000 });
  await p.getByRole("button", { name: "Enter score" }).click();
  await p.getByRole("button", { name: /^Ana/ }).click();
  await p.getByRole("button", { name: /^Bo/ }).click();
  await p.getByRole("button", { name: "Save score" }).click();
  await p.getByText("Confirmed by organizer").waitFor({ timeout: 20000 });
  check("the organizer's score is confirmed at once", true);
  await p.goto(`${BASE}/${mcode}/card`);
  check("the card page praises the winners and offers the weekly group", (await p.getByTestId("praise").count()) === 1 && (await p.getByTestId("same-time").count()) === 1);
  const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGNgYGD4z8DAwAAABAAC/wKzCgAAAABJRU5ErkJggg==", "base64");
  await p.getByTestId("photo-input").setInputFiles({ name: "court.png", mimeType: "image/png", buffer: tinyPng });
  await p.locator(`img[src^="/${mcode}/card/opengraph-image?v="][src*="-p"]`).waitFor({ timeout: 30000 });
  check("a participant's photo becomes the card's background and the picture's version changes", true);
  const withPhoto = await p.request.get(`${BASE}/${mcode}/card/opengraph-image`);
  check("the card with the photo is still a PNG", withPhoto.status() === 200 && (withPhoto.headers()["content-type"] ?? "").startsWith("image/png") && (await withPhoto.body()).length > 10000);
  const canShareHere = await p.evaluate(() => typeof navigator.share === "function");
  check("the share button offers the picture where the phone can share files (hidden where it cannot)", canShareHere ? (await p.getByRole("button", { name: "Share the picture…" }).count()) === 1 : (await p.getByRole("button", { name: "Share the picture…" }).count()) === 0, `navigator.share ${canShareHere ? "present" : "absent"}`);
  check("the uploader can take the photo down", (await p.getByTestId("photo-remove").count()) === 1);
  await shot(p, "v3-card-photo");
  let momentsSeen = false;
  for (let i = 0; i < 5 && !momentsSeen; i++) {
    await p.goto(`${BASE}/me`);
    momentsSeen = (await p.getByTestId("moments").count()) === 1;
    if (!momentsSeen) await p.waitForTimeout(1500);
  }
  check("My matches shows Ana's first win as a moment", momentsSeen && (await p.getByText("First win").count()) >= 1);
  const momentHref = momentsSeen ? await p.getByTestId("moments").locator("a").first().getAttribute("href") : null;
  if (momentHref) {
    await p.goto(`${BASE}${momentHref}`);
    check("the moment page names the player and the moment", (await p.getByRole("heading", { name: "First win" }).count()) === 1 && (await p.getByText(/Ana/).count()) >= 1);
    const mimg = await p.request.get(`${BASE}${momentHref}/opengraph-image`);
    check("the moment picture is a PNG", mimg.status() === 200 && (mimg.headers()["content-type"] ?? "").startsWith("image/png"));
    const mhtml = await p.request.get(`${BASE}${momentHref}`).then((r) => r.text());
    check("the moment page unfurls with its picture and is not indexed", mhtml.includes('property="og:image"') && /noindex/.test(mhtml));
    await shot(p, "v4-moment");
  }
} catch (e) {
  console.error("✗ crashed:", e);
  results.push({ name: "crash", ok: false });
} finally {
  await browser.close();
}
finish(results);
