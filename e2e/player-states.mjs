// The player's screens, in the states that make sentences false.
//
// Every defect found on 15 September was on a player surface and every one was found by a person:
// a "how did it go?" prompt still asking after somebody else had answered; a popup about the line-up
// when the story was that the score was already in; "Delete my account" sitting above "When do you
// want to play?"; a door inviting a player to become a coach on the one screen that is theirs.
//
// coach-states.mjs does this for the coach. This is the same treatment for the player: seed the
// awkward states, assert the shapes a machine can judge, and photograph the rest for a person —
// `SHOTS=./shots pnpm e2e` is how you get them.
import { BASE, crashed, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);
const desktop = { viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "Europe/Madrid", reducedMotion: "reduce" };

const api = (path, body) =>
  fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

const page = async (opts) => {
  const ctx = await browser.newContext(opts);
  const p = await ctx.newPage();
  p.on("dialog", (d) => d.accept());
  p.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  return p;
};

/** Which direct child of <main> holds this text, counting from the top. -1 when nothing does. */
const blockWith = (p, text) =>
  p.evaluate(
    (t) => [...(document.querySelector("main")?.children ?? [])].findIndex((el) => (el.textContent ?? "").includes(t)),
    text,
  );
const blocks = (p) => p.evaluate(() => document.querySelector("main")?.children.length ?? 0);

const LANDMARKS = {
  en: { link: "Your personal link", del: "Delete my account", feedback: "Tell us what should change" },
  ru: { link: "Ваша личная ссылка", del: "Удалить мой аккаунт", feedback: "Скажите, что стоит изменить" },
  es: { link: "Tu enlace personal", del: "Eliminar mi cuenta", feedback: "Cuéntanos qué debería cambiar" },
};

/**
 * What you read, then what you set, then the one thing you cannot undo.
 *
 * `hasFeedback` because only My matches carries the feedback door; the personal link page is the
 * same screen reached another way and has never had one. Saying so here beats a helper that quietly
 * passes when the card it is looking for is missing.
 */
async function readsInOrder(p, locale, where, { hasFeedback = true } = {}) {
  const L = LANDMARKS[locale];
  const [feedback, link, del, n] = [await blockWith(p, L.feedback), await blockWith(p, L.link), await blockWith(p, L.del), await blocks(p)];
  check(`${where}: the delete button is the last thing on the page`, del >= 0 && del === n - 1, `delete at ${del} of ${n} blocks`);
  check(`${where}: the settings sit under the content, above only the delete button`, link >= 0 && link < del && link > 0, `personal link ${link}, delete ${del} of ${n}`);
  if (hasFeedback) check(`${where}: the feedback card comes before the settings`, feedback >= 0 && link > feedback, `feedback ${feedback}, personal link ${link}`);
}

