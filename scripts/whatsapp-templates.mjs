#!/usr/bin/env node
// The WhatsApp message templates, from data/whatsapp-templates.json to Meta's review queue.
//
//   node scripts/whatsapp-templates.mjs --list                 what Meta holds: name, language, status, category
//   node scripts/whatsapp-templates.mjs --create               what would be created (a dry run: nothing is sent)
//   node scripts/whatsapp-templates.mjs --create --yes         create every template and language Meta does not hold yet
//
// Options for --create:
//   --base https://kicksma.sh     the address the URL buttons open (the default); a template is fixed once Meta approves it
//   --header-handle <h>           the sample picture for ks_match_result, from Meta's upload API
//   --sample <file.png> --app-id <id>   upload that picture first and use its handle (needs the Meta app's id)
//
// Environment: WHATSAPP_WABA_ID (the WhatsApp Business Account id, not the phone id) and WHATSAPP_TOKEN.
// The token goes in a header and is never printed. A template Meta already holds in a language, in any
// status, is left alone: an edit to an approved template is a new review, and that is a decision for
// WhatsApp Manager, not for a script run twice.
//
// Meta may move a UTILITY template to MARKETING when it reads the text as promotion. --list shows the
// category Meta gave; a marketing template is charged in every window (docs/OPERATING.md).
import { readFileSync } from "node:fs";

const API = "https://graph.facebook.com/v21.0";
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};

if (!flag("--list") && !flag("--create")) {
  console.error("usage: node scripts/whatsapp-templates.mjs --list | --create [--yes] [--base <url>] [--header-handle <h> | --sample <file> --app-id <id>]");
  process.exit(1);
}

const catalogue = JSON.parse(readFileSync(new URL("../data/whatsapp-templates.json", import.meta.url), "utf8"));
const waba = process.env.WHATSAPP_WABA_ID ?? "";
const token = process.env.WHATSAPP_TOKEN ?? "";
const auth = { authorization: `Bearer ${token}` };

/** Meta's error, in its own words, without the request that carried the token. */
async function answer(res) {
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Meta answered ${res.status}: ${json?.error?.message ?? "no message"}${json?.error?.error_user_msg ? ` (${json.error.error_user_msg})` : ""}`);
  return json;
}

async function held() {
  const out = [];
  let url = `${API}/${waba}/message_templates?fields=name,language,status,category&limit=100`;
  while (url) {
    const page = await answer(await fetch(url, { headers: auth }));
    out.push(...(page.data ?? []));
    url = page.paging?.next ?? null;
  }
  return out;
}

if (flag("--list")) {
  if (!waba || !token) {
    console.error("✗ set WHATSAPP_WABA_ID and WHATSAPP_TOKEN to read what Meta holds");
    process.exit(1);
  }
  const rows = await held();
  for (const t of rows.sort((a, b) => `${a.name}${a.language}`.localeCompare(`${b.name}${b.language}`))) console.log(`${t.name.padEnd(20)} ${t.language.padEnd(6)} ${t.status.padEnd(10)} ${t.category}`);
  const ours = new Set(catalogue.templates.flatMap((t) => Object.keys(t.languages).map((l) => `${t.name}/${l}`)));
  const missing = [...ours].filter((k) => !rows.some((r) => `${r.name}/${r.language}` === k));
  console.log(missing.length ? `\nnot created yet: ${missing.join(", ")}` : "\nevery template in data/whatsapp-templates.json is there");
  process.exit(0);
}

// --create
const base = (option("--base") ?? "https://kicksma.sh").replace(/\/+$/, "");
if (!/^https:\/\//.test(base)) {
  console.error("✗ --base must be an https address: Meta opens it on the player's phone");
  process.exit(1);
}
const send = flag("--yes");
if (send && (!waba || !token)) {
  console.error("✗ set WHATSAPP_WABA_ID and WHATSAPP_TOKEN before --create --yes");
  process.exit(1);
}

/** Meta's resumable upload: a session on the app, then the bytes, then a handle a template's example can name. */
async function uploadSample(file, appId) {
  const bytes = readFileSync(file);
  const type = file.endsWith(".jpg") || file.endsWith(".jpeg") ? "image/jpeg" : "image/png";
  const session = await answer(await fetch(`${API}/${appId}/uploads?file_name=${encodeURIComponent(file.split("/").pop())}&file_length=${bytes.length}&file_type=${type}`, { method: "POST", headers: auth }));
  const done = await answer(await fetch(`${API}/${session.id}`, { method: "POST", headers: { authorization: `OAuth ${token}`, file_offset: "0" }, body: bytes }));
  return done.h;
}

let handle = option("--header-handle");
const sample = option("--sample");
if (!handle && sample && send) {
  const appId = option("--app-id");
  if (!appId) {
    console.error("✗ --sample needs --app-id, the Meta app the upload belongs to");
    process.exit(1);
  }
  handle = await uploadSample(sample, appId);
  console.log(`uploaded ${sample}`);
}

/** What Meta's create call takes for one template in one language. */
function createBody(t, language) {
  const lang = t.languages[language];
  const components = [];
  if (t.header === "IMAGE") components.push({ type: "HEADER", format: "IMAGE", example: { header_handle: [handle ?? "<a handle: --header-handle, or --sample with --app-id>"] } });
  components.push({ type: "BODY", text: lang.body, example: { body_text: [lang.example] } });
  const buttons = t.buttons.map((b, i) => (b.type === "QUICK_REPLY" ? { type: "QUICK_REPLY", text: lang.buttons[i] } : { type: "URL", text: lang.buttons[i], url: b.url.replace("{base}", base), example: [`${base}/${b.example}`] }));
  if (buttons.length) components.push({ type: "BUTTONS", buttons });
  return { name: t.name, language, category: t.category, components };
}

const existing = waba && token ? await held() : null;
if (!existing) console.log("· WHATSAPP_WABA_ID or WHATSAPP_TOKEN is not set, so every template is shown as missing");
let created = 0;
let failed = 0;
for (const t of catalogue.templates) {
  for (const language of Object.keys(t.languages)) {
    const there = existing?.find((r) => r.name === t.name && r.language === language);
    if (there) {
      console.log(`· ${t.name}/${language}: already there (${there.status}, ${there.category})`);
      continue;
    }
    const body = createBody(t, language);
    if (!send) {
      console.log(`would create ${t.name}/${language}:\n${JSON.stringify(body, null, 2)}\n`);
      continue;
    }
    if (t.header === "IMAGE" && !handle) {
      console.log(`✗ ${t.name}/${language}: skipped, the picture header needs --header-handle, or --sample with --app-id (or create it in WhatsApp Manager)`);
      failed++;
      continue;
    }
    try {
      const res = await answer(await fetch(`${API}/${waba}/message_templates`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }));
      console.log(`✓ ${t.name}/${language}: sent for review (${res.status ?? "PENDING"}, ${res.category ?? t.category})`);
      created++;
    } catch (e) {
      console.log(`✗ ${t.name}/${language}: ${e.message}`);
      failed++;
    }
  }
}
if (!send) console.log("A dry run: nothing was sent. Add --yes to create these.");
else console.log(`${created} sent for review, ${failed} not`);
process.exit(failed ? 1 : 0);
