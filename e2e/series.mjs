// A series, an Open that repeats (see e2e/run.mjs): a finished tournament becomes a series from its page,
// the series page carries the next edition and the podium, a player signs up through it, the hourly job
// makes nothing twice, the organizer pauses and resumes, the city page and the API list it.
import { BASE, crashed, finish, launch, makeCheck, shot } from "./lib.mjs";
process.on("unhandledRejection", () => {});
const browser = await launch();
const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-US", timezoneId: "Asia/Bangkok", reducedMotion: "reduce" };
const results = [];
const check = makeCheck(results);
const newPage = async () => {
  const ctx = await browser.newContext(iphone);
  const p = await ctx.newPage();
  p.on("dialog", (d) => d.accept());
  p.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  return p;
};
const cron = async () => {
  const r = await fetch(`${BASE}/api/cron/hourly`, { headers: { Authorization: "Bearer e2e-cron-secret" } });
  return r.json();
};
try {
  // 1. A tournament that started an hour ago at Rawai Padel, four names, one scored round, finalized.
  const a = await newPage();
  await a.goto(BASE + "/");
  await a.getByPlaceholder("e.g. Alex").fill("Org");
  await a.getByRole("button", { name: /Tournament/ }).click();
  const past = new Date(Date.now() - 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(past);
  const g = (t) => parts.find((p) => p.type === t).value;
  await a.locator("input[type=date]").fill(`${g("year")}-${g("month")}-${g("day")}`);
  await a.locator("input[type=time]").fill(`${g("hour")}:${g("minute")}`);
  await a.getByPlaceholder("Court TBD · or type a club").fill("Rawai Padel");
  await a.getByLabel("Players").selectOption("8");
  await a.getByRole("button", { name: "Create & get the link" }).click();
  await a.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code = a.url().split("/").slice(-2)[0];
  check("tournament created at Rawai Padel", true, code);

  const others = [];
  for (const n of ["Bea", "Cal"]) {
    const p = await newPage();
    await p.goto(`${BASE}/${code}`);
    await p.getByRole("button", { name: "Join" }).first().click();
    await p.getByPlaceholder("e.g. Alex").fill(n);
    await p.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
    await p.getByText(/Happening right now|You're in/).first().waitFor({ timeout: 30000 });
    others.push(p);
  }
  await a.goto(`${BASE}/${code}`);
  check("no series door before the tournament is finalized", (await a.getByTestId("series-door").count()) === 0);
  await a.getByRole("button", { name: /Open spot/ }).first().click();
  await a.getByPlaceholder("Name").fill("Zed");
  await a.getByRole("button", { name: "Done", exact: true }).click();
  await a.getByText("Reserved for Zed").first().waitFor({ timeout: 20000 });
  await a.getByRole("button", { name: "Generate round 1" }).click();
  await a.getByText("Round 1", { exact: true }).waitFor({ timeout: 20000 });
  await a.locator('input[aria-label="A"]').first().fill("16");
  await a.locator('input[aria-label="B"]').first().fill("8");
  await a.locator('input[aria-label="B"]').first().blur();
  await a.getByText("Saved").waitFor({ timeout: 20000 });
  await a.getByRole("button", { name: /Finalize scores/ }).click();
  await a.getByText("Scores finalized").waitFor({ timeout: 20000 });
  check("organizer finalized", true);

  // 2. The door: prefilled name, a rhythm, one button; the series page opens with the next edition on it.
  await a.reload();
  await a.getByTestId("series-door").waitFor({ timeout: 20000 });
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "Asia/Bangkok" }).format(past);
  const nameInput = a.getByTestId("series-door").locator("input");
  check("door prefilled with venue, weekday and Open", (await nameInput.inputValue()) === `Rawai Padel ${weekday} Open`, await nameInput.inputValue());
  check("door proposes the field the tournament shrank to (4), in fours", (await a.getByLabel("Players per edition").inputValue()) === "4");
  check("a participant sees no door", (await others[0].reload(), (await others[0].getByTestId("series-door").count()) === 0));
  await nameInput.fill("Rawai Saturday Open");
  await a.getByLabel("Players per edition").selectOption("8");
  await a.getByLabel("How often").selectOption("week");
  await shot(a, "s1-door");
  await a.getByRole("button", { name: "Make it a series" }).click();
  await a.waitForURL(/\/s\/rawai-saturday-open$/, { timeout: 30000 });
  const slug = "rawai-saturday-open";
  check("series page opened at /s/rawai-saturday-open", true);
  await a.getByRole("heading", { name: "Rawai Saturday Open" }).waitFor({ timeout: 20000 });
  check("rhythm line names the weekday and the venue", (await a.getByText(new RegExp(`Every ${weekday} at \\d\\d:\\d\\d · at Rawai Padel`)).count()) > 0);
  check("organised by Org", (await a.getByText("Organised by Org").count()) > 0);
  const nextCard = a.getByTestId("series-next");
  const nextWeek = new Date(past.getTime() + 7 * 24 * 60 * 60 * 1000);
  const nextDay = new Intl.DateTimeFormat("en-US", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Bangkok" }).format(nextWeek);
  check("next edition is one week later", (await nextCard.getByText(new RegExp(nextDay.split(",")[0])).count()) > 0, `${nextDay} | ${await nextCard.innerText()}`);
  check("next edition has 8 spots and a Sign up button", (await nextCard.getByText("8 spots left").count()) > 0 && (await nextCard.getByRole("link", { name: "Sign up" }).count()) > 0);
  check("past edition lists the podium with medals", (await a.getByText(/🥇 Org|🥇 Bea|🥇 Cal|🥇 Zed/).count()) > 0 && (await a.getByText(/🥉/).count()) > 0);
  check("2 editions chip", (await a.getByText("2 editions").count()) > 0);
  check("share line carries /s/ link", (await a.getByText(`/s/${slug}`).count()) > 0);
  const html = await a.content();
  check("EventSeries JSON-LD with a SportsEvent subEvent", html.includes('"@type":"EventSeries"') && html.includes('"@type":"SportsEvent"') && html.includes("Rawai Padel"));
  check("organizer sees Pause", (await a.getByRole("button", { name: /Pause the series/ }).count()) > 0);
  await shot(a, "s2-series");

  // The source tournament names its series and the next edition.
  await a.goto(`${BASE}/${code}`);
  check("source tournament carries the series line", (await a.getByTestId("series-line").getByText("Part of Rawai Saturday Open").count()) > 0 && (await a.getByTestId("series-line").getByText(/Next edition:/).count()) > 0);
  check("door gone once it is a series", (await a.getByTestId("series-door").count()) === 0);

  // 3. A player signs up through the series page: the door tags the join.
  const bea = others[0];
  await bea.goto(`${BASE}/s/${slug}`);
  check("participant sees no Pause", (await bea.getByRole("button", { name: /Pause the series/ }).count()) === 0);
  await bea.getByTestId("series-next").getByRole("link", { name: "Sign up" }).click();
  await bea.waitForURL(/\/[^/]{4}\?s=series$/, { timeout: 20000 });
  const code2 = new URL(bea.url()).pathname.slice(1);
  check("sign up lands on the next edition with the series tag", code2 !== code, bea.url());
  check("edition is public and titled after the series", (await bea.getByRole("heading", { name: /Rawai Saturday Open/ }).count()) > 0);
  await bea.getByRole("button", { name: "Join" }).first().click();
  await bea.getByText(/You're in/).first().waitFor({ timeout: 30000 });
  await bea.goto(`${BASE}/s/${slug}`);
  check("series page shows 7 spots left after Bea joined", (await bea.getByTestId("series-next").getByText("7 spots left").count()) > 0);

  // 4. The hourly job makes nothing twice; the API and the city page list the series.
  const c1 = await cron();
  check("cron: no second edition while the next one exists", c1.ok === true && c1.seriesEditions === 0, JSON.stringify({ seriesEditions: c1.seriesEditions, errors: c1.errors }));
  await bea.goto(`${BASE}/s/${slug}`);
  check("still one next edition after the cron", (await bea.getByTestId("series-next").getByRole("link", { name: "Sign up" }).count()) === 1);
  const list = await (await fetch(`${BASE}/api/v1/series?city=phuket`)).json();
  const mine = (list.series ?? []).find((s) => s.slug === slug);
  check("API lists the series in Phuket with its next edition", Boolean(mine) && mine.next?.code === code2 && mine.rhythm?.every === "week" && mine.venue?.name === "Rawai Padel", JSON.stringify(mine));
  const one = await (await fetch(`${BASE}/api/v1/series/${slug}`)).json();
  check("API series page carries the podium and the spots", one.editions === 2 && one.past?.[0]?.podium?.length === 3 && one.next?.spotsLeft === 7, JSON.stringify({ editions: one.editions, podium: one.past?.[0]?.podium, next: one.next }));
  check("API never shows a payment note", !JSON.stringify(one).includes("payNote"));
  const notFound = await fetch(`${BASE}/api/v1/series/nope-nope`);
  check("unknown series is a 404 with a hint", notFound.status === 404);
  await bea.goto(`${BASE}/phuket`);
  check("city page lists Opens in Phuket", (await bea.getByTestId("city-opens").getByText("Rawai Saturday Open").count()) > 0);
  const sm = await (await fetch(`${BASE}/sitemap.xml`)).text();
  check("sitemap carries the series page in three languages", sm.includes(`/s/${slug}</loc>`) && sm.includes(`/ru/s/${slug}</loc>`) && sm.includes(`/es/s/${slug}</loc>`));
  const ru = await newPage();
  await ru.goto(`${BASE}/ru/s/${slug}`);
  check("RU series page renders the rhythm", (await ru.getByText(/Каждый .* в \d\d:\d\d/).count()) > 0 && (await ru.getByRole("link", { name: "Записаться" }).count()) > 0);

  // 5. Pause and resume.
  await a.goto(`${BASE}/s/${slug}`);
  await a.getByRole("button", { name: /Pause the series/ }).click();
  await a.getByRole("button", { name: /Resume the series/ }).waitFor({ timeout: 20000 });
  check("paused: the page says so and offers Resume", (await a.getByText(/^Paused\./).count()) > 0);
  const c2 = await cron();
  check("cron while paused makes nothing", c2.seriesEditions === 0);
  const paused = await (await fetch(`${BASE}/api/v1/series?city=phuket`)).json();
  check("paused series leaves the city list", !(paused.series ?? []).some((s) => s.slug === slug));
  await a.getByRole("button", { name: /Resume the series/ }).click();
  await a.getByRole("button", { name: /Pause the series/ }).waitFor({ timeout: 20000 });
  check("resumed", true);
  await shot(a, "s3-resumed");
} catch (e) {
  await crashed(browser, results, e);
} finally {
  await browser.close();
}
finish(results);
