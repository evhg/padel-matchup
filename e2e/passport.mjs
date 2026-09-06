// Passport: the public page switch on My matches, the profile page, the signed level verified against the
// well-known key, the data export without secrets, the level import from another scale, and the scales table.
import { BASE, finish, iphone, launch, makeCheck, shot } from "./lib.mjs";

const browser = await launch();
const results = [];
const check = makeCheck(results);
const PUB = process.env.PASSPORT_PUBLIC_KEY || "041adb0508a2d16a6e97203251a2a85ce6e30c2fa2ec6498fc1ddec242265447";

const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v));
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
async function verify(doc, pubHex) {
  const { alg, sig, ...rest } = doc;
  if (alg !== "Ed25519") return false;
  const x = b64u(Uint8Array.from(pubHex.match(/.{2}/g).map((h) => parseInt(h, 16))));
  const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x }, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, fromB64u(sig), new TextEncoder().encode(canonical(rest)));
}

try {
  const ctx = await browser.newContext(iphone);
  const page = await ctx.newPage();
  // An identity: create a match as Tia.
  await page.goto(`${BASE}/`);
  await page.getByPlaceholder("e.g. Alex").fill("Tia");
  await page.getByRole("button", { name: "Create & get the link" }).click();
  await page.waitForURL(/\/[^/]{4}\/share$/, { timeout: 30000 });

  await page.goto(`${BASE}/me`);
  check("My matches carries the passport card, off by default", (await page.getByText("Passport").count()) >= 1 && (await page.getByText(/Public page · off/).count()) === 1);
  await page.getByLabel(/Public page/).check();
  await page.getByText(/kicksma\.sh\/u\/|localhost:3001\/u\//).waitFor({ timeout: 15000 });
  const link = (await page.getByRole("link", { name: /\/u\// }).first().getAttribute("href")) ?? "";
  const slug = link.split("/u/")[1];
  check("switching the page on mints a slug", /^[a-z0-9]+-[a-z0-9]{5}$/.test(slug ?? ""), link);
  await shot(page, "p1-passport-on");

  const signedHref = await page.getByRole("link", { name: /Signed level/ }).getAttribute("href");
  check("Signed level on My matches opens the readable page, not the JSON", signedHref === `${link}/passport`, signedHref);
  const profile = await fetch(`${BASE}/u/${slug}`);
  const html = await profile.text();
  check("the public page shows the first name and the stats strip", profile.status === 200 && html.includes("Tia") && html.includes("Played"));
  check("the public page links people to the readable signed level", html.includes(`href="/u/${slug}/passport"`) && !html.includes(`href="/u/${slug}/passport.json"`));
  await page.goto(`${BASE}/u/${slug}/passport`);
  check("the readable passport says whose level it is and that the signature checks out", (await page.getByRole("heading", { name: "Tia" }).count()) === 1 && (await page.getByText(/Signature checks out \(key [0-9a-f]{8}\)/).count()) === 1 && (await page.getByText("No level yet").count()) === 1);
  check("the JSON is one tap away and the document is folded", (await page.getByRole("link", { name: "Open JSON" }).getAttribute("href")) === `${link}/passport.json` && (await page.locator("details pre").isVisible()) === false);
  await page.getByText("Show the document").click();
  check("unfolded, the document is the signed JSON", (await page.locator("details pre").innerText()).includes('"alg": "Ed25519"'));
  await shot(page, "p2-passport-doc");
  const doc = await fetch(`${BASE}/u/${slug}/passport.json`).then((r) => r.json());
  check("the passport is signed and names the player", doc.alg === "Ed25519" && doc.name === "Tia" && typeof doc.sig === "string" && doc.sub.endsWith(`/u/${slug}`), JSON.stringify(doc).slice(0, 200));
  const wk = await fetch(`${BASE}/.well-known/kicksmash-passport.json`).then((r) => r.json());
  check("the well-known document publishes the key", wk.keys?.[0]?.hex === PUB && wk.keys[0].kid === doc.kid);
  check("the signature verifies with WebCrypto and fails when tampered", (await verify(doc, wk.keys[0].hex)) === true && (await verify({ ...doc, level: 6.5 }, wk.keys[0].hex)) === false);

  const exportRes = await page.request.get(`${BASE}/api/me/export`);
  const exportText = await exportRes.text();
  const exported = JSON.parse(exportText);
  check("the export is one JSON file about the signed-in player", exportRes.status() === 200 && exported.format === "kicksmash-export/1" && exported.player.displayName === "Tia" && Array.isArray(exported.matches.upcoming) && exported.matches.upcoming.length === 1);
  check("the export carries no tokens or manage links", !exportText.includes("personalToken") && !exportText.includes("/manage/") && !exportText.includes("manageCode"));
  const anon = await fetch(`${BASE}/api/me/export`);
  check("the export needs a signed-in player", anon.status === 401);

  // Level import from a 1–10 scale.
  await page.goto(`${BASE}/me`);
  await page.getByRole("button", { name: "Set my level" }).click();
  await page.getByRole("button", { name: "Have a level in another app?" }).click();
  await page.getByLabel("Scale").selectOption("ten");
  await page.getByLabel("Your number").fill("10");
  check("the mapping is shown before anything is saved", (await page.getByText(/→ 7\.0/).count()) === 1);
  await page.getByRole("button", { name: "Use 7.0" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("7.0").first().waitFor({ timeout: 15000 });
  const afterImport = await page.request.get(`${BASE}/api/me/export`).then((r) => r.json());
  check("the imported level is saved as the player's level", afterImport.player.level === 7);
  const doc2 = await fetch(`${BASE}/u/${slug}/passport.json`).then((r) => r.json());
  check("the passport follows the level", doc2.level === 7 && doc2.band === "pro" && (await verify(doc2, PUB)) === true);

  await page.goto(`${BASE}/levels`);
  check("/levels shows the scales table", (await page.getByText("Other apps' scales").count()) === 1 && (await page.getByText("1 to 10 (club systems)").count()) === 1);

  await page.goto(`${BASE}/me`);
  await page.getByLabel(/Public page/).uncheck();
  await page.getByText(/Public page · off/).waitFor({ timeout: 15000 });
  const gone = await fetch(`${BASE}/u/${slug}`);
  const goneDoc = await fetch(`${BASE}/u/${slug}/passport.json`);
  const goneDocPage = await fetch(`${BASE}/u/${slug}/passport`);
  check("switching the page off makes the page, the passport and its readable version 404", gone.status === 404 && goneDoc.status === 404 && goneDocPage.status === 404);
} finally {
  await browser.close();
}
finish(results);
