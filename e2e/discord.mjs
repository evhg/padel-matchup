// Discord: signed interactions (401 otherwise), PING, /match and the join button through the shared flow
// with an unreachable Discord API, /new ticket, setup route protection.
import { createPrivateKey, sign } from "node:crypto";
import { BASE, finish, iphone, launch, makeCheck } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);
// Test-only key pair: the public half is DISCORD_PUBLIC_KEY in run.mjs. Never used anywhere else.
const PRIV_HEX = process.env.E2E_DISCORD_PRIVATE_KEY || "df9ff2543bd8bcdce5a8978e1a841063fa8f8f3ca35c6abca873f0370c5705b7";
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(PRIV_HEX, "hex")]), format: "der", type: "pkcs8" });
const APP = "1545988138055237723";
const GUILD = "1545987795863085087";
const CHANNEL = "1545987795863085090";

const interact = async (payload, o = {}) => {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = o.badSignature ? "00".repeat(64) : sign(null, Buffer.from(ts + body), privateKey).toString("hex");
  const headers = { "content-type": "application/json" };
  if (!o.noHeaders) Object.assign(headers, { "x-signature-ed25519": sig, "x-signature-timestamp": ts });
  const res = await fetch(`${BASE}/api/discord/interactions`, { method: "POST", headers, body });
  return { status: res.status, outcome: res.headers.get("x-kicksmash-outcome"), json: await res.json().catch(() => null) };
};
const user = (id, name) => ({ id: String(id), username: name.toLowerCase(), global_name: name });
const command = (name, from, options = {}) => ({ id: "1", application_id: APP, type: 2, token: "t", guild_id: GUILD, channel_id: CHANNEL, channel: { id: CHANNEL, type: 0, name: "padel" }, member: { user: from }, locale: "en-US", data: { name, options: Object.entries(options).map(([k, v]) => ({ name: k, type: 3, value: v })) } });
const button = (customId, from, messageId) => ({ id: "2", application_id: APP, type: 3, token: "t", guild_id: GUILD, channel_id: CHANNEL, member: { user: from }, message: { id: messageId, channel_id: CHANNEL }, data: { custom_id: customId, component_type: 2 } });
const ivan = user(424242, "Ivan");

try {
  check("interaction without a signature is refused", (await interact({ type: 1 }, { noHeaders: true })).status === 401);
  check("interaction with a bad signature is refused", (await interact({ type: 1 }, { badSignature: true })).status === 401);
  const ping = await interact({ type: 1 });
  check("PING answers PONG", ping.status === 200 && ping.json?.type === 1, JSON.stringify(ping.json));
  const created = await fetch(`${BASE}/api/v1/matches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ startsAt: new Date(Date.now() + 5 * 3600 * 1000).toISOString(), tz: "Asia/Bangkok", venue: "Rawai Padel Club", organizer: { name: "Kai" } }) }).then((r) => r.json());
  const code = created.match.code;
  const posted = await interact(command("match", ivan, { code }));
  check("/match CODE is handled (the Discord API is unreachable here, so the card cannot be posted)", posted.status === 200 && posted.outcome === "card_failed" && posted.json?.data?.flags === 64, `${posted.outcome} ${JSON.stringify(posted.json)}`);
  const tap = await interact(button(`j:${code}`, ivan, "999"));
  check("a tap on the card joins through the shared flow and answers with the updated card", tap.outcome === "join:joined" && tap.json?.type === 7 && JSON.stringify(tap.json).includes("Players 2/4"), `${tap.outcome} ${JSON.stringify(tap.json).slice(0, 200)}`);
  const pub = await fetch(`${BASE}/api/v1/matches/${code}`).then((r) => r.json());
  check("the Discord user is on the roster with their display name", pub.players.some((p) => p.name === "Ivan"), JSON.stringify(pub.players));
  const again = await interact(button(`j:${code}`, ivan, "999"));
  check("second tap: already in, privately", again.outcome === "join:already_in" && again.json?.data?.flags === 64);
  const left = await interact(button(`l:${code}`, ivan, "999"));
  check("leave tap works", left.outcome === "leave:left" && left.json?.type === 7);
  const fresh = await interact(command("new", ivan));
  const url = fresh.json?.data?.components?.[0]?.components?.[0]?.url ?? "";
  check("/new hands out a create link bound to the channel", fresh.outcome === "new" && /[?&]dc=\d+\.\d+\.[0-9a-f]{20}/.test(url), url);
  const unknown = await interact(command("match", ivan, { code: "ZZZZ" }));
  check("unknown code: a private note", unknown.outcome === "match_unknown" && unknown.json?.data?.flags === 64);
  const setup = await fetch(`${BASE}/api/discord/setup`);
  check("setup route needs the cron secret", setup.status === 401);

  const ctx = await browser.newContext(iphone);
  const page = await ctx.newPage();
  await page.goto(url.replace(/^https?:\/\/[^/]+/, BASE));
  check("the create link opens the form", (await page.getByPlaceholder("e.g. Alex").count()) === 1);
} finally {
  await browser.close();
}
finish(results);
