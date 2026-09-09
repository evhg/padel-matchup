// The coach's book: Olga sets up in four taps, Ivan asks to join through her page, Olga accepts and
// starts a package, Ivan books and cancels a lesson himself, Olga books one for him from her book.
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
/** Clicks day chips left to right until a time chip shows up, then clicks the first time. */
async function pickFirstFreeTime(_page, scope) {
  const dayChips = scope.locator('button[data-kind="day"]');
  const n = await dayChips.count();
  for (let i = 0; i < Math.min(n, 15); i++) {
    await dayChips.nth(i).click();
    const times = scope.locator('button[data-kind="time"]');
    if ((await times.count()) > 0) {
      const label = await times.first().textContent();
      await times.first().click();
      return label?.trim() ?? "";
    }
  }
  return "";
}

try {
  // Olga: name first, then four taps.
  const olga = await newPage();
  await olga.goto(BASE + "/coach");
  await olga.getByPlaceholder("e.g. Alex").fill("Olga");
  await olga.locator("form button[type=submit]").click();
  await olga.getByText("Your lessons book").first().waitFor({ timeout: 20000 });
  check("setup asks where, how long and when on one screen", (await olga.locator("#coach-clubs").count()) === 1 && (await olga.getByRole("radio", { name: "Both" }).count()) === 1);
  await olga.locator("#coach-clubs").fill("Warehaus");
  await olga.getByRole("button", { name: "Create my book" }).click();
  await olga.waitForURL(/\/coach\?welcome=1$/, { timeout: 30000 });
  await olga.getByText("Your book is ready").waitFor({ timeout: 20000 });
  const body = await olga.locator("main").innerText();
  const handle = body.match(/\/c\/([a-z0-9-]+)/)?.[1];
  check("the welcome card shows the coach's link and a QR", Boolean(handle) && (await olga.locator("main svg").count()) > 0, handle);
  await shot(olga, "60-coach-welcome");

  // Settings: PromptPay and a cutoff, saved once.
  await olga.goto(BASE + "/coach/settings");
  await olga.getByPlaceholder("08x xxx xxxx").fill("0899999999");
  await olga.getByRole("button", { name: "Save" }).click();
  await olga.getByText("Saved.").waitFor({ timeout: 20000 });
  check("settings save with a PromptPay number", true);
  const calendarCard = olga.getByTestId("coach-calendar");
  check("settings carry the calendar attachment with its two steps", (await calendarCard.count()) === 1 && (await calendarCard.getByText(/Share your Google Calendar/).count()) === 1 && (await calendarCard.locator("#gcal-id").count()) === 1);
  await calendarCard.locator("#gcal-id").fill("not an address");
  await calendarCard.getByRole("button", { name: "Attach and check" }).click();
  await calendarCard.getByText("That does not look like a calendar address.").waitFor({ timeout: 20000 });
  check("a bad calendar address is refused in place", true);

  // Ivan finds Olga's page, asks to join.
  const ivan = await newPage();
  await ivan.goto(`${BASE}/c/${handle}`);
  check("the public page names the coach and the club", (await ivan.getByRole("heading", { name: "Olga" }).count()) === 1 && (await ivan.getByText(/at Warehaus/).count()) === 1);
  check("the public page carries structured data and language alternates", (await ivan.locator('script[type="application/ld+json"]').count()) === 1 && (await ivan.locator('link[rel="alternate"][hreflang="ru"]').count()) === 1);
  await ivan.getByPlaceholder("e.g. Alex").fill("Ivan");
  await ivan.getByRole("button", { name: "Ask to become a student" }).click();
  await ivan.getByText(/Asked\. Olga will confirm/).waitFor({ timeout: 20000 });
  check("a newcomer asks to join with just a name", true);

  // Olga accepts and starts a package of ten.
  await olga.goto(BASE + "/coach/students");
  await olga.getByText("Waiting for your yes").waitFor({ timeout: 20000 });
  await olga.getByRole("button", { name: "Accept" }).click();
  await olga.getByRole("button", { name: /New package/ }).waitFor({ timeout: 20000 });
  await olga.getByRole("button", { name: /New package/ }).click();
  await olga.locator('input[type="number"]').nth(2).fill("6000");
  await olga.getByRole("button", { name: "Create package" }).click();
  await olga.getByText(/10 of 10 left · 90 days/).waitFor({ timeout: 20000 });
  check("a package shows lessons left and days left, not paid yet", (await olga.getByText(/Not paid yet/).count()) === 1);
  await olga.getByRole("button", { name: "Show payment QR" }).click();
  await olga.getByText(/Scan to pay Olga · 6000 THB/).waitFor({ timeout: 10000 });
  check("the PromptPay QR renders with the amount", (await olga.locator("main svg").count()) > 0);
  await olga.getByRole("button", { name: "Mark paid" }).click();
  await olga.getByText(/· Paid/).waitFor({ timeout: 20000 });
  await shot(olga, "61-coach-students");

  // Olga brings her sheet: paste, look, confirm. Pavel arrives with six of ten left.
  await olga.getByRole("button", { name: "Import" }).click();
  await olga.getByTestId("import-text").fill("Name\tLessons\tUsed\tExpires\tPaid\nPavel\t10\t4\t2027-01-31\tyes\nnonsense line\n");
  await olga.getByRole("button", { name: "Read it" }).click();
  await olga.getByTestId("import-preview").waitFor({ timeout: 20000 });
  check("the sheet preview shows the row and the skipped line before anything is written", (await olga.getByText(/1 row read, 1 line skipped/).count()) === 1 && (await olga.getByTestId("import-preview").getByText("6/10").count()) === 1);
  await olga.getByTestId("import-confirm").click();
  await olga.getByText(/1 package added: 1 new student/).waitFor({ timeout: 20000 });
  await olga.getByText("Pavel").first().waitFor({ timeout: 20000 });
  check("the imported student appears with lessons left and the expiry", (await olga.getByText(/6 of 10 left/).count()) === 1);

  // Ivan books a free time himself, then cancels in time: the lesson goes back on the package.
  await ivan.reload();
  await ivan.getByRole("heading", { name: "Book a lesson" }).waitFor({ timeout: 20000 });
  const picked = await pickFirstFreeTime(ivan, ivan.locator("main"));
  check("an accepted student sees free times", picked !== "", picked);
  await ivan.getByRole("button", { name: /^Book / }).click();
  await ivan.getByText(/^Booked:/).waitFor({ timeout: 20000 });
  await ivan.getByText(/9 of 10 left/).waitFor({ timeout: 20000 });
  check("booking draws one lesson from the package", true);
  await shot(ivan, "62-student-booked");
  // Depending on the hour this runs, the first free slot may be inside the cutoff: then the free pass covers it. Either way the lesson goes back.
  await ivan.locator("main").getByRole("button", { name: "Cancel" }).first().click();
  await ivan.getByText(/^Cancelled/).waitFor({ timeout: 20000 });
  const cancelNote = await ivan.getByText(/^Cancelled/).textContent();
  await ivan.getByText(/10 of 10 left/).waitFor({ timeout: 20000 });
  check("a cancellation before the cutoff, or covered by the free pass, refunds the lesson", /back on your package|free pass covered/.test(cancelNote ?? ""), cancelNote?.trim());

  // Olga books Ivan from her book in two taps.
  await olga.goto(BASE + "/coach");
  await olga.getByRole("button", { name: "Book a lesson" }).click();
  await olga.locator("#book-student").waitFor({ timeout: 10000 });
  check("the book form offers Ivan", (await olga.locator("#book-student option", { hasText: "Ivan" }).count()) === 1);
  const when = await pickFirstFreeTime(olga, olga.locator("form"));
  await olga.locator("form").getByRole("button", { name: "Book", exact: true }).click();
  await olga.getByText(/^Booked Ivan/).waitFor({ timeout: 20000 });
  check("the coach books a student from the book", when !== "", when);
  await shot(olga, "63-coach-home");

  // Ivan sees it on My matches with the package line.
  await ivan.goto(BASE + "/me");
  await ivan.getByText("Your lessons").waitFor({ timeout: 20000 });
  check("My matches shows the lesson and the package with Olga", (await ivan.getByText("with Olga").count()) === 1 && (await ivan.getByText(/9 of 10 left/).count()) === 1);

  // The chain: Olga books Pavel tomorrow; Ivan waits for that exact time; Olga cancels; Ivan is offered it and takes it.
  await olga.goto(BASE + "/coach");
  await olga.getByRole("button", { name: "Book a lesson" }).click();
  await olga.locator("#book-student").waitFor({ timeout: 10000 });
  await olga.locator("#book-student").selectOption({ label: "Pavel" });
  const olgaForm = olga.locator("form");
  const tomorrowChip = olgaForm.locator('button[data-kind="day"]').nth(1);
  const dayText = (await tomorrowChip.textContent())?.trim() ?? "";
  await tomorrowChip.click();
  const lastTime = olgaForm.locator('button[data-kind="time"]').last();
  const timeText = (await lastTime.textContent())?.trim() ?? "";
  await lastTime.click();
  await olgaForm.getByRole("button", { name: "Book", exact: true }).click();
  await olga.getByText(/^Booked Pavel/).waitFor({ timeout: 20000 });

  await ivan.goto(`${BASE}/c/${handle}`);
  await ivan.getByRole("heading", { name: "Book a lesson" }).waitFor({ timeout: 20000 });
  await ivan.locator('button[data-kind="day"]', { hasText: dayText }).first().click();
  const takenChip = ivan.locator('button[data-kind="taken"]', { hasText: timeText }).first();
  check("a taken time shows as waitable on the student's page", (await takenChip.count()) === 1, `${dayText} ${timeText}`);
  await takenChip.click();
  await ivan.getByText(/^On the list for/).waitFor({ timeout: 20000 });
  check("a student joins the waitlist for a taken time with one tap", true);

  await olga.goto(BASE + "/coach");
  await olga.getByText(/1 student waiting/).waitFor({ timeout: 20000 });
  check("the coach's book shows who is waiting", true);
  await olga.locator("li", { hasText: "Pavel" }).getByRole("button", { name: "Cancel" }).first().click();
  await olga.locator("li", { hasText: "Pavel" }).getByText(/cancelled by you/).first().waitFor({ timeout: 20000 });

  await ivan.goto(`${BASE}/c/${handle}`);
  await ivan.getByTestId("offers").waitFor({ timeout: 20000 });
  check("the freed time is offered to the waiting student with the minutes left", (await ivan.getByText(/yours for \d+ more minutes/).count()) === 1);
  await ivan.getByTestId("offer-take").click();
  await ivan.getByText(/^Booked /).waitFor({ timeout: 20000 });
  await ivan.getByText(/8 of 10 left/).waitFor({ timeout: 20000 });
  check("taking the offer books the lesson and draws from the package", true);
  await shot(ivan, "64-student-offer");

  // A special request outside the hours: Ivan asks for tomorrow 23:30; Olga says yes from her book.
  await ivan.getByTestId("other-time").click();
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await ivan.locator('input[type="datetime-local"]').fill(`${tomorrow}T23:30`);
  await ivan.getByPlaceholder("A word for the coach, optional").fill("after work?");
  await ivan.getByRole("button", { name: "Ask Olga" }).click();
  await ivan.getByText(/^Asked Olga for/).waitFor({ timeout: 20000 });
  check("a time outside the hours becomes a request, not an error", true);
  await olga.goto(BASE + "/coach");
  await olga.getByTestId("coach-requests").waitFor({ timeout: 20000 });
  check("the coach sees the request with the student's note", (await olga.getByText(/after work\?/).count()) === 1);
  await olga.getByTestId("coach-requests").getByRole("button", { name: /Yes/ }).click();
  await olga.getByTestId("coach-requests").waitFor({ state: "detached", timeout: 20000 });
  await ivan.goto(`${BASE}/c/${handle}`);
  await ivan.getByText(/7 of 10 left/).waitFor({ timeout: 20000 });
  check("the coach's yes books the lesson at the requested time", (await ivan.getByText(/23:30/).count()) >= 1);

  // A manager: Olga makes one link; Nina opens it, gives a name, and sees Olga's book.
  await olga.goto(BASE + "/coach/settings");
  await olga.getByRole("button", { name: "Make a link for them" }).click();
  const managerLink = (await olga.getByTestId("manager-link").textContent({ timeout: 20000 }))?.trim() ?? "";
  check("the coach gets one manager link", /\/coach\/join\/[a-z0-9]{8}$/.test(managerLink), managerLink);
  const nina = await newPage();
  await nina.goto(managerLink);
  await nina.getByPlaceholder("e.g. Alex").fill("Nina");
  await nina.getByRole("button", { name: /Join Olga/ }).click();
  await nina.getByRole("heading", { name: "Today" }).waitFor({ timeout: 20000 });
  check("the manager lands in the coach's book after one name", (await nina.getByText("Pavel").count()) >= 1 || (await nina.getByText("Ivan").count()) >= 1);
  await olga.reload();
  check("the coach sees the manager listed", (await olga.getByTestId("coach-managers").getByText("Nina").count()) === 1);

  // Findable: Olga lists her page; the city list, the API and the MCP server see her; an assistant asks, Olga accepts, it books and cancels.
  await olga.goto(BASE + "/coach/settings");
  await olga.getByRole("checkbox", { name: /Listed publicly/ }).check();
  // The browser here runs in UTC; a Phuket coach's phone says Asia/Bangkok, which is what puts her on the Phuket list.
  await olga.getByLabel("Time zone").fill("Asia/Bangkok");
  await olga.getByRole("button", { name: "Save" }).click();
  await olga.getByText("Saved.").waitFor({ timeout: 20000 });
  const listed = await fetch(`${BASE}/api/v1/coaches?city=phuket`).then((r) => r.json());
  check("the API lists the coach in her city without anything private", listed.coaches.some((c) => c.handle === handle && c.rules.cutoffHours === 12) && !JSON.stringify(listed).includes("0899999999"), JSON.stringify(listed).slice(0, 200));
  await ivan.goto(`${BASE}/coaches/phuket`);
  check("the city list shows the listed coach with structured data", (await ivan.getByTestId("coach-list").getByText("Olga").count()) >= 1 && (await ivan.locator('script[type="application/ld+json"]').count()) === 1);
  const apiKey = await fetch(`${BASE}/api/v1/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "e2e coach", agent: "playwright" }) }).then((r) => r.json());
  const authed = { "content-type": "application/json", authorization: `Bearer ${apiKey.key}` };
  const rpc = (body) => fetch(`${BASE}/mcp`, { method: "POST", headers: { ...authed, accept: "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const found = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_coaches", arguments: { city: "phuket" } } });
  check("MCP find_coaches returns her", Boolean(found.result?.structuredContent?.coaches?.some((c) => c.handle === handle)), JSON.stringify(found).slice(0, 200));
  const slotsRpc = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "coach_slots", arguments: { handle, days: 7 } } });
  const slotList = slotsRpc.result?.structuredContent?.slots ?? [];
  check("MCP coach_slots returns free starts", slotList.length > 3, JSON.stringify(slotsRpc).slice(0, 200));
  const askRpc = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "request_coach", arguments: { handle, name: "Agent Ann" } } });
  const annToken = askRpc.result?.structuredContent?.student?.personalToken;
  check("MCP request_coach creates the student and returns a private token", askRpc.result?.structuredContent?.status === "requested" && typeof annToken === "string", JSON.stringify(askRpc).slice(0, 200));
  const tooEarly = await fetch(`${BASE}/api/v1/coaches/${handle}/lessons`, { method: "POST", headers: authed, body: JSON.stringify({ token: annToken, startsAt: slotList[2] }) });
  check("booking before the coach accepts is refused with a hint", tooEarly.status === 403 && (await tooEarly.json()).error?.hint?.includes("request_coach"));
  await olga.goto(BASE + "/coach/students");
  await olga.getByText("Waiting for your yes").waitFor({ timeout: 20000 });
  await olga.locator("li", { hasText: "Agent Ann" }).getByRole("button", { name: "Accept" }).click();
  await olga.locator("li", { hasText: "Agent Ann" }).getByRole("button", { name: /New package/ }).waitFor({ timeout: 20000 });
  const bookedRes = await fetch(`${BASE}/api/v1/coaches/${handle}/lessons`, { method: "POST", headers: authed, body: JSON.stringify({ token: annToken, startsAt: slotList[2] }) });
  const bookedJ = await bookedRes.json();
  check("an accepted student's assistant books a lesson through the API", bookedRes.status === 201 && bookedJ.lesson?.startsAt === slotList[2], JSON.stringify(bookedJ).slice(0, 200));
  const cancelRes = await fetch(`${BASE}/api/v1/coaches/${handle}/lessons/${bookedJ.lesson.id}`, { method: "DELETE", headers: authed, body: JSON.stringify({ token: annToken }) });
  const cancelJ = await cancelRes.json();
  check("and cancels it under the coach's rules", cancelRes.status === 200 && ["none", "refunded", "free_pass", "counted"].includes(cancelJ.outcome), JSON.stringify(cancelJ));
  const sitemap = await fetch(`${BASE}/sitemap.xml`).then((r) => r.text());
  check("the listed coach and the city list are in the sitemap in three languages", sitemap.includes(`/c/${handle}</loc>`) && sitemap.includes(`/ru/c/${handle}</loc>`) && sitemap.includes("/coaches/phuket</loc>"));
  const llms = await fetch(`${BASE}/llms.txt`).then((r) => r.text());
  check("llms.txt tells assistants about coaches and the tools", llms.includes("/api/v1/coaches") && llms.includes("find_coaches"));

  // ---- Coaches arrive on their own: every coach-facing page is a door ----
  await ivan.goto(`${BASE}/coaches`);
  check("the front door for coaches renders with one button to the book", (await ivan.getByText("Your students book themselves. Your calendar stays yours.").count()) === 1 && (await ivan.getByTestId("coach-front-cta").getAttribute("href")) === "/coach");
  await ivan.goto(`${BASE}/coaches?s=invite`);
  check("a tagged front door passes the door on to the setup link", (await ivan.getByTestId("coach-front-cta").getAttribute("href")) === "/coach?s=invite");
  await ivan.goto(`${BASE}/c/${handle}`);
  check("the coach page carries the quiet door for other coaches", (await ivan.getByTestId("own-book").getAttribute("href")) === "/coaches?s=coachpage");
  await ivan.goto(`${BASE}/coaches/phuket`);
  check("the first coach in the city carries the founding badge", (await ivan.getByText("Founding coach · Phuket").count()) >= 1);
  await ivan.goto(`${BASE}/`);
  check("the landing page has one quiet line for coaches", (await ivan.getByRole("link", { name: /Padel coach\? Your students book themselves/ }).count()) === 1);
  const front = await fetch(`${BASE}/sitemap.xml`).then((r) => r.text());
  check("the front door is in the sitemap in three languages", front.includes("/coaches</loc>") && front.includes("/ru/coaches</loc>") && front.includes("/es/coaches</loc>"));

  // Russian path renders the coach page in Russian (last: it switches Ivan's language).
  await ivan.goto(`${BASE}/ru/c/${handle}`);
  check("the coach page has a Russian URL", (await ivan.getByText("Тренер по паделу").count()) === 1);
} catch (e) {
  console.error("E2E crashed:", e);
  results.push({ name: "crash", ok: false });
} finally {
  await browser.close();
}

finish(results);
