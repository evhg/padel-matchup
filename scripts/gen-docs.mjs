#!/usr/bin/env node
// The environment table, written from the code that reads it.
//
//   node scripts/gen-docs.mjs           rewrite the table in README.md and .env.example
//   node scripts/gen-docs.mjs --check   fail when either file is out of date (tests/docs.test.ts runs this)
//
// Every `process.env.X` in src/ and scripts/ must appear below, either as a row of the table or in
// IGNORED with the reason it is not configuration. A new variable therefore fails the check until
// somebody says what it is for, which is the whole point: the table cannot fall behind the code.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** Variables that are not configuration: the platform sets them, or only a test or a local run does. */
const IGNORED = {
  NODE_ENV: "set by Next.js and the test runner",
  VERCEL: "set by Vercel",
  VERCEL_URL: "set by Vercel",
  VERCEL_PROJECT_PRODUCTION_URL: "set by Vercel",
  BASE: "the browser suites pass the server's own URL to each suite",
  E2E_DISCORD_PRIVATE_KEY: "the Discord browser suite signs its own interactions",
  E2E_ONLY: "run one browser suite",
  E2E_PORT: "the port the browser suites boot on",
  E2E_SHARD: "CI splits the browser suites over two jobs",
  E2E_VERBOSE: "print the test server's output",
  EMAIL_SINK_FILE: "the browser suites read the mail the app would have sent",
  PGLITE_DATA_DIR: "where the embedded database lives; a temporary directory per test file",
  PW_CHROMIUM: "use a Chromium that is already installed",
  SHOTS: "keep the browser suites' screenshots",
};

/** The table, in the order it is written. `req`: "yes", "recommended", or how it is optional. */
const VARS = [
  ["DATABASE_URL", "yes", 'Supabase **Transaction pooler** string (port 6543), exactly as Supabase\'s Connect dialog shows it. `POSTGRES_URL` (the Vercel ⇄ Supabase integration) and `SUPABASE_DB_URL` work too. Empty → the embedded PGlite database, for local development only.'],
  ["DATABASE_PASSWORD", "if the URL still says `[YOUR-PASSWORD]`", "Substituted into the URL and percent-encoded for you."],
  ["DIRECT_DATABASE_URL", "no", "Direct (port 5432) URL for `pnpm db:migrate` and `pnpm db:generate`. `POSTGRES_URL_NON_POOLING` works too."],
  ["AUTO_MIGRATE", "no", "`false` stops the app applying migrations on its first connection. That safety net is for a fresh database only: production gets each migration by hand (AGENTS.md rule 7)."],
  ["APP_BASE_URL", "no", "Defaults to the Vercel production domain. Set it locally and on other hosts. `NEXT_PUBLIC_APP_BASE_URL` is the browser's copy of the same value."],
  ["SESSION_SECRET", "recommended", "Signs the identity cookie. Without it a stable secret is derived from the database URL."],
  ["CRON_SECRET", "recommended", "Protects `/api/cron/*` and the one-off setup routes. Vercel sends it automatically when set."],
  ["RESEND_API_KEY", "no", "Enables every email: calendar invitations, notifications, reminders."],
  ["EMAIL_FROM", "no", "Defaults to `Kicksmash <matches@<your domain>>`; the domain must be verified in Resend."],
  ["RESEND_WEBHOOK_SECRET", "no", "Verifies Resend's inbound webhook, so a reply to `feedback@` or `claude@` becomes a note."],
  ["OUTREACH_FROM", "no", "The From line on outreach mail. Defaults to `Claude at Kicksmash <claude@<your domain>>`."],
  ["VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT", "no", "Enables push reminders (`npx web-push generate-vapid-keys`)."],
  ["TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` / `TELEGRAM_BOT_USERNAME", "no", "Enables the Telegram bot and Telegram sign-in. Register the webhook once with `GET /api/telegram/setup` (Bearer `CRON_SECRET`)."],
  ["TELEGRAM_MINIAPP_SLUG", "no", "The Mini App's short name, so cards can carry a direct link into it."],
  ["TELEGRAM_OWNER_ID", "no", "The owner's Telegram id: proposals, club claims and drafts go there for a one-tap answer, and the admin desks open for that account only."],
  ["DISCORD_BOT_TOKEN` / `DISCORD_PUBLIC_KEY", "no", "Enables the Discord bot. Register the commands and the interactions URL once with `GET /api/discord/setup` (Bearer `CRON_SECRET`); it returns the install link. `DISCORD_APPLICATION_ID` is read from the token unless set; `DISCORD_INVITE_URL` shows the server on the community pages."],
  ["PASSPORT_PRIVATE_KEY` / `PASSPORT_PUBLIC_KEY", "no", "Ed25519 pair (raw 32-byte hex each) that signs player passports. Without them a passport carries `alg: \"none\"`."],
  ["ANTHROPIC_API_KEY", "no", "Drafts the replies on the listening desk and the proposal the owner receives for a note. `LISTEN_MODEL` overrides the model; `ANTHROPIC_MONTHLY_CAP_USD` (default 20) is the ceiling the app keeps itself under; `ANTHROPIC_ADMIN_KEY` lets the service board read the real spend."],
  ["TAVILY_API_KEY", "no", "The research desk: clubs and coaches per city, and grounding for answer pages."],
  ["REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` / `REDDIT_USERNAME` / `REDDIT_PASSWORD", "no", "Lets an approved reply be posted on Reddit as the project's account. Without them, Approve means copy and paste."],
  ["GOOGLE_SERVICE_ACCOUNT_JSON", "no", "A service account with Search Console access, so the service board can read impressions and clicks."],
  ["INDEXNOW_KEY", "no", "Tells Bing and Yandex a page changed, the moment it changes."],
  ["BACKUP_GITHUB_TOKEN` / `BACKUP_GITHUB_REPO", "no", "The nightly database snapshot is committed to that repository."],
  ["UPTIME_REPO", "no", "`owner/repo` of the GitHub Actions uptime probe, so the service board can read its open incidents."],
  ["OPERATOR_VERCEL_TEAM` / `OPERATOR_VERCEL_PROJECT", "no", "Names the Vercel project, so a missing key can be reported with the link that sets it."],
];

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".next", ".git", "dist"].includes(e.name)) continue;
      out.push(...walk(p));
    } else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const read = new Set();
