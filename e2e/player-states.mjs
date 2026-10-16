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
import { existsSync, readFileSync } from "node:fs";
import { BASE, crashed, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";

const browser = await launch();
/** What a phone shows, 390 px wide, around the element the walk just scrolled to: the full-page shot of a long page is too tall to read. */
const view = (p, name) => (process.env.SHOTS ? p.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : Promise.resolve());
const results = [];
const check = makeCheck(results);
const desktop = { viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "Europe/Madrid", reducedMotion: "reduce" };

const api = (path, body) =>
  fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

/**
 * The walks of 15 October 2026 write through a key of their own: without one an address gets twelve
 * writes a day (`apiWritesPerIpPerDay`), and the walks above, with the other suites that write from
 * this machine's address, spend most of them. A key gets three hundred.
 */
let apiKey = "";
const keyed = async (path, body) => {
  if (!apiKey) apiKey = (await api("/api/v1/keys", { name: "player-states walks" })).key ?? "";
  return fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) }).then((r) => r.json());
};

const CRON = { authorization: `Bearer ${process.env.CRON_SECRET || "e2e-cron-secret"}` };
/** One read through the operator's read-only door: the database's own answer, not the page's. */
const ask = async (q) => {
  const r = await fetch(`${BASE}/api/admin/sql?q=${encodeURIComponent(q)}`, { headers: CRON }).then((x) => x.json());
  if (!r.ok) throw new Error(`${r.error} in: ${q}`);
  return r.rows;
};
const recordsNamed = async (name) => Number((await ask(`select count(*)::int as n from players where display_name = '${name}'`))[0]?.n ?? -1);
/** "Played before? Sign in" under the line-up is gone: the question that stands is the way back in (`SeatedAsk` registers it). */
const noBackInLine = (p) => p.getByTestId("event-back-in-line").waitFor({ state: "detached", timeout: 5000 }).then(() => true).catch(() => false);

