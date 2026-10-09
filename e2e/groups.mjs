// Groups: form one from a match, member creates the next match from the group page (prefilled,
// linked back), anyone with the link joins, admin sets the weekly slot, a member leaves; a visitor
// sees names but no levels, and a group that asks to join takes an ask the admin approves.
import { BASE, crashed, finish, iphone, launch, makeCheck, shot, sitsInside } from "./lib.mjs";

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
  // Olga creates a match at "Club Nine", Bea joins.
  const olga = await newPage();
  await olga.goto(BASE + "/");
  await olga.getByPlaceholder("e.g. Alex").fill("Olga");
  await olga.getByPlaceholder("Court TBD · or pick a club").fill("Club Nine");
  await olga.getByRole("button", { name: "Create & get the link" }).click();
  await olga.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code = olga.url().split("/").slice(-2)[0];
  const bea = await newPage();
  await bea.goto(`${BASE}/${code}`);
  await bea.getByRole("button", { name: "Join this match" }).click();
  await bea.getByPlaceholder("e.g. Alex").fill("Bea");
  await bea.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
  await bea.getByText("You're in").waitFor({ timeout: 20000 });

  // Olga turns the crew into a group.
  await olga.goto(`${BASE}/${code}`);
  check("match page offers to form a group", (await olga.getByRole("button", { name: /Turn this crew into a group/ }).count()) === 1);
  await olga.getByRole("button", { name: /Turn this crew into a group/ }).click();
  // The name is seen before the group exists: suggested from the rhythm, never the venue; Olga types her own.
  const nameField = olga.locator("#group-name");
  await nameField.waitFor({ timeout: 10000 });
  const suggested = await nameField.inputValue();
  check("the suggested group name is a real name, not the venue", suggested.length > 3 && !/Club Nine/.test(suggested) && !/\d{2}:\d{2}/.test(suggested), suggested);
  await olga.getByRole("button", { name: "Another name" }).click();
  check("the dice rolls another name", (await nameField.inputValue()) !== suggested, await nameField.inputValue());
  await nameField.fill("Club Nine");
  await olga.getByRole("button", { name: /Create the group/ }).click();
  await olga.waitForURL(/\/g\/[^/]{6}$/, { timeout: 30000 });
  const gcode = olga.url().split("/").pop();
  await shot(olga, "g1-group");
  check("group page: named as typed, 2 members, admin chip", (await olga.getByRole("heading", { name: "Club Nine" }).count()) === 1 && (await olga.getByText("2 members").count()) > 0 && (await olga.getByText("Admin").count()) === 1);
  check("the original match is listed as upcoming", (await olga.locator("a[href='/" + code + "']").count()) >= 1);
  // Rule 3: the season table waits for the crew's second scored match; a new crew has none.
  check("no season table before any result", (await olga.getByTestId("crew-season").count()) === 0);
  await olga.goto(`${BASE}/${code}`);
  check("match now shows its group", (await olga.getByText("Part of Club Nine").count()) === 1 && (await olga.getByRole("button", { name: /Turn this crew/ }).count()) === 0);

  // Bea is a member (she was in the match): creates the next match from the group page.
  await bea.goto(`${BASE}/g/${gcode}`);
  check("Bea is in the group", (await bea.getByText("You're in this group").count()) === 1);
  await bea.getByRole("link", { name: /Create the next match/ }).click();
  await bea.waitForURL(/\/\?group=/, { timeout: 20000 });
  check("create form is prefilled for the group", (await bea.getByRole("heading", { name: "For Club Nine" }).count()) === 1 && (await bea.locator("input[value='Club Nine']").count()) === 1);
  // A crowded row on purpose: the seats, a level and a tag side by side must wrap at 390px, never clip.
  await bea.getByTestId("level-chip").click();
  await bea.getByRole("button", { name: "Gold", exact: true }).click();
  await bea.getByTestId("tag-category").getByRole("button", { name: "Mixed", exact: true }).click();
  await bea.getByTestId("tag-age").getByRole("button", { name: "45+", exact: true }).click();
  await bea.getByRole("button", { name: "Create & get the link" }).click();
  await bea.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code2 = bea.url().split("/").slice(-2)[0];
  await bea.goto(`${BASE}/${code2}`);
  check("next match belongs to the group", (await bea.getByText("Part of Club Nine").count()) === 1);
  await olga.goto(`${BASE}/g/${gcode}`);
  check("group lists both matches", (await olga.locator("a[href='/" + code2 + "']").count()) >= 1 && (await olga.locator("a[href='/" + code + "']").count()) >= 1);
  const crowded = olga.locator("a[href='/" + code2 + "']").first();
  const tagText = ((await crowded.getByTestId("tag-chip").textContent().catch(() => null)) ?? "no chip").trim();
  const box = await sitsInside(olga, crowded.getByTestId("tag-chip"), crowded);
  check("the group row names who the match is for, and the chip sits inside the row at 390px", tagText === "Mixed · 45+" && box.ok, `${tagText} ${box.detail}`);
  await shot(olga, "g1b-group-tagged");
  // Each upcoming row says whether there is room. Chips are set in capitals by CSS, so read textContent.
  const firstFill = ((await olga.locator("a[href='/" + code + "']").getByTestId("group-row-chips").first().textContent()) ?? "").toLowerCase();
  check("an upcoming row shows the spots left on one line of chips", /\d spots? left/.test(firstFill), firstFill);

  // Cal joins via the link (no identity yet).
  const cal = await newPage();
  await cal.goto(`${BASE}/g/${gcode}`);
  check("non-members see the join button and the member-only hint", (await cal.getByRole("button", { name: "Join this group" }).count()) === 1 && (await cal.getByText("Join the group first").count()) === 1);
  await cal.getByRole("button", { name: "Join this group" }).click();
  await cal.getByPlaceholder("e.g. Alex").fill("Cal");
  await cal.getByRole("button", { name: "Join this group" }).click();
  await cal.getByText("You're in this group").waitFor({ timeout: 20000 });
  check("Cal joined: 3 members", (await cal.getByText("3 members").count()) > 0);
  await cal.goto(`${BASE}/me`);
  check("My matches lists the group", (await cal.getByText("Your groups").count()) === 1 && (await cal.getByText("Club Nine").count()) >= 1);

  // Olga sets a weekly slot.
  await olga.goto(`${BASE}/g/${gcode}`);
  await olga.getByRole("button", { name: /Group settings/ }).click();
  await olga.getByLabel("Weekly slot").selectOption({ label: "Thursday" });
  await olga.getByLabel("Time").fill("19:00");
  await olga.getByRole("button", { name: "Save", exact: true }).click();
  await olga.getByText("Every Thursday at 19:00").waitFor({ timeout: 20000 });
  await shot(olga, "g2-weekly");
  check("weekly slot saved and explained", (await olga.getByText(/created 5 days ahead/).count()) > 0);

  // Cal leaves, Olga removes nobody but sees remove buttons for non-admins.
  await cal.goto(`${BASE}/g/${gcode}`);
  await cal.getByRole("button", { name: "Leave group" }).click();
  await cal.getByRole("button", { name: "Join this group" }).waitFor({ timeout: 20000 });
  check("Cal left: 2 members", (await cal.getByText("2 members").count()) > 0);
  await olga.goto(`${BASE}/g/${gcode}`);
  check("admin sees a remove button for Bea only", (await olga.getByRole("button", { name: "Remove" }).count()) === 1);

  // Olga hands the group to Bea from the settings. Olga stays a member and can now leave; Bea runs it.
  await olga.getByRole("button", { name: /Group settings/ }).click();
  await olga.getByLabel("Hand the group to").selectOption({ label: "Bea" });
  await olga.getByRole("button", { name: "Hand over", exact: true }).click();
  await olga.getByRole("button", { name: "Leave group" }).waitFor({ timeout: 20000 });
  check("after the hand-over Olga is a member without the settings", (await olga.getByRole("button", { name: /Group settings/ }).count()) === 0 && (await olga.getByText("You're in this group").count()) === 1);
  await bea.goto(`${BASE}/g/${gcode}`);
  check("Bea is the admin now", (await bea.getByRole("button", { name: /Group settings/ }).count()) === 1 && (await bea.getByRole("button", { name: "Remove" }).count()) === 1);

  // Decision E (9 October 2026): names visible, levels hidden, optional Ask to join.
  // Bea declares a level on My matches: a member sees it on the group page, a visitor never does.
  await bea.goto(`${BASE}/me`);
  const beaLevel = bea.locator("section", { hasText: "Your level" });
  await beaLevel.getByRole("button", { name: "Set my level" }).click();
  await bea.getByLabel("Your level").selectOption({ label: "3.5" });
  await beaLevel.getByRole("button", { name: "Save", exact: true }).click();
  await beaLevel.getByText("3.5", { exact: true }).waitFor({ timeout: 20000 });
  await olga.goto(`${BASE}/g/${gcode}`);
  check("a member sees Bea's level on the member row", (await olga.locator("li", { hasText: "Bea" }).getByText("3.5", { exact: true }).count()) === 1);
  const dee = await newPage();
  await dee.goto(`${BASE}/g/${gcode}`);
  check(
    "a visitor sees the members by name and the count, and no level on any member row",
    (await dee.locator("li", { hasText: "Bea" }).count()) >= 1 && (await dee.getByText("3.5", { exact: true }).count()) === 0 && (await dee.getByText("2 members").count()) > 0 && (await dee.getByText("Levels show to members only.").count()) === 1,
  );

  // Bea switches on Ask to join in the settings. The checkbox is set where the walk needs it, at the end.
  await bea.goto(`${BASE}/g/${gcode}`);
  await bea.getByRole("button", { name: /Group settings/ }).click();
  await bea.getByLabel("Ask to join", { exact: true }).check();
  await bea.getByRole("button", { name: "Save", exact: true }).click();
  await bea.getByText(/Whoever opens it asks to join/).waitFor({ timeout: 20000 });

  // Dee, with no identity yet, asks with a note instead of joining in one tap.
  await dee.goto(`${BASE}/g/${gcode}`);
  check("a visitor of an asking group meets Ask to join, not Join", (await dee.getByRole("button", { name: "Ask to join", exact: true }).count()) === 1 && (await dee.getByRole("button", { name: "Join this group" }).count()) === 0);
  await dee.getByRole("button", { name: "Ask to join", exact: true }).click();
  await dee.getByPlaceholder("e.g. Alex").fill("Dee");
  await dee.getByLabel("A note for the admins (optional)").fill("Ladies' night regular, Tuesdays");
  await shot(dee, "g4-ask");
  await dee.getByRole("button", { name: "Ask to join", exact: true }).click();
  await dee.getByText("Asked. The admins decide.").waitFor({ timeout: 20000 });
  await shot(dee, "g5-asked");
  check("Dee asked: not a member yet, and she can take it back", (await dee.getByText("2 members").count()) > 0 && (await dee.getByRole("button", { name: "Withdraw", exact: true }).count()) === 1);

  // Bea sees the ask with its note and approves it; Dee is listed and now sees the levels.
  await bea.goto(`${BASE}/g/${gcode}`);
  const asks = bea.getByTestId("group-asks");
  check("the admin sees Dee's ask with her note", (await asks.getByText("Dee", { exact: true }).count()) === 1 && (await asks.getByText(/Ladies' night regular/).count()) === 1);
  await shot(bea, "g3-asks");
  await asks.getByRole("button", { name: "Approve", exact: true }).click();
  await bea.getByText("3 members").first().waitFor({ timeout: 20000 });
  check("approved: Dee is listed among the members and the ask is gone", (await bea.locator("li", { hasText: "Dee" }).count()) >= 1 && (await bea.getByTestId("group-asks").count()) === 0);
  await dee.goto(`${BASE}/g/${gcode}`);
  check("Dee is in the group and sees Bea's level now", (await dee.getByText("You're in this group").count()) === 1 && (await dee.locator("li", { hasText: "Bea" }).getByText("3.5", { exact: true }).count()) === 1);
} catch (e) {
  await crashed(browser, results, e);
} finally {
  await browser.close();
}
finish(results);
