// Groups: form one from a match, member creates the next match from the group page (prefilled,
// linked back), anyone with the link joins, admin sets the weekly slot, a member leaves.
import { BASE, crashed, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";

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
  await olga.getByPlaceholder("Court TBD · or type a club").fill("Club Nine");
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
  await olga.goto(`${BASE}/${code}`);
  check("match now shows its group", (await olga.getByText("Part of Club Nine").count()) === 1 && (await olga.getByRole("button", { name: /Turn this crew/ }).count()) === 0);

  // Bea is a member (she was in the match): creates the next match from the group page.
  await bea.goto(`${BASE}/g/${gcode}`);
  check("Bea is in the group", (await bea.getByText("You're in this group").count()) === 1);
  await bea.getByRole("link", { name: /Create the next match/ }).click();
  await bea.waitForURL(/\/\?group=/, { timeout: 20000 });
  check("create form is prefilled for the group", (await bea.getByRole("heading", { name: "For Club Nine" }).count()) === 1 && (await bea.locator("input[value='Club Nine']").count()) === 1);
  await bea.getByRole("button", { name: "Create & get the link" }).click();
  await bea.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  const code2 = bea.url().split("/").slice(-2)[0];
  await bea.goto(`${BASE}/${code2}`);
  check("next match belongs to the group", (await bea.getByText("Part of Club Nine").count()) === 1);
  await olga.goto(`${BASE}/g/${gcode}`);
  check("group lists both matches", (await olga.locator("a[href='/" + code2 + "']").count()) >= 1 && (await olga.locator("a[href='/" + code + "']").count()) >= 1);

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
} catch (e) {
  await crashed(browser, results, e);
} finally {
  await browser.close();
}
finish(results);
