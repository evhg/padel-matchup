// LINE: a signed webhook, a card into a room, and the two taps — proving this channel's own router
// reads what the card sends. `controls.mjs` proves no prefix is orphaned; it taps through Telegram,
// so it says nothing about whether LINE's postback handler exists. This does.
import { createHmac } from "node:crypto";
import { BASE, crashed, finish, iphone, launch, makeCheck } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);
const SECRET = process.env.LINE_CHANNEL_SECRET || "e2e-line-secret";

const sign = (body) => createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
const hook = async (payload, signature) => {
  const body = JSON.stringify(payload);
  const res = await fetch(`${BASE}/api/line/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": signature ?? sign(body) },
    body,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const ROOM = { type: "group", groupId: "Ce2egroup1", userId: "Ue2euser1" };
const evt = (over) => ({ events: [{ source: ROOM, replyToken: `tok-${Math.random().toString(36).slice(2)}`, ...over }] });

try {
  // A match to card, made the way a person makes one.
  const page = await (await browser.newContext(iphone)).newPage();
  const made = await page.request.post(`${BASE}/api/v1/matches`, {
    data: { startsAt: new Date(Date.now() + 36 * 3600 * 1000).toISOString(), tz: "Asia/Bangkok", venue: "Rawai Padel", organizer: { name: "Nok" } },
  });
  const code = (await made.json())?.match?.code;
  check("a match exists for the LINE checks", Boolean(code), String(code));

  const unsigned = await hook(evt({ type: "join" }), "not-the-signature");
  check("an unsigned delivery is refused, because this endpoint is public", unsigned.status === 403, String(unsigned.status));

  const joined = await hook(evt({ type: "join" }));
  check("the bot remembers a room it was added to", joined.json?.outcome === "line:joined", JSON.stringify(joined.json));

  const pasted = await hook(evt({ type: "message", message: { id: "1", type: "text", text: `come play ${BASE}/${code}` } }));
  check("a pasted match link becomes the card in that room", pasted.json?.outcome === `line:card:${code}`, JSON.stringify(pasted.json));

  const tapIn = await hook(evt({ type: "postback", postback: { data: `j:${code}` } }));
  check("the I'm in tap is read by LINE's own router, not only Telegram's", tapIn.json?.outcome === "line:join", JSON.stringify(tapIn.json));

  const tapOut = await hook(evt({ type: "postback", postback: { data: `l:${code}` } }));
  check("and so is the one that gives the spot back", tapOut.json?.outcome === "line:leave", JSON.stringify(tapOut.json));

  const nonsense = await hook(evt({ type: "postback", postback: { data: "zz:nope" } }));
  check("a postback nobody sends is answered rather than crashing", nonsense.json?.outcome === "line:postback_unknown", JSON.stringify(nonsense.json));

  const left = await hook(evt({ type: "leave" }));
  check("a room the bot is removed from stops being one cards go to", left.json?.outcome === "line:left", JSON.stringify(left.json));

  await page.close();
} catch (e) {
  await crashed(browser, results, e, "line");
}

finish(results);
