// Telegram: webhook secret, quiet update handling with an unreachable Bot API, /new ticket → card row,
// login callback rejects forged data, My matches shows the Telegram sign-in.
import { BASE, finish, iphone, launch, makeCheck } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "e2e-tg-secret";
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
  const created = await fetch(`${BASE}/api/v1/matches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ startsAt: new Date(Date.now() + 5 * 3600 * 1000).toISOString(), tz: "Asia/Bangkok", venue: "Rawai Padel Club", organizer: { name: "Kai" } }) }).then((r) => r.json());
  const code = created.match.code;
  const posted = await hook({ update_id: 4, message: { message_id: 2, date: 0, chat: group, from: ivan, text: `/match ${code}` } });
  check("/match CODE is handled as a card", posted.json?.outcome === "card", JSON.stringify(posted.json));
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
  const page = await ctx.newPage();
  await page.goto(`${BASE}/me`);
  check("signed-out My matches offers Telegram sign-in", (await page.getByText("Sign in with Telegram").count()) + (await page.getByText("Telegram", { exact: true }).count()) > 0);
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
