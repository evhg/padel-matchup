// Viral pieces: robots/sitemap, the public americano generator with its prefill link,
// and the shareable result card.
import { BASE, crashed, finish, iphone, launch, makeCheck, shot, widestDayFits } from "./lib.mjs";

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
  const sitemapText = await sitemap.text();
  check("sitemap lists /americano", sitemap.status() === 200 && sitemapText.includes("/americano"));
  check("sitemap lists /play", sitemapText.includes("/play<"));

  // ---- Generator: 8 players → 7 exact rounds on 2 courts ----
  await p.goto(`${BASE}/americano`);
  check("generator page title", (await p.getByRole("heading", { name: "Americano schedule generator" }).count()) === 1);
  check("8 players default to the exact rotation note", (await p.getByText("7 rounds and every pair has partnered exactly once.").count()) > 0);
  await p.getByRole("button", { name: "Generate schedule" }).click();
  await p.getByText("Round 7").waitFor({ timeout: 10000 });
  check("7 rounds generated, not 8", (await p.getByText("Round 8").count()) === 0 && (await p.getByText("Court 2").count()) === 7);
  await shot(p, "v1-generator");
  const live = p.getByTestId("gen-live");
  check("live CTA prefills a tournament of 8 and is counted", (await live.getAttribute("href")) === "/?type=tournament&capacity=8&s=gen");
  // The card leads with what the app is and keeps the door under it, so this asserts both.
  check("the generator says who builds the app, and offers the door", (await p.getByRole("heading", { name: /built by the players on it/ }).count()) === 1 && (await p.getByRole("button", { name: /Tell us what should change/ }).count()) === 1);

  // ---- Names path: 5 names → 1 court, one sits out each round ----
  await p.getByLabel("Names (optional, one per line)").fill("Ana\nBo\nCy\nDi\nEd");
  check("names override the count", (await p.getByText("5 players on 1 courts: 1 sit out each round, spread fairly.").count()) > 0);
  await p.getByRole("button", { name: "Generate schedule" }).click();
  await p.getByText("Round 5").waitFor({ timeout: 10000 });
  check("sit-outs listed by name", (await p.getByText(/Sitting out: (Ana|Bo|Cy|Di|Ed)/).count()) === 5);
  check("live CTA rounds the field up to fours and carries the five names", (await live.getAttribute("href")) === "/?type=tournament&capacity=8&s=gen&names=Ana%2CBo%2CCy%2CDi%2CEd");

  // ---- Prefill on the landing page: it says what arrived, and the players come with it ----
  await p.goto(`${BASE}/?type=tournament&capacity=12`);
  check("landing prefilled as a 12-player tournament", (await p.locator('button[aria-pressed="true"]', { hasText: "Tournament" }).count()) === 1 && (await p.locator("main select").first().inputValue()) === "12");
  check("the prefilled page says it is the americano, not 'set up a match'", (await p.getByRole("heading", { name: "Your americano, live" }).count()) === 1);
  // By its address, not by its sales line: the tile's words change whenever the two organiser doors
  // are re-cut, and a marketing sentence is not the contract the landing page owes the generator.
  check("landing links to the generator", (await p.locator('a[href="/americano"]').count()) >= 1);
  // The whole hand-off: the generator's five names become five seated players with links to pass on.
  await p.goto(`${BASE}/?type=tournament&capacity=8&s=gen&names=Ana%2CBo%2CCy%2CDi%2CEd`);
  check("the carried players are named before anything is typed", (await p.getByTestId("carried-players").innerText()).includes("Ana · Bo · Cy · Di · Ed"));
  // The names ride in the form's own field now, so an organiser who did not come from the generator
  // can type the people they already have and the link goes out asking for what is really left.
  // More options opens itself when names arrived, so the field is already on screen: clicking it
  // here shut the panel and the field went away.
  check("the carried names arrive in the field an organiser can edit", (await p.getByTestId("have-already").inputValue()) === "Ana\nBo\nCy\nDi\nEd");
  await p.getByPlaceholder("e.g. Alex").fill("Ana");
  await p.getByRole("button", { name: "Create & get the link" }).click();
  // A refused create leaves the form where it is, and a bare waitForURL then dies saying only
  // "timeout". Watch both, and let the failure name itself.
  const share = /\/[^/]{4}\/share$/;
  const deadline = Date.now() + 30_000;
  while (!share.test(p.url()) && Date.now() < deadline) {
    if (await p.getByTestId("create-error").count()) throw new Error(`create refused: ${await p.getByTestId("create-error").innerText()}`);
    await p.waitForTimeout(250);
  }
  if (!share.test(p.url())) throw new Error(`create did not navigate in 30s: still ${p.url()}`);
  const genCode = p.url().split("/").slice(-2)[0];
  await p.goto(`${BASE}/${genCode}`);
  const rows = await p.locator("main li").allInnerTexts();
  // Ana holds her own spot; the four others are reserved, each with a link to pass on, and three spots stay open.
  const reserved = ["Bo", "Cy", "Di", "Ed"].every((x) => rows.some((r) => r.includes(`Reserved for ${x}`)));
  const anaOnce = rows.filter((r) => /\bAna\b/.test(r)).length === 1;
  check("the four carried players are seated with invite links, and Ana is not seated twice", reserved && anaOnce && (await p.getByText("3 spots left").count()) === 1, JSON.stringify(rows.slice(0, 6)).slice(0, 220));

  // ---- Result card ----
  await p.goto(`${BASE}/PAST`);
  // The match page leads with the card once the score is in: the picture, and WhatsApp one tap away (a WhatsApp group only ever gets it by hand).
  check("finished match shows its result card, with WhatsApp one tap away", (await p.locator('[data-testid="result-card"] img[src^="/PAST/card/opengraph-image?v="]').count()) === 1 && (await p.getByTestId("result-card").getByRole("link", { name: /WhatsApp/ }).count()) === 1);
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
  // Booked for two hours, so ninety minutes in it is still on and three more can join it (a 90-minute match would be over).
  const made = await p.request.post(`${BASE}/api/v1/matches`, { headers: auth, data: { startsAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(), durationMinutes: 120, tz: "Asia/Bangkok", venue: "Rawai Padel Club", organizer: { name: "Ana" } } }).then((r) => r.json());
  const mcode = made.match?.code;
  check("a match played ninety minutes ago is created for Ana", Boolean(mcode) && Boolean(made.organizer?.personalUrl), JSON.stringify(made).slice(0, 160));
  for (const name of ["Bo", "Cy", "Di"]) await p.request.post(`${BASE}/api/v1/matches/${mcode}/join`, { headers: auth, data: { name } });
  // The personal link hands the device its cookie in the browser, then sends it on to the match.
  await p.goto(`${made.organizer.personalUrl}?next=/${mcode}`);
  await p.waitForURL((u) => u.pathname === `/${mcode}`, { timeout: 20000 });
  await p.getByRole("button", { name: "Enter score" }).waitFor({ timeout: 20000 });
  await p.getByRole("button", { name: "Enter score" }).click();
  await p.getByRole("button", { name: /^Ana/ }).click();
  await p.getByRole("button", { name: /^Bo/ }).click();
  await p.getByRole("button", { name: "Save score" }).click();
  await p.getByText("Confirmed by organizer").waitFor({ timeout: 20000 });
  check("the organizer's score is confirmed at once", true);
  await p.getByTestId("result-card").waitFor({ timeout: 20000 });
  check("right after the score the match page offers the court photo on the card", (await p.getByTestId("result-card").getByTestId("photo-add").count()) === 1);
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
  await p.goto(`${BASE}/built`);
  check("the page of ideas that became the app opens", (await p.getByTestId("built-empty").count()) + (await p.getByTestId("built-list").count()) === 1);
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

  // ---- Find a game: the landing chip opens /play, a listed match shows there, and a day chip hides it ----
  // Tomorrow at 18:00 in Phuket (UTC+7 all year), computed from the moment the suite runs (rule 11):
  // never today, always inside "This week".
  const bkk = new Date(Date.now() + 7 * 3600 * 1000);
  const tomorrowEvening = new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate() + 1, 18 - 7));
  const listed = await p.request.post(`${BASE}/api/v1/matches`, { data: { startsAt: tomorrowEvening.toISOString(), tz: "Asia/Bangkok", venue: "Rawai Padel Club", organizer: { name: "Pia Sol" }, listOnVenueBoard: true, cost: "400 THB", levelMin: 2, levelMax: 4 } }).then((r) => r.json());
  const lcode = listed.match?.code;
  check("a listed match for tomorrow in Phuket is created", Boolean(lcode), JSON.stringify(listed).slice(0, 160));
  await p.goto(`${BASE}/`);
  check("the landing page offers Find a game under the headline", (await p.getByTestId("landing-find-game").getAttribute("href")) === "/play");
  await p.getByTestId("landing-find-game").click();
  await p.waitForURL((u) => u.pathname === "/play", { timeout: 20000 });
  const row = p.getByTestId("event-row").and(p.locator(`a[href="/${lcode}"]`));
  await row.waitFor({ timeout: 20000 });
  // The chips are set in capitals by the stylesheet and innerText carries that, so compare lower-cased.
  // Pia is seated as the organiser, so three of the four spots are left.
  const rowText = (await row.innerText()).toLowerCase();
  check("/play lists the public match with its time, seats, level, price and the organiser's first name", rowText.includes("18:00") && rowText.includes("3 spots left") && rowText.includes("400 thb") && rowText.includes("by pia") && !rowText.includes("sol") && /2\.0–4\.0/.test(rowText), rowText.replace(/\s+/g, " ").slice(0, 200));
  await shot(p, "v5-play");
  // The weekday stays on the row, so its column must hold the widest one ("DOM, 13 SEPT") on one line at 390 px.
  const day = await widestDayFits(row.getByTestId("event-row-day")).catch((e) => ({ ok: false, worst: String(e).slice(0, 80) }));
  check("the game's day is one line inside its column at 390 px, for the widest day in every language", day.ok, JSON.stringify(day.worst));
  await p.getByTestId("play-day-today").click();
  await p.waitForURL((u) => u.searchParams.get("day") === "today", { timeout: 20000 });
  await p.locator(`a[href="/${lcode}"]`).waitFor({ state: "detached", timeout: 20000 });
  check("the Today chip hides tomorrow's match and keeps the choice in the URL", (await p.locator(`a[href="/${lcode}"]`).count()) === 0 && new URL(p.url()).searchParams.get("city") === "phuket");
  await p.getByTestId("play-day-tomorrow").click();
  await p.waitForURL((u) => u.searchParams.get("day") === "tomorrow", { timeout: 20000 });
  const back = await p.locator(`a[href="/${lcode}"]`).waitFor({ timeout: 20000 }).then(() => true, () => false);
  check("the Tomorrow chip brings it back", back && new URL(p.url()).searchParams.get("day") === "tomorrow");
  // Tomorrow holds Pia's match, so a club nobody plays at hides every game: the list says so, and
  // "Show them all" drops the club (and keeps the day) to bring the games back.
  await p.goto(`${BASE}/play?city=phuket&day=tomorrow&club=no-such-club`);
  const noneFit = p.getByTestId("play-none-fit");
  const hidden = await noneFit.waitFor({ timeout: 20000 }).then(() => true, () => false);
  check("a filter that hides everything says so", hidden && (await p.locator(`a[href="/${lcode}"]`).count()) === 0);
  await noneFit.getByRole("link", { name: "Show them all" }).click();
  await p.waitForURL((u) => u.pathname === "/play" && !u.searchParams.has("club"), { timeout: 20000 }).catch(() => undefined);
  const cleared = await p.locator(`a[href="/${lcode}"]`).waitFor({ timeout: 20000 }).then(() => true, () => false);
  check("\"Show them all\" clears the club and brings the games back", cleared && !new URL(p.url()).searchParams.has("club") && new URL(p.url()).searchParams.get("day") === "tomorrow", p.url());
  // The empty state needs a city and day with no open game at all. Other suites list games on the same
  // server (agents and embeds in Singapore), so look for one rather than assume it; alone, Singapore is empty.
  let emptyAt = "";
  for (const [city, day] of [["singapore", "today"], ["singapore", "tomorrow"], ["phuket", "today"]]) {
    await p.goto(`${BASE}/play?city=${city}&day=${day}`);
    if ((await p.getByTestId("play-empty").count()) === 1) {
      emptyAt = `${city}, ${day}`;
      break;
    }
  }
  if (emptyAt) {
    await p.getByTestId("play-empty").getByRole("link", { name: "Organize one in 30 seconds" }).click();
    await p.waitForURL((u) => u.pathname === "/", { timeout: 20000 }).catch(() => undefined);
    const form = await p.getByRole("button", { name: "Create & get the link" }).waitFor({ timeout: 20000 }).then(() => true, () => false);
    check(`the empty state's button opens the create form (${emptyAt})`, form && new URL(p.url()).pathname === "/", p.url());
  } else {
    console.log("· every city and day here had a game from another suite, so the empty state's button was not reached in this run");
  }
} catch (e) {
  await crashed(browser, results, e);
} finally {
  await browser.close();
}
finish(results);
