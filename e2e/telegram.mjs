// Telegram: webhook secret, quiet update handling with an unreachable Bot API, /new ticket → card row,
// login callback rejects forged data, My matches shows the Telegram sign-in, and the way back from
// Telegram (signed fields in the hash) signs the player in, in the same tab.
import { createHash, createHmac } from "node:crypto";
import { BASE, finish, iphone, launch, makeCheck } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "e2e-tg-secret";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "1:e2e-fake-token";
// What Telegram puts in the hash of return_to: the user's fields, signed with sha256(bot token).
const authResultHash = (user) => {
  const fields = { ...user, auth_date: Math.floor(Date.now() / 1000) };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  fields.hash = createHmac("sha256", createHash("sha256").update(BOT_TOKEN).digest()).update(check).digest("hex");
  return Buffer.from(JSON.stringify(fields), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const hook = async (update, secret = SECRET) => {
  const res = await fetch(`${BASE}/api/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) }, body: JSON.stringify(update) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const group = { id: -100424242, type: "supergroup", title: "e2e padel" };
const ivan = { id: 424242, first_name: "Ivan", username: "ivan_e2e", language_code: "ru" };

try {
  check("webhook without the secret is refused", (await hook({ update_id: 1 }, null)).status === 403);
  check("webhook with a wrong secret is refused", (await hook({ update_id: 1 }, "nope")).status === 403);
  const added = await hook({ update_id: 2, my_chat_member: { chat: group, from: ivan, old_chat_member: { status: "left" }, new_chat_member: { status: "member" } } });
  check("bot added to a chat: 200 and a welcome (even if Telegram is unreachable here)", added.status === 200 && added.json?.outcome === "welcome", JSON.stringify(added.json));
  const chatter = await hook({ update_id: 3, message: { message_id: 1, date: 0, chat: group, from: ivan, text: "who is playing tonight?" } });
  check("ordinary chatter is ignored", chatter.json?.outcome === "ignored");
  const created = await fetch(`${BASE}/api/v1/matches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ startsAt: new Date(Date.now() + 5 * 3600 * 1000).toISOString(), tz: "Asia/Bangkok", venue: "Rawai Padel Club", organizer: { name: "Kai" }, cost: "400 THB" }) }).then((r) => r.json());
  const code = created.match.code;
  check("the API accepts and returns the cost per player", created.match.cost === "400 THB", JSON.stringify(created.match).slice(0, 200));
  const posted = await hook({ update_id: 4, message: { message_id: 2, date: 0, chat: group, from: ivan, text: `/match ${code}` } });
  check("/match CODE is handled as a card", posted.json?.outcome === "card", JSON.stringify(posted.json));
  const matchHtml = await fetch(`${BASE}/${code}`).then((r) => r.text());
  check("the match page shows the money line", matchHtml.includes("400 THB per player"));
  const tap = await hook({ update_id: 5, callback_query: { id: "cb1", from: ivan, message: { message_id: 999, date: 0, chat: group }, data: `j:${code}` } });
  check("a tap on the card joins through the shared flow", tap.json?.outcome === "join:joined", JSON.stringify(tap.json));
  const pub = await fetch(`${BASE}/api/v1/matches/${code}`).then((r) => r.json());
  check("the Telegram user is on the roster with their first name", pub.players.some((p) => p.name === "Ivan"), JSON.stringify(pub.players));
  const again = await hook({ update_id: 6, callback_query: { id: "cb2", from: ivan, message: { message_id: 999, date: 0, chat: group }, data: `j:${code}` } });
  check("second tap: already in", again.json?.outcome === "join:already_in");
  const left = await hook({ update_id: 7, callback_query: { id: "cb3", from: ivan, message: { message_id: 999, date: 0, chat: group }, data: `l:${code}` } });
  check("leave tap works", left.json?.outcome === "leave:left");
  const priv = await hook({ update_id: 8, message: { message_id: 3, date: 0, chat: { id: 424242, type: "private" }, from: ivan, text: "/start" } });
  check("private /start is answered with the personal link", priv.json?.outcome === "private_start");
  const login = await fetch(`${BASE}/api/telegram/login?id=1&first_name=Eve&auth_date=${Math.floor(Date.now() / 1000)}&hash=00`, { redirect: "manual" });
  check("forged login redirects to /me?telegram=invalid", login.status >= 300 && login.status < 400 && /\/me\?telegram=invalid$/.test(login.headers.get("location") ?? ""), login.headers.get("location"));
  const setup = await fetch(`${BASE}/api/telegram/setup`);
  check("setup route needs the cron secret", setup.status === 401);

  const ctx = await browser.newContext(iphone);
  let page = await ctx.newPage();
  await page.goto(`${BASE}/me`);
  check("signed-out My matches offers Telegram sign-in as a plain button, no widget iframe", (await page.getByRole("button", { name: "Sign in with Telegram" }).count()) === 1 && (await page.locator("iframe").count()) === 0);

  // Back from Telegram in the same tab: the hash carries the signed fields, the page hands them to the login route.
  const olya = { id: 515151, first_name: "Оля", username: "olya_e2e" };
  await page.goto("about:blank");
  await page.goto(`${BASE}/me#tgAuthResult=${authResultHash(olya)}`);
  await page.waitForURL(/\/me\?telegram=linked$/, { timeout: 30000 });
  check("the player is signed in and told so, on the same page", (await page.getByText("Telegram linked. Your matches from the bot are here now.").count()) === 1 && (await page.getByText("Linked: @olya_e2e").count()) === 1);
  const exported = await page.request.get(`${BASE}/api/me/export`).then((r) => r.json());
  check("the session belongs to the Telegram user", exported.player?.displayName === "Оля");
  const forgedCtx = await browser.newContext(iphone);
  const forged = await forgedCtx.newPage();
  const bad = authResultHash(olya).replace(/^./, (c) => (c === "A" ? "B" : "A"));
  await forged.goto(`${BASE}/me#tgAuthResult=${bad}`);
  await forged.waitForTimeout(1500);
  check("a tampered hash never signs anyone in", !/telegram=linked/.test(forged.url()) && (await forged.getByRole("button", { name: "Sign in with Telegram" }).count()) === 1, forged.url());
  await forgedCtx.close();
  await ctx.close();

  const ctx2 = await browser.newContext(iphone);
  page = await ctx2.newPage();
  await page.goto(`${BASE}/`);
  await page.getByPlaceholder("e.g. Alex").fill("Tia");
  await page.getByRole("button", { name: "Create & get the link" }).click();
  await page.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });
  await page.goto(`${BASE}/me`);
  check("signed-in My matches shows the Telegram row", (await page.getByText("Telegram", { exact: true }).count()) === 1 && (await page.getByText(/Sign in with Telegram on any device/).count()) === 1);
} finally {
  await browser.close();
}
finish(results);
