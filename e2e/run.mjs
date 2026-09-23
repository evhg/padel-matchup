// Boots a production build on a throwaway PGlite database and runs every e2e/*.mjs suite.
// Usage: pnpm build && pnpm e2e            (SHOTS=./shots keeps screenshots, PW_CHROMIUM=/path uses a preinstalled browser,
//                                            E2E_ONLY=levels or E2E_ONLY=telegram,coach runs those suites ("all" or unset runs every one),
//                                            E2E_SHARD=1/2 runs every second suite starting at the first)
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 3001);
const BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), "kicksmash-e2e-"));
const env = {
  ...process.env,
  PORT: String(PORT),
  PGLITE_DATA_DIR: dataDir,
  DATABASE_URL: "",
  POSTGRES_URL: "",
  APP_BASE_URL: BASE,
  // ---------------------------------------------------------------------------------------------
  // Every value below is PINNED, never inherited, and that is the whole point.
  //
  // Each one is a shared secret: the suites hard-code the other half. series.mjs sends
  // "Bearer e2e-cron-secret", telegram.mjs signs with "e2e-tg-secret", discord.mjs holds the private
  // half of the key pair below. Each used to fall back to the test value only when the machine had
  // none, so the day a real CRON_SECRET appeared in the environment the server took it, the suite
  // kept sending the test one, and /api/cron/hourly answered `{"error":"unauthorized"}`. Two red
  // checks named a second edition and a paused series — neither of which had anything to do with
  // it. That cost a gate run and a bisect to find.
  //
  // A test server takes its secrets from the test, or the test is not testing what it thinks.
  // ---------------------------------------------------------------------------------------------
  // Enables the email UIs; every message is written to this file instead of being sent, so suites can read it.
  RESEND_API_KEY: "re_dummy_local_only",
  EMAIL_SINK_FILE: path.join(dataDir, "emails.jsonl"),
  SESSION_SECRET: "e2e-session-secret-not-for-production",
  CRON_SECRET: "e2e-cron-secret",
  // A fake bot: the Bot API answers 401 (or is unreachable) and the code must stay quiet about it.
  TELEGRAM_BOT_TOKEN: "1:e2e-fake-token",
  TELEGRAM_WEBHOOK_SECRET: "e2e-tg-secret",
  TELEGRAM_BOT_USERNAME: "kicksmash_bot",
  // The owner's Telegram id: club claims and listening drafts are approved from this account.
  TELEGRAM_OWNER_ID: "777001",
  // Passport signing pair for these tests only (never used anywhere else).
  PASSPORT_PRIVATE_KEY: "8e634fbeffa64d5c4fcbdaa76e1aadaa388eeaa636cd8179f0d858311c321ab7",
  PASSPORT_PUBLIC_KEY: "041adb0508a2d16a6e97203251a2a85ce6e30c2fa2ec6498fc1ddec242265447",
  // A fake Discord app: the token decodes to a plausible id, the key pair exists only for these tests (private half in e2e/discord.mjs).
  DISCORD_BOT_TOKEN: "MTU0NTk4ODEzODA1NTIzNzcyMw.e2e.fake-token",
  DISCORD_PUBLIC_KEY: "7cb05c12c78f756c9e976f772d63dd58a6426129cc2d177f8314a2fce536bb96",
  // A fake LINE channel, so the webhook is live and its signature can be checked for real. The bot
  // token points at nothing: every outbound call fails, which is exactly what the suites assert on.
  LINE_CHANNEL_TOKEN: "e2e-line-token",
  LINE_CHANNEL_SECRET: "e2e-line-secret",
  NEXT_TELEMETRY_DISABLED: "1",
};
if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
  const webpush = (await import("web-push")).default;
  const k = webpush.generateVAPIDKeys();
  env.VAPID_PUBLIC_KEY = k.publicKey;
  env.VAPID_PRIVATE_KEY = k.privateKey;
  env.VAPID_SUBJECT = env.VAPID_SUBJECT || "mailto:e2e@example.com";
}

const server = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (d) => process.env.E2E_VERBOSE && process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
const stop = () => {
  if (!server.killed) server.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
};
process.on("exit", stop);
process.on("SIGINT", () => process.exit(130));

const deadline = Date.now() + 120_000;
let up = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) {
      up = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
if (!up) {
  console.error("server did not come up on " + BASE);
  process.exit(1);
}

const suites = readdirSync(path.dirname(new URL(import.meta.url).pathname))
  .filter((f) => f.endsWith(".mjs") && !["run.mjs", "lib.mjs"].includes(f))
  .filter((f) => {
    // E2E_ONLY: one suite, a comma-separated list, or "all" (the same as unset).
    const only = (process.env.E2E_ONLY ?? "").trim();
    if (!only || only === "all") return true;
    return only.split(",").map((x) => x.trim()).filter(Boolean).includes(f.replace(/\.mjs$/, ""));
  })
  .sort()
  .filter((f, i) => {
    // E2E_SHARD=k/n: CI runs the suites in n jobs; the k-th job takes every n-th suite starting at the k-th.
    const m = /^(\d+)\/(\d+)$/.exec(process.env.E2E_SHARD ?? "");
    return !m || i % Number(m[2]) === Number(m[1]) - 1;
  });
const failed = [];
for (const f of suites) {
  console.log(`\n=== ${f} ===`);
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join("e2e", f)], { env: { ...env, BASE }, stdio: "inherit" });
    p.on("exit", (c) => resolve(c ?? 1));
  });
  if (code !== 0) failed.push(f);
}
console.log(`\n${suites.length - failed.length}/${suites.length} suites passed`);
if (failed.length) console.log(`failed suites: ${failed.join(", ")} (each suite's own "failed:" line above names the checks)`);
process.exit(failed.length ? 1 : 0);