/** Every email the test server wrote instead of sending (`EMAIL_SINK_FILE`, set by e2e/run.mjs). */
const mails = () => (process.env.EMAIL_SINK_FILE && existsSync(process.env.EMAIL_SINK_FILE) ? readFileSync(process.env.EMAIL_SINK_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
/** The newest 6-digit code mailed to an address, waiting a little for the write after the answer. */
const codeFor = async (to) => {
  for (let i = 0; i < 40; i++) {
    const code = mails().filter((m) => m.to === to).map((m) => m.subject.match(/^(\d{6}) is your Kicksmash code$/)?.[1]).filter(Boolean).at(-1);
    if (code) return code;
    await new Promise((r) => setTimeout(r, 250));
  }
  return "";
};
/** A Telegram update, as the bot's webhook gets it (the fake bot of e2e/run.mjs). */
const telegramHook = (update) =>
  fetch(`${BASE}/api/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": process.env.TELEGRAM_WEBHOOK_SECRET || "e2e-tg-secret" }, body: JSON.stringify(update) }).then((r) => r.json());

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
  // Rosalind's last match, for "Kicksmash can't reach Tomasz" further down (the owner's decision of 15
  // October 2026, D1). The line names the free-seat offer's own past partners, and a match makes partners
  // only once it has ended (`partnersQuery`, `endedBy`). A match can be joined only until it ends, so this
  // one is booked for the shortest length, 60 minutes, starts 58 minutes ago, takes its two players now,
  // and has ended by the time the walk below reads the line (it waits out the rest, if any is left).
  const playedEnds = Date.now() + 2 * 60 * 1000;
  const playedNow = await keyed("/api/v1/matches", { startsAt: new Date(playedEnds - 60 * 60 * 1000).toISOString(), durationMinutes: 60, tz: "Europe/Madrid", venue: "Kata Padel Center", organizer: { name: "Rosalind" } });
  const rosaToken = playedNow.organizer?.personalToken ?? "";
  const tomaszIn = await keyed(`/api/v1/matches/${playedNow.match?.code}/join`, { name: "Tomasz" });
  const milenaIn = await keyed(`/api/v1/matches/${playedNow.match?.code}/join`, { name: "Milena", email: "milena-e2e@example.com" });
  // Olek, like Tomasz, gave no contact. Later he organises a match of his own, which "That's me" refuses.
  const olekIn = await keyed(`/api/v1/matches/${playedNow.match?.code}/join`, { name: "Olek" });

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
  // The owner, 12 October 2026: "the two notifications in top signifies what? Already one upcoming match."
  // The count is a bell, a link of its own named as updates, to the inbox; "My matches" keeps its own name.
  const bellLink = dana.getByTestId("nav-unread");
  const bellSays = { text: (await bellLink.innerText()).trim(), name: await bellLink.getAttribute("aria-label"), href: await bellLink.getAttribute("href") };
  check(
    "the header's bell names the count as new updates and leads to the inbox, and \"My matches\" keeps its own name",
    /^[1-9]\+?$/.test(bellSays.text) && (bellSays.name === `${bellSays.text} new update${bellSays.text === "1" ? "" : "s"}` || bellSays.name === "More than 9 new updates") && bellSays.href === "/me#inbox" && (await dana.getByRole("link", { name: "My matches", exact: true }).count()) > 0,
    JSON.stringify(bellSays),
  );
  // While it has new notices the inbox is the first thing under the title, above the matches.
  const inboxY = (await inbox.boundingBox())?.y ?? Infinity;
  const upcomingY = (await dana.getByRole("heading", { name: "Upcoming", exact: true }).boundingBox())?.y ?? -Infinity;
  check("with new notices the inbox sits under the title, above the matches", inboxY < upcomingY, JSON.stringify({ inboxY, upcomingY }));
  // The header at 390 px in all three languages, the bell on: the brand mark, "My matches", the bell, ⋯ and
  // the language pill each inside the screen, apart from one another, and no sideways scroll.
  const headerFits = () =>
    dana.evaluate(() => {
      const box = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
      const [bell, play, more, lang] = ['[data-testid="nav-unread"]', '[data-testid="nav-play"]', '[data-testid="nav-more"]', 'header [aria-label="Language"]'].map(box);
      const vw = document.documentElement.clientWidth;
      const all = [bell, play, more, lang];
      const inside = all.every((b) => b && b.left >= 0 && b.right <= vw + 0.5);
      const apart = inside && bell.right <= more.left + 0.5 && play.right <= more.left + 0.5 && more.right <= lang.left + 0.5;
      const word = document.querySelector('[data-testid="nav-play"]');
      const whole = Boolean(word) && word.scrollWidth <= word.clientWidth + 0.5;
      const edges = (b) => (b ? [Math.round(b.left), Math.round(b.right)] : null);
      return { ok: inside && apart && whole && document.documentElement.scrollWidth <= vw, vw, play: edges(play), bell: edges(bell), more: edges(more), lang: edges(lang), word: word?.textContent };
    });
  for (const l of ["ru", "es", "en"]) {
    await dana.context().addCookies([{ name: "NEXT_LOCALE", value: l, url: BASE }]);
    await dana.goto(BASE + "/me");
    await dana.getByTestId("nav-unread").waitFor({ timeout: 15000 });
    const fit = await headerFits();
    check(`the header fits a 390 px phone in ${l} with the bell on`, fit.ok, JSON.stringify(fit));
    if (l !== "en") await shot(dana, `player-header-bell-${l}`);
  }
  // On My matches itself the bell is a tap to a place on the same page. A same-page hash link remounts
  // nothing, so the inbox once only scrolled into view and stayed shut and unread (review, 12 October 2026).
  await dana.getByTestId("nav-unread").click();
  const bellOpened = await inbox.evaluate((d) => new Promise((ok) => (d.open ? ok(true) : setTimeout(() => ok(d.open), 1500))));
  check("a tap on the bell on My matches opens the inbox", bellOpened === true);
  if (!bellOpened) await inbox.locator("summary").click();
  check("the inbox lists the notice: Kai joined Dana's match", (await inbox.locator("li").filter({ hasText: "Kai joined" }).count()) === 1 && (await inbox.locator(`a[href="/${mine.match?.code}"]`).count()) === 1);
  // The marks go after the tap is handled, not at the instant of the click: wait for them to go, never for long.
  await inbox.getByTestId("inbox-new").waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
  check("opening the inbox reads it", (await inbox.getByTestId("inbox-new").count()) === 0 && (await inbox.locator("li[data-unread]").count()) === 0);
  await shot(dana, "player-inbox");

  // ------------------------------------------------- opening a match reads its notices (the owner's question, 12 October 2026)
  // Erik's bell said 3 on every page for facts the match page already showed him. Kai joins two more of
  // Dana's matches: two new notices, one about each. Opening one match reads its notice, so the bell on
  // /play is one lower; opening the other leaves no bell. The mark is written after the response, and the
  // header of that same response may still show the old count, so the bell is read on the next page.
  const twoMore = [];
  for (const hours of [50, 74]) {
    const m = await api("/api/v1/matches", { startsAt: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(), tz: "Europe/Madrid", venue: "Kata Padel Center", organizer: { name: "Dana", token } });
    await api(`/api/v1/matches/${m.match?.code}/join`, { token: kaiToken });
    twoMore.push(m.match?.code);
  }
  const bellOnPlay = async () => {
    await dana.goto(BASE + "/play");
    await dana.waitForLoadState("networkidle").catch(() => {});
    const b = dana.getByTestId("nav-unread");
    return (await b.count()) ? Number((await b.innerText()).trim()) : 0;
  };
  /** The bell on /play until `done` says yes, a few looks, never for long. */
  const bellUntil = async (done) => {
    let n = await bellOnPlay();
    for (let i = 0; i < 10 && !done(n); i++) {
      await dana.waitForTimeout(500);
      n = await bellOnPlay();
    }
    return n;
  };
  const bellBefore = await bellUntil((n) => n >= 2);
  await dana.goto(`${BASE}/${twoMore[0]}`);
  await dana.waitForLoadState("networkidle").catch(() => {});
  const bellAfterOne = await bellUntil((n) => n < bellBefore);
  check("opening one match reads its notice: the bell on /play is one lower, the other match's notice still new", bellBefore === 2 && bellAfterOne === 1, `${bellBefore} -> ${bellAfterOne}`);
  await shot(dana, "player-bell-one-read");
  await dana.goto(`${BASE}/${twoMore[1]}`);
  await dana.waitForLoadState("networkidle").catch(() => {});
  const bellAfterTwo = await bellUntil((n) => n === 0);
  check("opening the other match too leaves no bell", bellAfterTwo === 0, `${bellAfterOne} -> ${bellAfterTwo}`);
  await dana.goto(BASE + "/me");
  check("and the inbox keeps both notices, read", (await dana.getByTestId("inbox").locator("li").filter({ hasText: "Kai joined" }).count()) >= 3 && (await dana.getByTestId("inbox").locator("li[data-unread]").count()) === 0);

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

  // ------------------------------------------------- "Kicksmash can't reach Tomasz" (the owner's decision of 15 October 2026, D1)
  // Rosalind's last match (made at the top of this walk, and over now) had Tomasz, who gave Kicksmash no
  // contact, and Milena, who gave an email. On her next match, with seats open, her own page names Tomasz
  // and not Milena, whom the free-seat offer reaches. Ivo, in a match with her that is still being played,
  // is no partner of the offer's yet, so the line does not name him either. Nobody else's page carries
  // Tomasz's name at all, and a full match names nobody.
  check("Rosalind's last match has Tomasz, Milena and Olek in it", tomaszIn.outcome === "joined" && milenaIn.outcome === "joined" && olekIn.outcome === "joined", JSON.stringify([tomaszIn.outcome, milenaIn.outcome, olekIn.outcome]));
  const playing = await keyed("/api/v1/matches", { startsAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), tz: "Europe/Madrid", venue: "Kata Padel Center", organizer: { name: "Rosalind", token: rosaToken } });
  const ivoIn = await keyed(`/api/v1/matches/${playing.match?.code}/join`, { name: "Ivo" });
  check("Rosalind is playing a match with Ivo, which has not ended", ivoIn.outcome === "joined", JSON.stringify(ivoIn.outcome));
  const nextUp = await keyed("/api/v1/matches", { startsAt: new Date(Date.now() + 30 * 60 * 60 * 1000).toISOString(), tz: "Europe/Madrid", venue: "Kata Padel Center", organizer: { name: "Rosalind", token: rosaToken } });
  const nextCode = nextUp.match?.code;
  // The last match must have ended: wait out what is left of its hour, if anything is.
  if (Date.now() < playedEnds + 2000) await new Promise((r) => setTimeout(r, playedEnds + 2000 - Date.now()));
  const rosa = await page(iphone);
  await rosa.goto(`${BASE}/p/${rosaToken}/go?next=/${nextCode}`);
  const unreached = rosa.getByTestId("unreached");
  await unreached.waitFor({ timeout: 20000 });
  const unreachedText = (await unreached.innerText()).replace(/\s+/g, " ");
  check(
    "the organiser's page names the past partners Kicksmash cannot reach, and not the one it reaches, nor a player of a match not yet over; both sign in as themselves",
    unreachedText.includes("Kicksmash can't reach ") && unreachedText.includes("Tomasz") && unreachedText.includes("Olek") && unreachedText.includes("Send them the link: they sign in as themselves.") && !unreachedText.includes("Milena") && !unreachedText.includes("Ivo"),
    unreachedText,
  );
  const sendHref = (await unreached.getByTestId("unreached-send").getAttribute("href")) ?? "";
  check("its one action is the match's own WhatsApp share, the link tagged as WhatsApp's", sendHref.startsWith("https://wa.me/?text=") && decodeURIComponent(sendHref).includes(`/${nextCode}?s=wa`), sendHref.slice(0, 120));
  await unreached.scrollIntoViewIfNeeded();
  await shot(rosa, "player-unreached-line");
  await unreached.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await view(rosa, "player-unreached-line-390");
  // Olek now organises a match of his own, so "That's me" refuses him (DECIDING rule 34). His name stays on
  // the line, which no longer promises that everybody on it signs in as themselves.
  const olekMatch = await keyed("/api/v1/matches", { startsAt: new Date(Date.now() + 50 * 60 * 60 * 1000).toISOString(), tz: "Europe/Madrid", venue: "Kata Padel Center", organizer: { name: "Olek", token: olekIn.player?.personalToken } });
  check("Olek organises a match of his own", Boolean(olekMatch.match?.code) && olekMatch.organizer?.name === "Olek", JSON.stringify(olekMatch).slice(0, 160));
  await rosa.reload();
  await unreached.waitFor({ timeout: 20000 });
  const plainText = (await unreached.innerText()).replace(/\s+/g, " ");
  check(
    "a partner \"That's me\" refuses keeps the plain line: \"Send them the link.\", with no promise that they sign in as themselves",
    plainText.includes("Tomasz") && plainText.includes("Olek") && plainText.includes("Send them the link.") && !plainText.includes("they sign in as themselves"),
    plainText,
  );
  await unreached.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await view(rosa, "player-unreached-line-plain-390");
  // Nobody else: a stranger's page carries Tomasz nowhere, not even in the data the browser is given.
  const stranger = await page(iphone);
  await stranger.goto(`${BASE}/${nextCode}`);
  await stranger.waitForLoadState("networkidle").catch(() => {});
  check("a viewer who is not the organiser gets no such line, and the page carries no word of Tomasz", (await stranger.getByTestId("unreached").count()) === 0 && !(await stranger.content()).includes("Tomasz"));
  const publicMatch = await fetch(`${BASE}/api/v1/matches/${nextCode}`).then((r) => r.text());
  check("nor does the public API", !publicMatch.includes("Tomasz") && publicMatch.includes(nextCode));
  await stranger.close();

  // ------------------------------------------------- "Played before as Tomasz? Sign in as Tomasz." (the owner's decision of 16 October 2026, D6)
  // Rosalind sends Tomasz the plain link. It opens a browser that knows nobody, and he types his name. The
  // server finds him on her unreached list and asks first, instead of making a second Tomasz; "That's me"
  // signs that browser in as his record, in two taps. The browser never gets the list.
  const t1 = await page(iphone);
  let t1Sends = 0;
  t1.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) t1Sends += 1;
  });
  await t1.goto(`${BASE}/${nextCode}`);
  check("the plain link carries no word of Tomasz before he types his name", !(await t1.content()).includes("Tomasz"));
  await t1.getByRole("button", { name: "Join this match" }).click();
  await t1.getByTestId("open-spot-name").first().fill("tomasz");
  await t1.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
  const tAsk = t1.getByTestId("seated-ask");
  await tAsk.waitFor({ timeout: 20000 });
  check(
    "a browser that knows nobody types a name on the organiser's unreached list: it is asked \"Played before as Tomasz? Sign in as Tomasz.\", with \"That's me\", and no second Tomasz is made",
    (await tAsk.getAttribute("data-ask")) === "unreached" && ((await tAsk.innerText()) ?? "").includes("Played before as Tomasz? Sign in as Tomasz.") && (await tAsk.getByRole("button", { name: "That's me", exact: true }).count()) === 1 && (await recordsNamed("Tomasz")) === 1,
    ((await tAsk.innerText()) ?? "").replace(/\s+/g, " "),
  );
  check("no \"Played before? Sign in\" line stands beside the question as a second, dead way in", await noBackInLine(t1));
  t1Sends = 0;
  await tAsk.getByRole("button", { name: "That's me", exact: true }).click();
  const tSure = tAsk.getByRole("button", { name: "Sign in as Tomasz?", exact: true });
  await tSure.waitFor({ timeout: 10000 });
  check("the first tap asks again and sends nothing", t1Sends === 0, `sends=${t1Sends}`);
  await shot(t1, "player-unreached-sign-in");
  await tAsk.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await view(t1, "player-unreached-sign-in-390");
  await tSure.click();
  await t1.getByTestId("open-spot-welcome").waitFor({ timeout: 20000 });
  check(
    "the second tap signs that browser in as Tomasz's own record: the page welcomes him with one Join, and the database holds one Tomasz",
    ((await t1.getByTestId("open-spot-welcome").innerText()) ?? "").includes("Welcome back, Tomasz! Join this match?") && (await recordsNamed("Tomasz")) === 1,
  );
  await t1.close();
  // Every seat taken: the line goes.
  for (const name of ["Pia", "Quim", "Remy"]) await keyed(`/api/v1/matches/${nextCode}/join`, { name });
  await rosa.goto(`${BASE}/${nextCode}`);
  await rosa.getByText("4/4 players").first().waitFor({ timeout: 20000 });
  // Only the line: the organiser's page carries past players' names anyway, for "Is this Tomasz…?" in "Paste the names".
  check("once every seat is taken, the organiser's page has no such line", (await rosa.getByTestId("unreached").count()) === 0 && !(await rosa.locator("main").innerText()).includes("can't reach"));
  await rosa.close();

  // ------------------------------------------------- "Zeno is in this match. Sign in as Zeno?" (the owner's decision of 15 October 2026, D2)
  // Gus's match holds Zeno, who has nothing to prove him, and Mirta, who gave an email. A link in a
  // WhatsApp group opens a browser that knows nobody, and the player types the name they always type.
  const gus = await keyed("/api/v1/matches", { startsAt: new Date(Date.now() + 28 * 60 * 60 * 1000).toISOString(), tz: "Europe/Madrid", venue: "Kata Padel Center", organizer: { name: "Gus" } });
  const gCode = gus.match?.code;
  const zenoIn = await keyed(`/api/v1/matches/${gCode}/join`, { name: "Zeno" });
  const mirtaIn = await keyed(`/api/v1/matches/${gCode}/join`, { name: "Mirta", email: "mirta-e2e@example.com" });
  check("Gus's match holds Zeno and Mirta, with a seat open", zenoIn.outcome === "joined" && mirtaIn.outcome === "joined" && (await recordsNamed("Zeno")) === 1, JSON.stringify([zenoIn.outcome, mirtaIn.outcome]));

  const z1 = await page(iphone);
  let z1Sends = 0;
  z1.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) z1Sends += 1;
  });
  await z1.goto(`${BASE}/${gCode}`);
  await z1.getByRole("button", { name: "Join this match" }).click();
  await z1.getByTestId("open-spot-name").first().fill("zeno");
  await z1.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
  const seatedAsk = z1.getByTestId("seated-ask");
  await seatedAsk.waitFor({ timeout: 20000 });
  check(
    "a browser that knows nobody types a seated player's name and taps Join: it is asked \"Zeno is in this match. Sign in as Zeno?\", and no second Zeno is made",
    ((await seatedAsk.innerText()) ?? "").includes("Zeno is in this match. Sign in as Zeno?") && (await recordsNamed("Zeno")) === 1,
    ((await seatedAsk.innerText()) ?? "").replace(/\s+/g, " "),
  );
  await shot(z1, "player-seated-ask");
  await seatedAsk.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await view(z1, "player-seated-ask-390");
  const thatsMe = seatedAsk.getByRole("button", { name: "That's me", exact: true });
  z1Sends = 0;
  await thatsMe.click();
  const sure = seatedAsk.getByRole("button", { name: "Sign in as Zeno?", exact: true });
  await sure.waitFor({ timeout: 10000 });
  check("the first tap asks again and sends nothing", z1Sends === 0, `sends=${z1Sends}`);
  await shot(z1, "player-seated-ask-armed");
  await seatedAsk.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await view(z1, "player-seated-ask-armed-390");
  await sure.click();
  await z1.locator("main li", { hasText: "Zeno" }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  check("the second tap signs that browser in as Zeno, and the database holds one Zeno", (await recordsNamed("Zeno")) === 1);

  // ------------------------------------------------- an address from a session by name proves itself first (the owner's decision of 16 October 2026, D3)
  // Zeno came in by name. The "Stay updated" card asks him for a channel, and an address he types is not
  // kept until the 6-digit code it was sent comes back: before, the next match email carried his personal
  // link, a permanent sign-in, to an address nobody had proved.
  const zCard = z1.getByTestId("stay-updated");
  await zCard.waitFor({ timeout: 20000 });
  if ((await zCard.getByTestId("stay-email").count()) > 0) await zCard.getByTestId("stay-email").click();
  check(
    "the card in a session by name says a code goes first, and its button sends the code",
    (await zCard.getByTestId("stay-code-first").count()) === 1 && (await zCard.getByRole("button", { name: "Send code", exact: true }).count()) === 1,
    ((await zCard.innerText()) ?? "").replace(/\s+/g, " "),
  );
  await zCard.getByPlaceholder("you@example.com").fill("zeno-e2e@example.com");
  await zCard.getByRole("button", { name: "Send code", exact: true }).click();
  const zCode = zCard.getByTestId("email-code");
  await zCode.waitFor({ timeout: 20000 });
  const zenoRow = async () => (await ask(`select email, email_verified_at is not null as proved from players where display_name = 'Zeno'`))[0] ?? {};
  check(
    "the address waits for its code: the box says where the code went, and the record holds no address yet",
    ((await zCode.innerText()) ?? "").includes("Code sent to zeno-e2e@example.com") && (await zenoRow()).email === null,
    JSON.stringify(await zenoRow()),
  );
  await shot(z1, "player-byname-code");
  await zCode.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await view(z1, "player-byname-code-390");
  const sentCode = await codeFor("zeno-e2e@example.com");
  check("the code went to the address, and nothing else did: no invitation before the code", /^\d{6}$/.test(sentCode) && mails().filter((m) => m.to === "zeno-e2e@example.com" && m.ics).length === 0, sentCode);
  await zCode.getByLabel("6-digit code").fill(sentCode);
  await zCode.getByRole("button", { name: "Confirm", exact: true }).click();
  await zCard.getByText("Calendar invite sent to zeno-e2e@example.com", { exact: false }).waitFor({ timeout: 20000 });
  check(
    "the right code keeps the address as proved, and the session is a full one: the invitation goes, and \"Send it again\" stands",
    (await zenoRow()).email === "zeno-e2e@example.com" && (await zenoRow()).proved === true && (await zCard.getByRole("button", { name: /Send it again/ }).count()) === 1,
    JSON.stringify(await zenoRow()),
  );
  await z1.close();

  // A record with an email: "That's me" refuses it, so the question carries its own doors.
  const m1 = await page(iphone);
  await m1.goto(`${BASE}/${gCode}`);
  // The closed line under the line-up stands before the form opens, so its absence below means something.
  const lineBefore = await m1.getByTestId("event-back-in-line").waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
  await m1.getByRole("button", { name: "Join this match" }).click();
  await m1.getByTestId("open-spot-name").first().fill("Mirta");
  // The fixed "Join this match" sends the open form, so it meets the same question.
  await m1.getByRole("button", { name: "Join this match" }).click();
  const mirtaAsk = m1.getByTestId("seated-ask");
  await mirtaAsk.waitFor({ timeout: 20000 });
  // The owner's decision of 16 October 2026 (D4): only the record's own doors. Mirta has an address and no
  // passkey and no Telegram, so the email code alone, and no Face ID.
  check(
    "a seated record with an email gets its own door under the question, the email code alone: no Face ID, no Telegram, no \"That's me\"",
    ((await mirtaAsk.innerText()) ?? "").includes("Mirta is in this match. Sign in as Mirta?") &&
      (await mirtaAsk.getByTestId("seated-door-email").count()) === 1 &&
      (await mirtaAsk.getByPlaceholder("you@example.com").isVisible()) &&
      (await mirtaAsk.getByTestId("passkey-signin").count()) === 0 &&
      (await mirtaAsk.getByTestId("seated-door-telegram").count()) === 0 &&
      (await mirtaAsk.getByRole("button", { name: "That's me", exact: true }).count()) === 0 &&
      (await recordsNamed("Mirta")) === 1,
    ((await mirtaAsk.innerText()) ?? "").replace(/\s+/g, " "),
  );
  check("the page's general \"Played before?\" steps aside while the question stands: the doors stand once, inside it", (await m1.getByTestId("back-in-open").count()) === 0 && (await m1.getByPlaceholder("you@example.com").count()) === 1);
  check("the closed \"Played before? Sign in\" line under the line-up stood before, and steps aside while the question stands", lineBefore && (await noBackInLine(m1)), `before=${lineBefore}`);
  await shot(m1, "player-seated-ask-email");
  await mirtaAsk.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await view(m1, "player-seated-ask-email-390");
  await m1.close();

  // Somebody else called Zeno says so, and joins as typed.
  const z2 = await page(iphone);
  await z2.goto(`${BASE}/${gCode}`);
  await z2.getByRole("button", { name: "Join this match" }).click();
  await z2.getByTestId("open-spot-name").first().fill("Zeno");
  await z2.getByTestId("open-spot-name").first().press("Enter");
  const z2Ask = z2.getByTestId("seated-ask");
  await z2Ask.waitFor({ timeout: 20000 });
  await z2Ask.getByRole("button", { name: "I'm a different Zeno", exact: true }).click();
  await z2.locator("main li", { hasText: "Zeno" }).getByText("you", { exact: true }).waitFor({ timeout: 20000 });
  const lineupZ = await fetch(`${BASE}/api/v1/matches/${gCode}`).then((r) => r.json());
  check("\"I'm a different Zeno\" joins a second Zeno, the name as typed", (await recordsNamed("Zeno")) === 2 && (lineupZ.players ?? []).filter((p) => p.name === "Zeno").length === 2, JSON.stringify((lineupZ.players ?? []).map((p) => p.name)));
  await z2.close();

  // ------------------------------------------------- a seated record with a linked Telegram: the Telegram door alone (D4)
  // Tola took her seat from the match's card in Telegram, so her record has a linked Telegram and no
  // address. A browser that knows nobody types "Tola": the question shows Telegram, and no email code
  // and no Face ID, which would open nothing of hers.
  const ivy = await keyed("/api/v1/matches", { startsAt: new Date(Date.now() + 29 * 60 * 60 * 1000).toISOString(), tz: "Europe/Madrid", venue: "Kata Padel Center", organizer: { name: "Ivy" } });
  const iCode = ivy.match?.code;
  // An id no other suite uses: the suites share one server, and telegram.mjs signs its Mini App user in by id.
  const tola = { id: 7_303_101, first_name: "Tola", language_code: "en" };
  const tolaIn = await telegramHook({ update_id: 91_001, callback_query: { id: "cb-tola", from: tola, message: { message_id: 991, date: 0, chat: { id: -1007303101, type: "supergroup", title: "e2e doors" } }, data: `j:${iCode}` } });
  check("Tola takes a seat from the match's card in Telegram", tolaIn.outcome === "join:joined", JSON.stringify(tolaIn));
  const tg = await page(iphone);
  await tg.goto(`${BASE}/${iCode}`);
  await tg.getByRole("button", { name: "Join this match" }).click();
  await tg.getByTestId("open-spot-name").first().fill("Tola");
  await tg.locator("main form").getByRole("button", { name: "Join", exact: true }).click();
  const tolaAsk = tg.getByTestId("seated-ask");
  await tolaAsk.waitFor({ timeout: 20000 });
  check(
    "a seated record with a linked Telegram gets the Telegram door alone: no email code, no Face ID, no \"That's me\", and no general help beside it",
    ((await tolaAsk.innerText()) ?? "").includes("Tola is in this match. Sign in as Tola?") &&
      (await tolaAsk.getByTestId("seated-door-telegram").count()) === 1 &&
      (await tolaAsk.getByTestId("seated-door-email").count()) === 0 &&
      (await tolaAsk.getByTestId("passkey-signin").count()) === 0 &&
      (await tolaAsk.getByRole("button", { name: "That's me", exact: true }).count()) === 0 &&
      (await tg.getByTestId("back-in-open").count()) === 0 &&
      (await noBackInLine(tg)) &&
      (await recordsNamed("Tola")) === 1,
    ((await tolaAsk.innerText()) ?? "").replace(/\s+/g, " "),
  );
  await shot(tg, "player-seated-ask-telegram");
  await tolaAsk.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await view(tg, "player-seated-ask-telegram-390");
  await tg.close();

  // ------------------------------------------------- a join request that waits gets the "Stay updated" card (D5)
  // Hana's match is for levels 4 to 5. Rafa, a 2.0, asks to join, and waits for her answer. The card now
  // asks him where the answer should reach him, and promises no calendar invitation, which only a seat brings.
  const hana = await keyed("/api/v1/matches", { startsAt: new Date(Date.now() + 32 * 60 * 60 * 1000).toISOString(), tz: "Europe/Madrid", venue: "Kata Padel Center", organizer: { name: "Hana" }, levelMin: 4, levelMax: 5 });
  const rafaAsk = await keyed(`/api/v1/matches/${hana.match?.code}/join`, { name: "Rafa", level: 2 });
  check("Rafa's join waits for the organiser", rafaAsk.outcome === "requested", JSON.stringify(rafaAsk).slice(0, 200));
  const rafa = await page(iphone);
  await rafa.goto(`${BASE}/p/${rafaAsk.player?.personalToken}/go?next=/${hana.match?.code}`);
  const rafaCard = rafa.getByTestId("stay-updated");
  await rafaCard.waitFor({ timeout: 20000 });
  const rafaText = ((await rafaCard.innerText()) ?? "").replace(/\s+/g, " ");
  check(
    "a player whose join request waits gets the card: the organiser's answer reaches them where they pick, and no word of a calendar",
    rafaText.includes("Stay updated") && rafaText.includes("The organiser's answer reaches you there.") && !/calendar/i.test(rafaText),
    rafaText,
  );
  await shot(rafa, "player-request-stay");
  await rafaCard.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await view(rafa, "player-request-stay-390");
  // He gives an address. The line after it promises only what a yes brings: the answer, and an invitation only with a seat.
  if (await rafaCard.getByTestId("stay-email").count()) await rafaCard.getByTestId("stay-email").click();
  await rafaCard.getByPlaceholder("you@example.com").fill("rafa-e2e@example.com");
  await rafaCard.getByRole("button", { name: "Save", exact: true }).click();
  const rafaSaved = await rafaCard.getByText("The organiser's answer reaches you there, and a seat brings the invitation.").waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
  check("after his address, the request's card says the answer reaches him there, and that only a seat brings the invitation", rafaSaved, ((await rafaCard.innerText()) ?? "").replace(/\s+/g, " "));
  await rafaCard.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await view(rafa, "player-request-stay-saved-390");
  await rafa.close();
} catch (e) {
  await crashed(browser, results, e, "player-states");
}

finish(results);