try {
  // ------------------------------------------------- a match that started an hour ago
  // An hour, not two: a match can still be joined until its length (90 minutes unless the organiser
  // picked another) has run out, and score entry
  // is open from the moment it does. Both have to be true for one player to walk this.
  const startsAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const made = await api("/api/v1/matches", { startsAt, tz: "Europe/Madrid", venue: "Kata Padel Center", organizer: { name: "Kai" } });
  const code = made.match?.code;
  check("a match that has already been played exists", Boolean(code), JSON.stringify(made).slice(0, 160));

  // ------------------------------------------------- Dana joins it, which is how she gets a name here
  const dana = await page(iphone);
  await dana.goto(`${BASE}/${code}`);
  await dana.getByRole("button", { name: "Join this match" }).click();
  await dana.getByPlaceholder("e.g. Alex").fill("Dana");
  await dana.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
  // The seat, not the word: a match already under way reads "HAPPENING NOW" and never says "You're
  // in", so waiting on that sentence waits for something this state does not have.
  await dana.getByText("2/4 players").waitFor({ timeout: 20000 });
  check("a player who has played is in the line-up", (await dana.getByText("2/4 players").count()) > 0);

  // The match has no score, so the screen asks for one. The other half of this is below.
  check("a match with no score asks for one", (await dana.getByRole("button", { name: "Enter score" }).count()) === 1);
  await shot(dana, "player-match-unscored");

  // ------------------------------------------------- My matches
  await dana.goto(BASE + "/me");
  await dana.waitForLoadState("networkidle").catch(() => {});
  const meText = await dana.locator("body").innerText();
  check("the walk is on My matches and not a 404", meText.includes("My matches") && (await dana.locator(`a[href="/${code}"]`).count()) > 0, meText.slice(0, 100));
  await shot(dana, "player-me-phone");
  await readsInOrder(dana, "en", "My matches");

  // A player's own screen is a player's. Asked of the links rather than the words, so a door with
  // different wording is caught too: this is where "Do you coach? Set up your assistant" used to be.
  const doors = await dana.evaluate(() => [...document.querySelectorAll("main a")].map((a) => a.getAttribute("href") ?? "").filter((h) => /^\/(coach|clubs)\b/.test(h)));
  check("nothing on a player's screen asks them to become a coach, a club or an organiser", doors.length === 0, doors.join(" "));

  // ------------------------------------------------- the personal link page, on a device with nothing
  const href = await dana.locator('a[href*="/p/"]').first().getAttribute("href");
  const token = (href ?? "").split("/p/")[1]?.split(/[/?#]/)[0] ?? "";
  check("My matches hands over a personal link", /^[A-Za-z0-9_-]{8,}$/.test(token), href ?? "(none)");
  const fresh = await page(iphone);
  await fresh.goto(`${BASE}/p/${token}`);
  await fresh.waitForLoadState("networkidle").catch(() => {});
  check("the personal link opens that player's own screen", (await fresh.locator(`a[href="/${code}"]`).count()) > 0);
  await readsInOrder(fresh, "en", "the personal link page", { hasFeedback: false });
  await shot(fresh, "player-personal-link");
  await fresh.close();

  // ------------------------------------------------- somebody answers the question
  await dana.goto(`${BASE}/${code}`);
  await dana.getByRole("button", { name: "Enter score" }).click();
  await dana.getByText("Dana").first().click();
  const sets = dana.locator("input[type=number]");
  await sets.nth(0).fill("6");
  await sets.nth(1).fill("1");
  await dana.getByRole("button", { name: "Save score" }).click();
  // The match page writes a score out as "Team A 6 Team B 1", never as "6-1" — that shape belongs to
  // the chat card and to My matches. Waiting for the wrong one waits forever.
  await dana.getByText("Entered by Dana").waitFor({ timeout: 20000 });
  await dana.goto(`${BASE}/${code}`);
  await dana.waitForLoadState("networkidle").catch(() => {});
  const scored = await dana.locator("body").innerText();
  // The class Eriik reported, on the web rather than in the chat: a question that has been answered
  // must stop being asked. "Edit score" is a different sentence and is allowed to stay.
  check("a match with a score no longer asks for one", (await dana.getByRole("button", { name: "Enter score" }).count()) === 0, scored.slice(0, 120));
  check("and it says who answered it, and with what", /Entered by Dana/.test(scored) && /Team A\s*6/.test(scored), scored.slice(0, 160));
  await shot(dana, "player-match-scored");

  // ------------------------------------------------- the inbox, and the notice switches (the owner's decision D)
  // Dana organises a match tomorrow and Kai joins it, both by the tokens they already hold, so the walk
  // makes no new name (every suite shares the new-identity limit). Kai's join is a notice to Dana.
  const kaiToken = made.organizer?.personalToken ?? "";
  const mine = await api("/api/v1/matches", { startsAt: new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString(), tz: "Europe/Madrid", venue: "Kata Padel Center", organizer: { name: "Dana", token } });
  const kaiIn = await api(`/api/v1/matches/${mine.match?.code}/join`, { token: kaiToken });
  check("Kai joins the match Dana organises", kaiIn.outcome === "joined", JSON.stringify(kaiIn).slice(0, 160));
  // The notice is written after the response: look a few times, never for long.
  const inbox = dana.getByTestId("inbox");
  for (let i = 0; i < 10; i++) {
    await dana.goto(BASE + "/me");
    await dana.waitForLoadState("networkidle").catch(() => {});
    if ((await inbox.count()) > 0) break;
    await dana.waitForTimeout(500);
  }
  check("the inbox appears on My matches with its new notices counted", (await inbox.count()) === 1 && /^\d+ new$/.test((await inbox.getByTestId("inbox-new").innerText()).toLowerCase()));
  // The count rides on the door and stays out of its name: "My matches" is still exactly what the link is called.
  check("the header's My matches carries the unread count", /^[1-9]\+?$/.test(await dana.getByTestId("nav-unread").innerText()) && (await dana.getByRole("link", { name: "My matches", exact: true }).count()) > 0);
  await inbox.locator("summary").click();
  check("the inbox lists the notice: Kai joined Dana's match", (await inbox.locator("li").filter({ hasText: "Kai joined" }).count()) === 1 && (await inbox.locator(`a[href="/${mine.match?.code}"]`).count()) === 1);
  check("opening the inbox reads it", (await inbox.getByTestId("inbox-new").count()) === 0 && (await inbox.locator("li[data-unread]").count()) === 0);
  await shot(dana, "player-inbox");

  const notices = dana.getByTestId("notice-settings");
  check("Notices is one line that says what is set", (await notices.getByTestId("notice-summary").innerText()) === "6 of 7 on · no quiet hours");
  await notices.locator("summary").click();
  await notices.getByLabel("Open spots", { exact: true }).uncheck();
  await notices.getByLabel("From", { exact: true }).selectOption("22:00");
  await notices.getByLabel("To", { exact: true }).selectOption("08:00");
  await notices.getByRole("button", { name: "Save notices" }).click();
  await notices.getByRole("status").waitFor({ timeout: 20000 });
  await dana.reload();
  await dana.waitForLoadState("networkidle").catch(() => {});
  const kept = dana.getByTestId("notice-settings");
  check("after a reload the line says what was set", (await kept.getByTestId("notice-summary").innerText()) === "5 of 7 on · quiet 22:00–08:00", await kept.getByTestId("notice-summary").innerText());
  await kept.locator("summary").click();
  check(
    "and the switches and the quiet hours stayed",
    !(await kept.getByLabel("Open spots", { exact: true }).isChecked()) && (await kept.getByLabel("Match changes", { exact: true }).isChecked()) && !(await kept.getByLabel("Club matches", { exact: true }).isChecked()) && (await kept.getByLabel("From", { exact: true }).inputValue()) === "22:00" && (await kept.getByLabel("To", { exact: true }).inputValue()) === "08:00",
  );
  check("and the header's count is gone", (await dana.getByTestId("nav-unread").count()) === 0);
  await shot(dana, "player-notices");

  // ------------------------------------------------- the same screens at desk width
  await dana.setViewportSize({ width: 1280, height: 900 });
  await dana.goto(BASE + "/me");
  await dana.waitForLoadState("networkidle").catch(() => {});
  const wide = await dana.locator("body").innerText();
  check("nothing asks a desktop visitor to add anything to a home screen", !/home screen/i.test(wide), (wide.match(/.{0,40}home screen.{0,40}/i) ?? [""])[0]);
  await shot(dana, "player-me-desktop");
  await dana.setViewportSize(iphone.viewport);

  // ------------------------------------------------- and in the other two languages
  for (const loc of ["ru", "es"]) {
    await dana.goto(`${BASE}/${loc}/me`);
    await dana.waitForLoadState("networkidle").catch(() => {});
    const t = await dana.locator("body").innerText();
    check(`the ${loc} My matches carries no untranslated key`, !/\b[a-z]+\.[a-z]+\.[a-zA-Z]+\b/.test(t.replace(/\S+@\S+|https?:\S+|[\w-]+\.(?:sh|com|org|net)\b/g, "")), (t.match(/\b[a-z]+\.[a-z]+\.[a-zA-Z]+\b/) ?? [""])[0]);
    check(`the ${loc} My matches shows no half-written value`, !/undefined|NaN|\[object/.test(t), (t.match(/.{0,30}(undefined|NaN|\[object).{0,30}/) ?? [""])[0]);
    await readsInOrder(dana, loc, `${loc} My matches`);
    await shot(dana, `player-me-${loc}`);
  }
  await dana.close();
} catch (e) {
  await crashed(browser, results, e, "player-states");
}

finish(results);