for (const dir of ["src", "scripts", "e2e"]) {
  const d = path.join(root, dir);
  if (!statSync(d, { throwIfNoEntry: false })?.isDirectory()) continue;
  for (const f of walk(d)) {
    if (f.endsWith("gen-docs.mjs")) continue;
    for (const m of readFileSync(f, "utf8").matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) read.add(m[1]);
  }
}

// Names the table covers, including the ones sharing a row.
const covered = new Set(VARS.flatMap(([name]) => name.split("` / `")));
for (const [, , purpose] of VARS) for (const m of purpose.matchAll(/`([A-Z_][A-Z0-9_]{3,})`/g)) covered.add(m[1]);

const undocumented = [...read].filter((v) => !covered.has(v) && !(v in IGNORED)).sort();
const stale = [...covered].filter((v) => !read.has(v)).sort();
const problems = [];
if (undocumented.length) problems.push(`read in the code but not in the table or IGNORED: ${undocumented.join(", ")}`);
if (stale.length) problems.push(`in the table but read nowhere: ${stale.join(", ")}`);
if (problems.length) {
  console.error("✗ scripts/gen-docs.mjs is out of step with the code:\n  " + problems.join("\n  ") + "\n\nAdd each one to VARS (a row of the table) or to IGNORED (with the reason it is not configuration).");
  process.exit(1);
}

const table = [
  "| Variable | Required | Purpose |",
  "| --- | --- | --- |",
  ...VARS.map(([name, req, purpose]) => `| \`${name}\` | ${req === "yes" ? "✅" : req} | ${purpose} |`),
].join("\n");

const example = [
  "# Kicksmash configuration. Written by scripts/gen-docs.mjs; every variable the code reads is here.",
  "# Nothing below is required for local development: with no DATABASE_URL the app boots an embedded",
  "# database, and every feature whose keys are missing hides itself.",
  "",
  ...VARS.flatMap(([name, req, purpose]) => [
    `# ${purpose.replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim()}`,
    ...(req === "yes" ? ["# Required in production."] : req === "recommended" ? ["# Recommended in production."] : req === "no" ? [] : [`# Required ${req.replace(/`/g, "")}.`]),
    ...name.split("` / `").map((n) => `${n}=`),
    "",
  ]),
].join("\n");

const files = [
  ["README.md", (text) => {
    const start = "<!-- env:start -->";
    const end = "<!-- env:end -->";
    const i = text.indexOf(start);
    const j = text.indexOf(end);
    if (i < 0 || j < 0) throw new Error(`README.md needs ${start} and ${end} around the environment table`);
    return text.slice(0, i + start.length) + "\n" + table + "\n" + text.slice(j);
  }],
  [".env.example", () => example],
];

const check = process.argv.includes("--check");
let changed = 0;
for (const [file, render] of files) {
  const p = path.join(root, file);
  const before = readFileSync(p, "utf8");
  const after = render(before);
  if (before === after) continue;
  changed++;
  if (check) console.error(`✗ ${file} is out of date. Run: node scripts/gen-docs.mjs`);
  else writeFileSync(p, after);
}
if (check && changed) process.exit(1);
console.log(check ? `✓ README.md and .env.example match the ${VARS.length} rows the code reads` : changed ? `wrote ${changed} file(s)` : "already up to date");
