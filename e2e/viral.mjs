// Viral pieces: robots/sitemap, the public americano generator with its prefill link,
// and the shareable result card.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, openMore, crashed, finish, iphone, launch, makeCheck, shot, switchLang, widestDayFits } from "./lib.mjs";

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
  // The page's own card "built by the players on it" went on 25 November 2026: the footer's button is every screen's door.
  check("the generator offers the feedback door once, as the button in its footer", (await p.getByRole("heading", { name: /built by the players on it/ }).count()) === 0 && (await p.getByRole("button", { name: /Tell us what should change/ }).count()) === 1 && (await p.locator("footer").getByRole("button", { name: /Tell us what should change/ }).count()) === 1);

  // ---- Names path: 5 names → 1 court, one sits out each round ----
  await p.getByLabel("Names (optional, one per line)").fill("Ana\nBo\nCy\nDi\nEd");
  check("names override the count", (await p.getByText("5 players on 1 courts: 1 sit out each round, spread fairly.").count()) > 0);
  await p.getByRole("button", { name: "Generate schedule" }).click();
  await p.getByText("Round 5").waitFor({ timeout: 10000 });
  check("sit-outs listed by name", (await p.getByText(/Sitting out: (Ana|Bo|Cy|Di|Ed)/).count()) === 5);
  check("live CTA rounds the field up to fours and carries the five names", (await live.getAttribute("href")) === "/?type=tournament&capacity=8&s=gen&names=Ana%2CBo%2CCy%2CDi%2CEd");

  // ---- Prefill on the landing page: it says what arrived, and the players come with it ----
  await p.goto(`${BASE}/?type=tournament&capacity=12`);
  // "Tournament" is a line under More options now, not a segment (the owner, 9 November 2026): the formats say it is one.
  check("landing prefilled as a 12-player tournament", (await p.getByRole("button", { name: "Americano", exact: true }).getAttribute("aria-pressed")) === "true" && (await p.locator("main select").first().inputValue()) === "12");
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
  // The count line says how many places are held as well as the spots open (the owner, 12 October 2026).
  const genCount = (await p.getByTestId("count-line").innerText().catch(() => "")).trim();
  check("the four carried players are seated with invite links, and Ana is not seated twice", reserved && anaOnce && genCount === "3 spots left · 4 places held", JSON.stringify({ count: genCount, rows: rows.slice(0, 6) }).slice(0, 260));

  // ---- Paste your booking, the door: the owner's own words (11 October 2026), a court at Warehaus
  // booked in a platform's app with Danny and Alberto, pasted on the landing page. No link, so the
  // server reads nothing from outside. Warehaus is no club row on this server (the directory is
  // production's data; coach.mjs says the same), so the club is the one field left to the organiser,
  // and the day and the hour are read in the browser's zone. The day is three days out there, written
  // as a booking app writes it, from the moment the suite runs (rule 11). The whole journey to a
  // booked match, at a club this server knows, is in clubs.mjs. ----
  const kim = await newPage();
  const kimZone = "Europe/Madrid"; // the iphone context's zone (e2e/lib.mjs)
  const bkAt = new Date(Date.now() + 3 * 86400 * 1000);
  const bkDay = new Intl.DateTimeFormat("en-CA", { timeZone: kimZone }).format(bkAt);
  const bkText = `Warehaus ${new Intl.DateTimeFormat("en-GB", { timeZone: kimZone, weekday: "short", day: "numeric", month: "short" }).format(bkAt)} 18:00-19:30 court 3 with Danny, Alberto`;
  await kim.goto(`${BASE}/`);
  check("the landing page offers 'Booked already? Paste it' beside Find a game, closed", (await kim.getByTestId("paste-door").innerText()).includes("Booked already? Paste it") && (await kim.getByTestId("paste-sheet").count()) === 0);
  await kim.getByTestId("paste-door").click();
  const pasteBox = kim.getByLabel("Paste the booking link and the text from your booking app.");
  check("it opens one box with the hint", await pasteBox.isVisible());
  // The third door, named where people paste (11 October 2026): only the owner knew book@ existed.
  // This server holds a webhook secret and a send key (e2e/run.mjs), so book@ can answer here.
  const mailLine = kim.getByTestId("paste-mail");
  check("the hint names book@ as the other way in, as a mail link", (await mailLine.innerText()).startsWith("Or forward the confirmation to book@") && (await mailLine.getByRole("link").getAttribute("href"))?.startsWith("mailto:book@"), await mailLine.innerText().catch(() => "no paste-mail"));
  await kim.getByRole("button", { name: "Read my booking" }).click();
  check("an empty box answers with a sentence, and stays", (await kim.getByTestId("paste-note").innerText()) === "Paste the link or the text of your booking first." && new URL(kim.url()).search === "");
  // "Add screenshot" (the owner, 11 October 2026, DECIDING rule 9). This server holds no model key
  // (e2e/run.mjs pins it empty), so the picture goes all the way through: the browser draws it again as
  // a JPEG, the server action takes it and answers with one plain line, and the words below still read
  // after it. A one-pixel PNG is enough for the browser to open.
  const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  check("the box offers 'Add screenshot', and says the picture is read once and not kept", (await kim.getByRole("button", { name: "Add screenshot" }).isVisible()) && (await kim.getByText("An AI model reads your screenshot once. We do not keep it.").isVisible()));
  await kim.getByTestId("paste-shot-file").setInputFiles({ name: "booking.png", mimeType: "image/png", buffer: Buffer.from(PNG_1PX, "base64") });
  await kim.getByTestId("paste-note").filter({ hasText: "screenshot" }).waitFor({ timeout: 20000 });
  check("with no key on this server, a screenshot gets one plain line, and the page stays", (await kim.getByTestId("paste-note").innerText()) === "Reading a screenshot is not available now. Paste the link or the text instead." && new URL(kim.url()).search === "", await kim.getByTestId("paste-note").innerText());
  await pasteBox.fill(bkText);
  check("the sentence goes once the box changes", (await kim.getByTestId("paste-note").count()) === 0);
  await shot(kim, "v6-paste-door");
  await kim.getByRole("button", { name: "Read my booking" }).click();
  // Watch the address and the answer together: a refused read stays on the page with a sentence.
  const pasteBy = Date.now() + 30_000;
  while (new URL(kim.url()).searchParams.get("src") !== "paste" && Date.now() < pasteBy) {
    if ((await kim.getByTestId("paste-note").count()) && !(await kim.getByTestId("paste-note").innerText()).startsWith("Paste the link")) throw new Error(`paste refused: ${await kim.getByTestId("paste-note").innerText()}`);
    await kim.waitForTimeout(250);
  }
  check("'Read my booking' opens the create form from the booking", new URL(kim.url()).searchParams.get("src") === "paste", kim.url());
  await kim.getByTestId("carried-players").waitFor({ timeout: 20000 });
  const filled = {
    venue: await kim.getByLabel(/Venue/).inputValue(),
    date: await kim.locator('main input[type="date"]').inputValue(),
    time: await kim.locator('main input[type="time"]').inputValue(),
    zone: await kim.getByRole("button", { name: "Europe/Madrid", exact: true }).count(),
    length: await kim.getByTestId("length-choice").getByRole("button", { name: "90 min" }).getAttribute("aria-pressed"),
    court: await kim.getByPlaceholder("e.g. 3 or Centre court").inputValue(),
  };
  check("the form is filled with the day, 18:00, 90 minutes and court 3, and the club is left empty", JSON.stringify(filled) === JSON.stringify({ venue: "", date: bkDay, time: "18:00", zone: 1, length: "true", court: "3" }), JSON.stringify(filled));
  check("the club the booking did not give is asked for in words, and only the club", (await kim.getByTestId("paste-missing-club").innerText()).includes("Your booking did not name the club. Pick it here.") && (await kim.getByTestId("paste-missing-when").count()) === 0);
  check("the players come as 'from your booking', not from a schedule", (await kim.getByTestId("carried-players").innerText()).includes("2 players from your booking") && (await kim.getByTestId("carried-players").innerText()).includes("Danny · Alberto"));
  check("'Court booked by me' stands ticked above the create button", await kim.getByTestId("booked-by-me").isChecked());
  await shot(kim, "v7-paste-form");
  // What the booking did not say keeps the form's own day and hour (Kim has no usual slot: tomorrow at
  // 18:00, in the booking's zone), and the form says in words that they are not the booking's.
  await kim.goto(`${BASE}/?src=paste&venue=Rawai%20Padel%20Club&tz=Asia%2FBangkok&names=Danny&booked=1`);
  await kim.getByTestId("paste-missing-when").waitFor({ timeout: 20000 });
  const bkkTomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date(Date.now() + 86400 * 1000));
  const keptWhen = { date: await kim.locator('main input[type="date"]').inputValue(), time: await kim.locator('main input[type="time"]').inputValue() };
  check(
    "a booking with no day and no hour keeps the form's own, and says they are not the booking's",
    JSON.stringify(keptWhen) === JSON.stringify({ date: bkkTomorrow, time: "18:00" }) && (await kim.getByText("Your booking did not give the day. Pick it here.").count()) === 1 && (await kim.getByText("Your booking did not give the time. Pick it here.").count()) === 1,
    JSON.stringify(keptWhen),
  );
  // A booking that came with no zone (book@, a chat with none): the day and the hour it read, in the
  // person's own zone. Until 11 October 2026 the link said tz=UTC, and 11:00 in Phuket became 18:00.
  await kim.goto(`${BASE}/?src=paste&date=${bkDay}&time=11%3A00&booked=1`);
  await kim.getByTestId("booked-by-me").waitFor({ timeout: 20000 });
  // The zone is under More options, which a booking with no names leaves closed.
  await openMore(kim);
  await kim.getByRole("button", { name: kimZone, exact: true }).waitFor({ timeout: 10000 }).catch(() => undefined);
  const noZone = { date: await kim.locator('main input[type="date"]').inputValue(), time: await kim.locator('main input[type="time"]').inputValue(), zone: await kim.getByRole("button", { name: kimZone, exact: true }).count(), utc: await kim.getByRole("button", { name: "UTC", exact: true }).count() };
  check("a booking with no zone keeps its day and hour, in the person's own zone and never UTC", JSON.stringify(noZone) === JSON.stringify({ date: bkDay, time: "11:00", zone: 1, utc: 0 }), JSON.stringify(noZone));
  await kim.context().close();

  // ---- Result card ----
  await p.goto(`${BASE}/PAST`);
  // The match page leads with the card once the score is in: the picture, and "Share the game results" right under it,
  // a visitor with no seat too. The share card under the match numbers is off after the match (the owner, 26 November
  // 2026: "the big share the result button is redundant"), and no share sits in a bar at the foot of the screen.
  check(
    "finished match shows its result card with Share the game results under it, and no second share card after the match",
    (await p.locator('[data-testid="result-card"] img[src^="/PAST/card/opengraph-image?v="]').count()) === 1 &&
      (await p.getByTestId("result-card").getByTestId("result-share").getByText("Share the game results").count()) === 1 &&
      (await p.getByTestId("match-share").count()) === 0 &&
      (await p.locator('.fixed a[href^="https://wa.me"]').count()) === 0,
  );
  // A public page after the match (the owner, 26 November 2026): a visitor sees the result, not "Edit score", not
  // "Play again" and not "Only players can enter the score". The line-up stays only as a door, each behind its
  // constant in src/lib/domain/afterMatch.ts: "That's me" for a browser that knows nobody (`THATS_ME_DOOR`), and the
  // line-up fix's "I played instead" for a signed-in viewer in its seven days (`STRANGER_FIX_DOOR`), as this one is.
  const pastVisitor = {
    edit: await p.getByTestId("score-edit").count(),
    again: await p.getByTestId("play-again").count(),
    onlyPlayers: await p.getByText("Only players in this match can enter the score.").count(),
  };
  const pastLineup = await p.getByRole("heading", { name: /players/ }).count();
  const pastDoors = (await p.getByRole("button", { name: "That's me", exact: true }).count()) + (await p.getByTestId("fix-replace").count()) + (await p.getByTestId("fix-take").count());
  const pastSignIn = await p.getByTestId("event-back-in").count();
  check(
    "a visitor of a finished match sees no Edit score and no Play again, and a line-up only where it is a door in",
    Object.values(pastVisitor).every((n) => n === 0) && (pastLineup === 0 ? pastSignIn === 0 : pastDoors > 0),
    JSON.stringify({ ...pastVisitor, pastLineup, pastDoors, pastSignIn }),
  );
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
  const playedAt = Date.now() - 90 * 60 * 1000;
  const made = await p.request.post(`${BASE}/api/v1/matches`, { headers: auth, data: { startsAt: new Date(playedAt).toISOString(), durationMinutes: 120, tz: "Asia/Bangkok", venue: "Rawai Padel Club", organizer: { name: "Ana" } } }).then((r) => r.json());
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
  // The form starts empty (an untouched 6-4 once saved as a real result): the score is typed.
  await p.locator("#score input[type=number]").nth(0).fill("6");
  await p.locator("#score input[type=number]").nth(1).fill("4");
  await p.getByRole("button", { name: "Save score" }).click();
  await p.getByText("Confirmed by organizer").waitFor({ timeout: 20000 });
  check("the organizer's score is confirmed at once", true);
  await p.getByTestId("result-card").waitFor({ timeout: 20000 });
  // A card with no reel and no photo: "Add the court photo" is a small grey button, not one across the card
  // (the owner, 26 November 2026: "its oversized too").
  const photoDoor = await p.getByTestId("result-card").evaluate((el) => {
    const b = el.querySelector("[data-testid=photo-add]");
    return b ? { label: b.textContent, narrower: b.getBoundingClientRect().width < el.getBoundingClientRect().width - 1 } : null;
  });
  check("right after the score the match page offers the court photo on the card, as a small button", photoDoor?.label === "Add the court photo" && photoDoor.narrower, JSON.stringify(photoDoor));
  // "Edit score" sits under the score it changes, above the card (the owner, 26 November 2026).
  const editAt = await p.locator("#score").evaluate((el) => {
    const edit = el.querySelector("[data-testid=score-edit]");
    const card = el.querySelector("[data-testid=result-card]");
    return edit && card ? { text: edit.textContent, above: edit.getBoundingClientRect().bottom <= card.getBoundingClientRect().top + 0.5 } : null;
  });
  check("Edit score is a small action right under the score, above the result card", editAt?.text === "Edit score" && editAt.above, JSON.stringify(editAt));
  // "Share the game results" shares the card page's link, whose preview is the card, and never a file.
  await p.evaluate(() => {
    window.__shared = null;
    navigator.share = async (data) => {
      window.__shared = { url: data.url, title: data.title, files: Array.isArray(data.files) ? data.files.length : 0 };
    };
  });
  await p.getByTestId("result-share").click();
  const sharedData = await p.evaluate(() => window.__shared);
  check("Share the game results hands the phone the card page's link and a title, and no picture file", Boolean(sharedData) && sharedData.url === `${BASE}/${mcode}/card?s=card` && sharedData.files === 0 && /6-4/.test(sharedData.title ?? ""), JSON.stringify(sharedData));
  // Beside the card: "Play again" with its one control, a week on by default, and no "Make it weekly" (the owner,
  // 26 November 2026: "Remove the make it weekly").
  const bangkokDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  const score = p.locator("#score");
  const nextWhen = await score.getByTestId("play-again-when").inputValue();
  check("the score panel offers Play again, a week on by default, and no weekly slot beside it", nextWhen.startsWith(`${bangkokDay(playedAt + 7 * 24 * 3600 * 1000)}T`) && (await score.getByTestId("same-time").count()) === 0 && (await p.getByText("Make it weekly").count()) === 0, nextWhen);
  // At 390 px the field takes its own line and "Play again" keeps the panel's width under it; the field
  // carries its bounds; and nothing of it runs past the card's edges (the owner, 26 November 2026: the date
  // selector "is out of bounds and leaks horizontally"), in Russian too.
  const panelLayout = () =>
    score.evaluate((el) => {
      const box = (q) => el.querySelector(q).getBoundingClientRect();
      const field = box("[data-testid=play-again-when]");
      const play = box("[data-testid=play-again] button");
      const panel = el.getBoundingClientRect();
      const inside = (r) => r.left >= panel.left - 0.5 && r.right <= panel.right + 0.5;
      return { stacked: play.top >= field.bottom - 1 && Math.abs(play.width - field.width) <= 1, fits: inside(field) && inside(play) && document.documentElement.scrollWidth <= window.innerWidth, label: el.querySelector("[data-testid=play-again] button").textContent };
    });
  const enPanel = await panelLayout();
  const bounds = { min: await score.getByTestId("play-again-when").getAttribute("min"), max: await score.getByTestId("play-again-when").getAttribute("max") };
  await switchLang(p, "ru");
  await score.getByTestId("play-again").getByText("Сыграть снова").waitFor({ timeout: 20000 });
  const ruPanel = await panelLayout();
  await shot(p, "v3b-score-panel-ru");
  // The panel after a change of language: its button says it in the language now on screen, and follows the next change.
  await switchLang(p, "en");
  await score.getByTestId("play-again").getByText("Play again").waitFor({ timeout: 20000 });
  const enAgain = await panelLayout();
  check("after a change of language, Play again says itself in that language", /Сыграть снова/.test(ruPanel.label) && /Play again/.test(enAgain.label), JSON.stringify({ ru: ruPanel.label, en: enAgain.label }));
  check(
    "at 390 px Play again sits full width under its field, the field has its bounds, and both stay inside the card in English and Russian",
    enPanel.stacked && enPanel.fits && ruPanel.stacked && ruPanel.fits && /Play again/.test(enPanel.label) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(bounds.min ?? "") && (bounds.max ?? "") > (bounds.min ?? ""),
    JSON.stringify({ enPanel, ruPanel, bounds }),
  );
  await p.goto(`${BASE}/${mcode}/card`);
  check("the card page praises the winners and offers no weekly group", (await p.getByTestId("praise").count()) === 1 && (await p.getByTestId("same-time").count()) === 0);
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
  // "Play again" all the way through: another day picked in the control, the next game made on it.
  await p.goto(`${BASE}/${mcode}`);
  // "Watch highlights" asked for a YouTube link (the owner, 10 November 2026). With the reel host on, the reel lives on
  // our own store, so the page no longer asks (a player, 24 November 2026). This match is still on (two hours booked),
  // so its share fold stays: after the end, the fold shows to a visitor only (checked on PAST above).
  check(
    "with the reel host on, a match that has started asks for no YouTube link",
    (await p.getByTestId("highlights-add").count()) === 0,
  );
  // The numbers of a filmed match (the owner, 22 November 2026): the reel engine sends them through the
  // operator's door, and the match page, My matches and "My stats" show them. A heart rate waits for the
  // player's own yes.
  const CRON = { authorization: `Bearer ${process.env.CRON_SECRET || "e2e-cron-secret"}`, "content-type": "application/json" };
  const sendStats = (stats) => fetch(`${BASE}/api/admin/match-stats`, { method: "POST", headers: CRON, body: JSON.stringify({ code: mcode, stats }) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));
  const numbers = [
    { player: "Ana", kind: "fastestShot", value: 84, margin: 0.1 },
    { player: "Ana", partner: "Bo", kind: "gamesInRow", value: 8 },
    { player: "Ana", kind: "heartRateMax", value: 157 },
    { player: "Cy", kind: "fastestShot", value: 73, margin: 0.2 },
  ];
  const sent = await sendStats(numbers);
  check(
    "the operator's door keeps the numbers of a match, the heart rate too, and refuses a number known to worse than 10%",
    sent.status === 200 && sent.body?.saved === 4 && JSON.stringify(sent.body?.refused) === JSON.stringify([{ index: 3, why: "bad_margin" }]),
    JSON.stringify(sent.body),
  );
  check("the door is the operator's: no token, no write", (await fetch(`${BASE}/api/admin/match-stats`, { method: "POST", body: "{}" })).status === 401);
  await p.goto(`${BASE}/${mcode}`);
  const card = p.getByTestId("match-numbers");
  await card.waitFor({ timeout: 20000 });
  const cardText = (await card.innerText()).replace(/\s+/g, " ");
  check("the match page shows its numbers: the shot with its unit and \"≈\", the pair's games once, the heart rate", /≈ 84 km\/h/.test(cardText) && /fastest shot/i.test(cardText) && /Ana & Bo|Bo & Ana/.test(cardText) && /157 bpm/.test(cardText) && (await card.locator("[data-stat]").count()) === 3, cardText);
  await shot(p, "v3-match-numbers");
  await p.goto(`${BASE}/me`);
  await p.getByTestId("my-numbers").waitFor({ timeout: 20000 });
  await p.getByTestId("my-stats-link").click();
  await p.waitForURL((u) => u.pathname === "/me/stats", { timeout: 20000 });
  check("My matches leads to My stats, with the bests and the match", (await p.getByTestId("my-bests").locator("[data-stat]").count()) === 3 && (await p.getByTestId("my-stats-matches").getByRole("link").getAttribute("href")) === `/${mcode}`);
  check("\"Keep my heart rate\" is on by default", await p.getByTestId("heart-rate-switch").isChecked());
  await shot(p, "v3-my-stats");
  // The club's records: every player is on them by default, like a score on a game's leaderboard.
  await p.goto(`${BASE}/v/rawai-padel-club/ranking`);
  const records = p.getByTestId("club-records");
  await records.waitFor({ timeout: 20000 });
  const recordsText = (await records.innerText()).replace(/\s+/g, " ");
  check("the club's page shows the records with their players, with no step to get on it", /84 km\/h/.test(recordsText) && /Ana/.test(recordsText) && /157 bpm/.test(recordsText), recordsText);
  await shot(p, "v3-club-records");
  await p.goto(`${BASE}/me/stats`);
  await p.getByTestId("heart-rate-switch").uncheck();
  await p.getByText(/Keep my heart rate · Off/).waitFor({ timeout: 20000 });
  await p.reload();
  const again = await sendStats(numbers.slice(2, 3));
  check("switching it off deletes the heart rate and keeps a new one out", (await p.getByTestId("my-bests").locator("[data-stat=heartRateMax]").count()) === 0 && (await p.getByTestId("my-bests").locator("[data-stat]").count()) === 2 && JSON.stringify(again.body?.refused) === JSON.stringify([{ index: 0, why: "heart_off" }]), JSON.stringify(again.body));
  // A match that was played with no match page (the owner, 23 November 2026): the operator's door writes it
  // as it was, and its page then shows the four players and the score.
  const playedBody = { startsAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(), tz: "Asia/Bangkok", venue: "Rawai Padel Club", teamA: ["Pia", "Quin"], teamB: ["Rex", "Sol"], sets: [[3, 6], [2, 6]] };
  const played = await fetch(`${BASE}/api/admin/played-match`, { method: "POST", headers: CRON, body: JSON.stringify(playedBody) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));
  const playedHtml = played.body?.code ? await (await fetch(`${BASE}/${played.body.code}`)).text() : "";
  check(
    "the operator's door writes a played match with its four players and its score, and the match page shows it",
    played.status === 200 && /^.{4}$/.test(played.body?.code ?? "") && played.body?.players?.length === 4 && ["Pia", "Quin", "Rex", "Sol"].every((n) => playedHtml.includes(n)) && playedHtml.includes("Confirmed by organizer"),
    JSON.stringify(played.body).slice(0, 200),
  );
  check("that door is the operator's too", (await fetch(`${BASE}/api/admin/played-match`, { method: "POST", body: "{}" })).status === 401);
  // The reel of a filmed match (the owner, 23 November 2026): the operator says where it is, and the players
  // of the match see it play on the match page with its two save buttons. A visitor does not see it.
  const reelToken = "e2e_reel_token_of_22_chars";
  const reelSet = await fetch(`${BASE}/api/admin/match-reel`, { method: "POST", headers: CRON, body: JSON.stringify({ code: mcode, host: "https://reels.example.test", token: reelToken }) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));
  await p.goto(`${BASE}/${mcode}`);
  await p.getByTestId("match-reel").waitFor({ timeout: 20000 });
  const reelBox = await p.getByTestId("reel-video").boundingBox();
  check(
    "a player of the match sees the reel on the match page, with a poster before it plays, and on a computer both files to download",
    reelSet.status === 200 &&
      !JSON.stringify(reelSet.body).includes(reelToken) &&
      (await p.getByTestId("reel-video").getAttribute("src")) === `https://reels.example.test/r/${reelToken}/tall.mp4` &&
      (await p.getByTestId("reel-video").getAttribute("poster")) === `https://reels.example.test/r/${reelToken}/poster.jpg` &&
      (await p.getByTestId("reel-save-tall").innerText()) === "Download the reel" &&
      (await p.getByTestId("reel-share-link").count()) === 0 &&
      (await p.getByTestId("reel-save-wide").count()) === 1 &&
      Boolean(reelBox) && reelBox.x >= 0 && reelBox.x + reelBox.width <= 390,
    JSON.stringify({ reelSet, reelBox }),
  );
  await shot(p, "v8-match-reel");
  // With a reel and no court photo, the card's background is the reel's team announcement, so the picker is the
  // small "Change the background" link under "Share the game results" (the owner, 26 November 2026).
  check("with a reel and a court photo, the card keeps Remove the photo and offers no Add the court photo", (await p.getByTestId("photo-remove").count()) === 1 && (await p.getByText("Add the court photo").count()) === 0);
  await p.getByTestId("photo-remove").click();
  await p.getByTestId("photo-add").waitFor({ timeout: 20000 });
  const bgDoor = await p.getByTestId("result-card").evaluate((el) => {
    const share = el.querySelector("[data-testid=result-share]").getBoundingClientRect();
    const door = el.querySelector("[data-testid=photo-add]");
    return { label: door.textContent, under: door.getBoundingClientRect().top >= share.bottom - 0.5, plain: door.classList.contains("btn-ghost") };
  });
  check("with a reel and no photo, Change the background is a text link under Share the game results", bgDoor.label === "Change the background" && bgDoor.under && bgDoor.plain && (await p.getByText("Add the court photo").count()) === 0, JSON.stringify(bgDoor));
  // On a computer (the owner, 25 November 2026: "on desktop, there is just a download, no share?"): the reel's
  // link to share first, then the two downloads. The same player, signed in, at a desktop's width.
  const deskCtx = await browser.newContext({ storageState: await p.context().storageState(), viewport: { width: 1280, height: 900 } });
  const desk = await deskCtx.newPage();
  await desk.goto(`${BASE}/${mcode}`);
  await desk.getByTestId("reel-share-link").waitFor({ timeout: 20000 });
  check(
    "on a computer the reel is shared by its link, first, and the two files download",
    (await desk.getByTestId("reel-share-link").innerText()).includes("Share the reel") && (await desk.getByTestId("reel-save-tall").innerText()) === "Download the reel" && (await desk.getByTestId("reel-save-wide").innerText()) === "Download the wide version",
  );
  await deskCtx.close();
  // Saving stays on the match page (the owner, 24 November 2026: a link opened the reel host's own page on an
  // iPhone, "clunky and buggy"). The button gets the file itself and hands it to the phone's share sheet; a
  // browser that cannot share a file, as here, saves it as a download named after the match.
  await p.route(`https://reels.example.test/r/${reelToken}/tall.mp4`, (route) => route.fulfill({ status: 200, headers: { "content-type": "video/mp4", "access-control-allow-origin": "*" }, body: Buffer.from("not really a film, but bytes to save") }));
  const urlBefore = p.url();
  const [saved] = await Promise.all([p.waitForEvent("download", { timeout: 20000 }), p.getByTestId("reel-save-tall").click()]);
  check(
    "Download the reel keeps the player on the match page and saves the file named after the match",
    saved.suggestedFilename() === `kicksmash-${mcode}-tall.mp4` && p.url() === urlBefore,
    JSON.stringify({ name: saved.suggestedFilename(), url: p.url() }),
  );
  await p.unroute(`https://reels.example.test/r/${reelToken}/tall.mp4`);
  const reelVisitor = await newPage();
  await reelVisitor.goto(`${BASE}/${mcode}`);
  await reelVisitor.getByRole("heading", { name: /players/ }).first().waitFor({ timeout: 20000 });
  check("a visitor does not see the reel, and the door is the operator's", (await reelVisitor.getByTestId("match-reel").count()) === 0 && !(await reelVisitor.content()).includes(reelToken) && (await fetch(`${BASE}/api/admin/match-reel`, { method: "POST", body: "{}" })).status === 401);
  // The reel's own page, for anybody with the link (CLAUDE.md order 10): a computer shares this link.
  await reelVisitor.goto(`${BASE}/${mcode}/reel`);
  await reelVisitor.getByTestId("reel-page-video").waitFor({ timeout: 20000 });
  const reelPageHtml = await reelVisitor.content();
  check(
    "anybody with the reel's link watches it, with its poster, and the link unfurls with the card and the video",
    (await reelVisitor.getByTestId("reel-page-video").getAttribute("poster")) === `https://reels.example.test/r/${reelToken}/poster.jpg` &&
      reelPageHtml.includes('property="og:video"') &&
      reelPageHtml.includes(`/${mcode}/card/opengraph-image`) &&
      reelPageHtml.includes('name="robots" content="noindex'),
  );
  // "Share to TikTok" (the owner, 26 November 2026): any player posts the reel to their own TikTok, by TikTok's Content
  // Sharing Guidelines. The server's TikTok is the fake in e2e/fakes/tiktok.mjs. The browser never opens TikTok's own
  // sign-in screen: Playwright does not intercept the target of a redirect, so a click went to the real tiktok.com
  // (26 November 2026). The start goes through the browser's own request context (its cookies, so the state cookie
  // lands in the browser), its redirect is read, and the browser opens our callback as TikTok would send it back.
  check("the reel page offers Share to TikTok, a link to the start, and the match page's reel offers it too", (await reelVisitor.getByTestId("tiktok-share").getAttribute("href")) === `/api/tiktok/start?code=${mcode}` && (await p.getByTestId("reel-tiktok").count()) === 1);
  await shot(reelVisitor, "tiktok-reel-page");
  const authorizeSeen = [];
  const signInTikTok = async (account, again = false) => {
    const started = await reelVisitor.request.get(`${BASE}/api/tiktok/start?code=${mcode}${again ? "&again=1" : ""}`, { maxRedirects: 0 });
    const at = new URL(started.headers()["location"] ?? `${BASE}/`);
    authorizeSeen.push({ origin: at.origin, path: at.pathname, ...Object.fromEntries(at.searchParams) });
    await reelVisitor.goto(`${BASE}/api/tiktok/callback?code=${account}&scopes=user.info.basic,video.publish,video.upload&state=${encodeURIComponent(at.searchParams.get("state") ?? "")}`);
  };
  const avatar = (letter) => `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88"><rect width="88" height="88" fill="#1c1c1e"/><text x="44" y="58" font-size="40" text-anchor="middle" fill="#c8f135" font-family="sans-serif">${letter}</text></svg>`;
  await reelVisitor.context().route("https://tiktok-avatar.example.test/**", (route) => route.fulfill({ status: 200, headers: { "content-type": "image/svg+xml" }, body: avatar(route.request().url().includes("private") ? "R" : "P") }));
  await reelVisitor.context().route(/^https:\/\/([a-z0-9-]+\.)*tiktok(apis)?\.com\//, (route) => route.abort());
  await signInTikTok("e2e-public");
  await reelVisitor.getByTestId("tiktok-account").waitFor({ timeout: 20000 });
  const privacyOptions = async () => reelVisitor.getByTestId("tiktok-privacy").locator("option").evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent, off: o.disabled })));
  const switches = async () => Promise.all(["tiktok-comment", "tiktok-duet", "tiktok-stitch", "tiktok-commercial-switch"].map(async (id) => ({ id, on: await reelVisitor.getByTestId(id).getAttribute("aria-checked"), off: await reelVisitor.getByTestId(id).isDisabled() })));
  const publicSwitches = await switches();
  check(
    "TikTok's sign-in asks for the three scopes with our callback, and the posting page shows the account, a preview, no privacy picked and every switch off",
    `${authorizeSeen[0]?.origin}${authorizeSeen[0]?.path}` === "https://www.tiktok.com/v2/auth/authorize/" &&
      authorizeSeen[0]?.scope === "user.info.basic,video.publish,video.upload" &&
      /^[0-9a-f]{64}$/.test(authorizeSeen[0]?.code_challenge ?? "") &&
      authorizeSeen[0]?.code_challenge_method === "S256" &&
      authorizeSeen[0]?.redirect_uri === `${BASE}/api/tiktok/callback` &&
      new URL(reelVisitor.url()).pathname === `/${mcode}/reel/tiktok` &&
      (await reelVisitor.getByTestId("tiktok-nickname").innerText()) === "Public Padel" &&
      (await reelVisitor.getByTestId("tiktok-preview").getAttribute("src")) === `https://reels.example.test/r/${reelToken}/tall.mp4` &&
      (await reelVisitor.getByTestId("tiktok-privacy").inputValue()) === "" &&
      JSON.stringify((await privacyOptions()).map((o) => o.t)) === JSON.stringify(["Choose", "Everyone", "Friends", "Followers", "Only me"]) &&
      publicSwitches.every((s) => s.on === "false" && !s.off) &&
      (await reelVisitor.getByTestId("tiktok-post").isDisabled()) &&
      (await reelVisitor.getByTestId("tiktok-legal").getByRole("link", { name: "Music Usage Confirmation" }).getAttribute("href")) === "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en",
    JSON.stringify({ authorizeSeen, url: reelVisitor.url(), publicSwitches }),
  );
  await shot(reelVisitor, "tiktok-post-public");
  // Commercial content: on, Post waits for a choice; branded content cannot be private, both ways.
  await reelVisitor.getByTestId("tiktok-privacy").selectOption("SELF_ONLY");
  await reelVisitor.getByTestId("tiktok-commercial-switch").click();
  const waitsForChoice = (await reelVisitor.getByTestId("tiktok-post").isDisabled()) && (await reelVisitor.getByTestId("tiktok-branded").isDisabled());
  await reelVisitor.getByTestId("tiktok-privacy").selectOption("FOLLOWER_OF_CREATOR");
  await reelVisitor.getByTestId("tiktok-branded").check();
  const brandedRules = (await privacyOptions()).find((o) => o.v === "SELF_ONLY")?.off === true && (await reelVisitor.getByTestId("tiktok-legal").getByRole("link", { name: "Branded Content Policy" }).count()) === 1 && (await reelVisitor.getByTestId("tiktok-commercial-label").innerText()).includes("Paid partnership");
  check("commercial content needs a choice before Post, and branded content is never private", waitsForChoice && brandedRules && !(await reelVisitor.getByTestId("tiktok-post").isDisabled()));
  await reelVisitor.getByTestId("tiktok-commercial-switch").click();
  await reelVisitor.getByTestId("tiktok-privacy").selectOption("SELF_ONLY");
  await reelVisitor.getByTestId("tiktok-post").click();
  await reelVisitor.locator('[data-testid="tiktok-status"][data-state="done"]').waitFor({ timeout: 30000 });
  check("Post goes to TikTok, says processing takes a few minutes, and shows the status until it is posted", (await reelVisitor.getByTestId("tiktok-status").innerText()).includes("Processing can take a few minutes") && (await reelVisitor.getByTestId("tiktok-status").innerText()).includes("Posted"));
  // A private account: "Use another account" signs in again, and the account's settings lock Duet and Stitch.
  await signInTikTok("e2e-private", true);
  await reelVisitor.getByTestId("tiktok-account").waitFor({ timeout: 20000 });
  const privateSwitches = await switches();
  check(
    "a private account gets only its own privacy options, and Duet and Stitch locked off",
    (await reelVisitor.getByTestId("tiktok-nickname").innerText()) === "Private Padel" &&
      JSON.stringify((await privacyOptions()).map((o) => o.t)) === JSON.stringify(["Choose", "Followers", "Only me"]) &&
      JSON.stringify(privateSwitches.map((s) => [s.on, s.off])) === JSON.stringify([["false", false], ["false", true], ["false", true], ["false", false]]),
    JSON.stringify(privateSwitches),
  );
  await shot(reelVisitor, "tiktok-post-private");
  await p.goto(`${BASE}/${mcode}`);
  const picked = bangkokDay(Date.now() + 3 * 24 * 3600 * 1000);
  await p.getByTestId("play-again-when").fill(`${picked}T19:30`);
  await p.getByTestId("play-again").getByRole("button", { name: /Play again/ }).click();
  // The owner's report of 9 November 2026: "when erik clicked play again, he had to add the players again".
  // The tap now holds a place for each player of the last game, and the organiser lands on the new
  // match, where the line-up shows them and one message names them: since 9 November 2026 that message is
  // the page's one share, and the line-up says in words whom it asks.
  await p.waitForURL((u) => /^\/[^/]{4}$/.test(u.pathname) && u.pathname !== `/${mcode}`, { timeout: 30000 });
  const nextCode = new URL(p.url()).pathname.slice(1);
  check("Play again makes the next game on the day and at the time picked", nextCode !== mcode && (await p.getByText(/19:30/).count()) > 0, nextCode);
  const playedHeld = p.getByTestId("held-message");
  await playedHeld.waitFor({ timeout: 20000 });
  const heldRows = await Promise.all(["Bo", "Cy", "Di"].map((n) => p.getByText(`Reserved for ${n}`, { exact: true }).count()));
  const heldLine = (await playedHeld.textContent()) ?? "";
  check(
    "Play again holds a place for each player of the last game: the line-up shows Bo, Cy and Di held, and one message names them",
    heldRows.every((c) => c === 1) && /asks Bo, Cy,? and Di to open the link and tap their name/.test(heldLine),
    JSON.stringify({ heldRows, heldLine }),
  );
  await shot(p, "v3c-play-again-held");
  // The round goes out after the answer: back on the last game, the help line no longer promises a message.
  let roundSaid = false;
  for (let i = 0; i < 10 && !roundSaid; i++) {
    await p.goto(`${BASE}/${mcode}`);
    roundSaid = (await p.getByTestId("play-again").getByText("already had their one", { exact: false }).count()) === 1;
    if (!roundSaid) await p.waitForTimeout(1000);
  }
  check("once the players heard, the last game's Play again says so instead of promising the message again", roundSaid);
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

  // ---- "Film this match. Get a reel." (the owner's screens 1 and 2 of the reel flow, 22 November 2026) ----
  // Before the start, the match's own players see the dark block and the four instructions; a visitor does not.
  const soon = await p.request.post(`${BASE}/api/v1/matches`, { headers: auth, data: { startsAt: new Date(Date.now() + 26 * 3600 * 1000).toISOString(), durationMinutes: 90, tz: "Asia/Bangkok", venue: "Rawai Padel Club", organizer: { name: "Fay" } } }).then((r) => r.json());
  const fcode = soon.match?.code;
  const f = await newPage();
  await f.goto(`${soon.organizer.personalUrl}?next=/${fcode}`);
  await f.waitForURL((u) => u.pathname === `/${fcode}`, { timeout: 20000 });
  await f.getByTestId("film-card").waitFor({ timeout: 20000 });
  check("a match that has not started offers its organiser the reel", (await f.getByTestId("film-card").getByRole("heading", { name: "Film this match. Get a reel." }).count()) === 1);
  await shot(f, "v9-film-card");
  const stranger = await newPage();
  await stranger.goto(`${BASE}/${fcode}`);
  await stranger.getByRole("heading", { name: /players/ }).first().waitFor({ timeout: 20000 });
  check("a visitor who is not in the match is not asked to film it", (await stranger.getByTestId("film-card").count()) === 0);
  await p.goto(`${BASE}/${mcode}`);
  check("a match that has started no longer asks to film it, nor for a YouTube link while the reel host is on", (await p.getByTestId("film-card").count()) === 0 && (await p.getByTestId("highlights-add").count()) === 0);
  await f.getByTestId("film-how").click();
  await f.waitForURL((u) => u.pathname === "/film" && u.searchParams.get("m") === fcode, { timeout: 20000 });
  await f.getByRole("heading", { name: "Four things, then play" }).waitFor({ timeout: 20000 });
  const filmFits = await f.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check(
    "How to film: four instructions, the court drawing, and nothing wider than the phone",
    (await f.getByTestId("film-steps").locator("li").count()) === 4 && (await f.locator("figure svg").count()) === 1 && (await f.getByText("Set the camera to 4K at 60").count()) === 1 && filmFits,
  );
  await shot(f, "v9-film-how");
  await f.getByTestId("film-got-it").click();
  await f.waitForURL((u) => u.pathname === `/${fcode}`, { timeout: 20000 });
  check("Got it leads back to the match", (await f.getByTestId("film-card").count()) === 1);
  await stranger.goto(`${BASE}/ru/film?m=n0pe`);
  check("the page stands alone, in Russian too, and a code that is not a code makes no link", (await stranger.getByRole("heading", { name: "Четыре шага — и играйте" }).count()) === 1 && (await stranger.getByTestId("film-back").count()) === 0 && (await stranger.getByTestId("film-got-it").count()) === 0);
  check("sitemap lists /film", sitemapText.includes("/film<"));

  // ---- A player sends the match video (the owner, 23 November 2026: an upload to the store, or a link) ----
  // The reel host is not here: the browser's requests to it are answered in this test, as the host answers them
  // (scripts/highlights/modal/serve.py). The first part is "already there", so the page must send the other two only.
  const PART = 32 * 1024 * 1024;
  const filmPath = path.join(os.tmpdir(), `e2e-film-${Date.now()}.mov`);
  fs.writeFileSync(filmPath, Buffer.alloc(2 * PART + 5 * 1024 * 1024, 7));
  const filmBytes = fs.statSync(filmPath).size;
  const overAt = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  const filmMatch = await p.request.post(`${BASE}/api/v1/matches`, { headers: auth, data: { startsAt: overAt, durationMinutes: 90, tz: "Asia/Bangkok", venue: "Rawai Padel Club", organizer: { name: "Uma" } } }).then((r) => r.json());
  const ucode = filmMatch.match?.code;
  const u = await newPage();
  const reelHost = { puts: [], finish: null, ticket: null, token: null };
  const corsOpen = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
  await u.route("https://reels.example.test/**", async (route) => {
    const req = route.request();
    const m = new URL(req.url()).pathname.match(/^\/u\/([^/]+)(?:\/(.+))?$/);
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsOpen });
    const bearer = (req.headers().authorization ?? "").replace(/^Bearer /, "");
    if (!m || !bearer) return route.fulfill({ status: 401, headers: corsOpen, json: { error: "unauthorized" } });
    reelHost.token = m[1];
    reelHost.ticket = bearer;
    if (req.method() === "GET") return route.fulfill({ headers: corsOpen, json: { parts: { 0: PART }, done: false } });
    if (req.method() === "PUT") {
      reelHost.puts.push(Number(m[2]));
      return route.fulfill({ headers: corsOpen, json: { ok: true } });
    }
    reelHost.finish = req.postDataJSON();
    return route.fulfill({ headers: corsOpen, json: { ok: true } });
  });
  await u.goto(`${filmMatch.organizer.personalUrl}?next=/${ucode}`);
  await u.waitForURL((x) => x.pathname === `/${ucode}`, { timeout: 20000 });
  await u.getByTestId("reel-send").waitFor({ timeout: 20000 });
  check("after a match, its player is asked for the film: the video or a link", (await u.getByTestId("reel-choose").innerText()) === "Choose the video" && (await u.getByTestId("reel-link").count()) === 1 && (await u.getByTestId("film-card").count()) === 0);
  await shot(u, "v10-reel-send");
  await u.getByTestId("reel-file").setInputFiles(filmPath);
  await u.getByTestId("reel-here").waitFor({ timeout: 60000 });
  check(
    "the page sends the film in parts with its ticket, skips the part that is there, and says how many parts and bytes it sent",
    reelHost.puts.slice().sort().join(",") === "1,2" && reelHost.finish?.parts === 3 && reelHost.finish?.bytes === filmBytes && reelHost.finish?.name === path.basename(filmPath) && /^[A-Za-z0-9]{32}$/.test(reelHost.token ?? "") && (reelHost.ticket ?? "").split(".").length === 2,
    JSON.stringify({ puts: reelHost.puts, finish: reelHost.finish, token: (reelHost.token ?? "").length }),
  );
  // Until the reel reelHost says "joined", another player's page still offers to go on with the upload.
  await u.reload();
  check("an upload that is not joined yet can go on from any player's page", (await u.getByTestId("reel-choose").innerText()) === "Choose the same video to go on");
  const hostSays = (ticket) => fetch(`${BASE}/api/reel/upload`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));
  const refusedTicket = await hostSays(`${reelHost.ticket.slice(0, -3)}AAA`);
  const firstWord = await hostSays(reelHost.ticket);
  const secondWord = await hostSays(reelHost.ticket);
  await u.reload();
  check(
    "the reel host's word, with the ticket, says the film is here: once, and never with a ticket that was changed",
    refusedTicket.status === 401 && firstWord.status === 200 && firstWord.body?.changed === true && secondWord.body?.changed === false && (await u.getByTestId("reel-here").count()) === 1 && (await u.getByTestId("reel-send").count()) === 0,
    JSON.stringify({ refusedTicket, firstWord, secondWord }),
  );
  fs.rmSync(filmPath, { force: true });
  // The link: a share text from a drive is kept; anything else is refused in words.
  const linkMatch = await p.request.post(`${BASE}/api/v1/matches`, { headers: auth, data: { startsAt: overAt, durationMinutes: 90, tz: "Asia/Bangkok", venue: "Rawai Padel Club", organizer: { name: "Vic" } } }).then((r) => r.json());
  const v = await newPage();
  await v.goto(`${linkMatch.organizer.personalUrl}?next=/${linkMatch.match.code}`);
  await v.waitForURL((x) => x.pathname === `/${linkMatch.match.code}`, { timeout: 20000 });
  await v.getByTestId("reel-link").locator("summary").click();
  await v.getByTestId("reel-link-input").fill("https://example.com/film.mov");
  await v.getByTestId("reel-link-save").click();
  await v.getByText("That is not a shared link from iCloud, Google Drive, Dropbox or OneDrive.").waitFor({ timeout: 20000 });
  await v.getByTestId("reel-link-input").fill("Our match https://www.icloud.com/iclouddrive/0a1B2c3D4e#IMG_0042");
  await v.getByTestId("reel-link-save").click();
  await v.getByTestId("reel-here").waitFor({ timeout: 20000 });
  check("a link to the film on a drive is kept, and the page says the video is here", (await v.getByTestId("reel-send").count()) === 0);
  // ---- The two ways (the owner, 23 November 2026): the full reel first, and the fast reel with what it lacks ----
  // The fast reel is the phone's own work: it reads the film's sound, finds the rallies and cuts them out of the
  // file. The film here is a synthetic one with three rallies in its sound (e2e/fixtures/README.md).
  const fastMatch = await p.request.post(`${BASE}/api/v1/matches`, { headers: auth, data: { startsAt: overAt, durationMinutes: 90, tz: "Asia/Bangkok", venue: "Rawai Padel Club", organizer: { name: "Wim" } } }).then((r) => r.json());
  const wcode = fastMatch.match?.code;
  const w = await newPage();
  const fastHost = { puts: [], finish: null, ticket: null, body: null, hold: null };
  await w.route("https://reels.example.test/**", async (route) => {
    const req = route.request();
    const m = new URL(req.url()).pathname.match(/^\/u\/([^/]+)(?:\/(.+))?$/);
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsOpen });
    fastHost.ticket = (req.headers().authorization ?? "").replace(/^Bearer /, "");
    if (!m || !fastHost.ticket) return route.fulfill({ status: 401, headers: corsOpen, json: { error: "unauthorized" } });
    if (req.method() === "GET") return route.fulfill({ headers: corsOpen, json: { parts: {}, done: false } });
    if (req.method() === "PUT") {
      fastHost.puts.push(Number(m[2]));
      fastHost.body = req.postDataBuffer();
      if (fastHost.hold) await fastHost.hold;
      return route.fulfill({ headers: corsOpen, json: { ok: true } });
    }
    fastHost.finish = req.postDataJSON();
    return route.fulfill({ headers: corsOpen, json: { ok: true } });
  });
  await w.goto(`${fastMatch.organizer.personalUrl}?next=/${wcode}`);
  await w.waitForURL((x) => x.pathname === `/${wcode}`, { timeout: 20000 });
  await w.getByTestId("reel-send").waitFor({ timeout: 20000 });
  const fullWay = w.getByTestId("reel-way-full");
  const fastWay = w.getByTestId("reel-way-fast");
  const waysFit = await w.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check(
    "the player chooses between two ways: the full reel is first and marked, and the fast reel says with three crosses what it lacks",
    (await fullWay.getByText("Best", { exact: true }).count()) === 1 &&
      (await fullWay.getByText("✓").count()) === 4 &&
      (await fullWay.getByText("✕").count()) === 0 &&
      (await fastWay.getByText("✓").count()) === 2 &&
      (await fastWay.getByText("✕").count()) === 3 &&
      (await fastWay.getByText("No score in the corner").count()) === 1 &&
      (await w.getByTestId("reel-way-full").evaluate((el) => el.compareDocumentPosition(document.querySelector('[data-testid="reel-way-fast"]')) & Node.DOCUMENT_POSITION_FOLLOWING)) > 0 &&
      (await w.getByTestId("reel-iphone-hint").count()) === 0 &&
      waysFit,
  );
  await shot(w, "v11-reel-two-ways");
  // A file that is no film: the page says so and still offers both ways.
  await w.getByTestId("reel-fast-file").setInputFiles({ name: "notes.mov", mimeType: "video/quicktime", buffer: Buffer.from("this is not a film at all, only some words in a file") });
  await w.getByTestId("reel-error").waitFor({ timeout: 30000 });
  check("a file the phone cannot read is said in words, and nothing goes up", (await w.getByTestId("reel-error").innerText()) === "Your phone cannot read this video. Use the full reel." && fastHost.puts.length === 0 && (await fastWay.count()) === 1);
  const fixture = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "film-aac.mp4");
  const fixtureBytes = fs.statSync(fixture).size;
  // The upload is held on its way, so the player makes the reel theirs while it goes (the agreed screens 4 and 6).
  let release = () => {};
  fastHost.hold = new Promise((r) => (release = r));
  await w.getByTestId("reel-fast-file").setInputFiles(fixture);
  await w.getByTestId("reel-choices").waitFor({ timeout: 60000 });
  const musicRows = await w.getByTestId("reel-music").getByRole("radio").count();
  await w.getByTestId("reel-music-dnb").click();
  await w.getByTestId("reel-teams-change").click();
  await w.getByTestId("reel-team-0").fill("Smash Bros");
  await w.getByTestId("reel-crowd").click();
  const choicesFit = await w.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await shot(w, "v11b-reel-choices");
  release();
  await w.getByTestId("reel-here").waitFor({ timeout: 90000 });
  check(
    "while the clips go up, the player names the teams, switches the crowd off and picks the music, and the choices go with the clips",
    musicRows === 5 && choicesFit && fastHost.finish?.choices?.music === "dnb" && fastHost.finish?.choices?.teams?.[0] === "Smash Bros" && fastHost.finish?.choices?.crowd === false && fastHost.finish?.choices?.numbers === true,
    JSON.stringify(fastHost.finish?.choices ?? null),
  );
  const times = fastHost.finish?.times;
  check(
    "the clips go up with where each one sits in the film and when the film began, for a watch's heart rate",
    Array.isArray(times?.clips) && times.clips.length >= 1 && times.clips.every(([a, b]) => a >= 0 && b > a) && typeof times.recordedAt === "string" && ["film", "file"].includes(times.recordedFrom),
    JSON.stringify(times ?? null),
  );
  const cutIsFilm = fastHost.body ? fastHost.body.subarray(4, 8).toString("latin1") === "ftyp" && fastHost.body.length === fastHost.finish?.bytes : true;
  check(
    "Make a fast reel: the phone finds the rallies by sound, cuts them out of the film, and sends only the cut",
    fastHost.puts.join(",") === "0" && fastHost.finish?.parts === 1 && fastHost.finish?.name === "film-aac-clips.mp4" && fastHost.finish?.bytes > 20000 && fastHost.finish?.bytes < fixtureBytes * 0.8 && cutIsFilm && (await w.getByTestId("reel-here").innerText()).includes("The clips are here"),
    JSON.stringify({ puts: fastHost.puts, finish: fastHost.finish, fixtureBytes, body: fastHost.body ? fastHost.body.length : null }),
  );
  const clipsWord = await hostSays(fastHost.ticket);
  await w.reload();
  check("the reel host's word marks the clips as here, and the page says plainly who makes the fast reel and that it can take hours", clipsWord.body?.changed === true && (await w.getByTestId("reel-here").innerText()).includes("a person makes the fast reel from them"));
  // A match with no two pairs of two gets no start for the automatic job: a person makes its reel.
  check("clips of a match with no two pairs start no automatic job", clipsWord.body?.fastReel === undefined, JSON.stringify(clipsWord.body));
  // "Who is who?" (the agreed screen 5): the job is not sure of one face and waits. The page shows the faces from the
  // reel host, a known name quiet, the new face with a dashed button for each player, and sends the answer there.
  const upload = "e2e_upload_token_of_22chars";
  const asked = { v: 1, state: "names", upload, players: [{ id: "p-ana", name: "Ana" }, { id: "p-bo", name: "Bo" }], tracks: [{ track: 0, face: "face-0.jpg", guess: "p-ana", confidence: 0.9, ask: false }, { track: 1, face: "face-1.jpg", guess: null, confidence: 0.2, ask: true }] };
  const answered = { body: null, ticket: null };
  const dot = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  await w.route(`https://reels.example.test/r/${upload}/**`, (route) => (route.request().url().endsWith("names.json") ? route.fulfill({ headers: corsOpen, json: asked }) : route.fulfill({ headers: corsOpen, contentType: "image/png", body: dot })));
  await w.route(`https://reels.example.test/u/${upload}/names`, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsOpen });
    answered.body = route.request().postDataJSON();
    answered.ticket = (route.request().headers().authorization ?? "").replace(/^Bearer /, "");
    return route.fulfill({ headers: corsOpen, json: { ok: true } });
  });
  const waits = await fetch(`${BASE}/api/admin/match-reel`, { method: "POST", headers: CRON, body: JSON.stringify({ code: wcode, progress: { pct: 30, minutesLeft: 0, step: "players", waiting: "names", host: "https://reels.example.test", upload } }) });
  await w.reload();
  await w.getByTestId("reel-names").getByRole("img").first().waitFor({ timeout: 20000 });
  const go = w.getByTestId("reel-names-go");
  const before = { label: await go.innerText(), off: await go.isDisabled(), known: await w.getByTestId("reel-face-0-name").innerText() };
  await w.getByTestId("reel-face-1-pick-Bo").click();
  const namesFit = await w.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await shot(w, "v11c-reel-names");
  await go.click();
  await w.getByTestId("reel-names-sent").waitFor({ timeout: 20000 });
  check(
    "who is who: the known face is named, the new face is named with one tap, and the answer goes to the reel host with a ticket",
    waits.status === 200 && before.label === "Name 1 more player" && before.off && before.known === "Ana" && namesFit && JSON.stringify(answered.body) === JSON.stringify({ names: { 0: "p-ana", 1: "p-bo" } }) && (answered.ticket ?? "").split(".").length === 2,
    JSON.stringify({ status: waits.status, before, answered: answered.body }),
  );
  // An iPhone converts a film from the photo library before the page gets it: the card says how to avoid that.
  const iosMatch = await p.request.post(`${BASE}/api/v1/matches`, { headers: auth, data: { startsAt: overAt, durationMinutes: 90, tz: "Asia/Bangkok", venue: "Rawai Padel Club", organizer: { name: "Xan" } } }).then((r) => r.json());
  const iosCtx = await browser.newContext({ ...iphone, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
  const ios = await iosCtx.newPage();
  await ios.goto(`${iosMatch.organizer.personalUrl}?next=/${iosMatch.match.code}`);
  await ios.waitForURL((x) => x.pathname === `/${iosMatch.match.code}`, { timeout: 20000 });
  await ios.getByTestId("reel-iphone-hint").waitFor({ timeout: 20000 });
  check("on an iPhone the card says to choose the film from Files", (await ios.getByTestId("reel-iphone-hint").innerText()).includes("Save to Files"));
  // A new page: the other visitor's page was left in Russian by the check of /ru/film.
  const passerby = await newPage();
  await passerby.goto(`${BASE}/${ucode}`);
  // The match is over, so a visitor's page has no line-up to wait for (the owner, 26 November 2026): its title is the paint.
  await passerby.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 20000 });
  check("a visitor is not asked for the film and does not see that one is here", (await passerby.getByTestId("reel-send").count()) === 0 && (await passerby.getByTestId("reel-here").count()) === 0);
} catch (e) {
  await crashed(browser, results, e);
} finally {
  await browser.close();
}
finish(results);
