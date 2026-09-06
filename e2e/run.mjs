// Boots a production build on a throwaway PGlite database and runs every e2e/*.mjs suite.
// Usage: pnpm build && pnpm e2e            (SHOTS=./shots keeps screenshots, PW_CHROMIUM=/path uses a preinstalled browser,
//                                            E2E_ONLY=levels runs a single suite)
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
  // Enables the email UIs; sends fail harmlessly (no real key).
  RESEND_API_KEY: process.env.RESEND_API_KEY || "re_dummy_local_only",
  SESSION_SECRET: process.env.SESSION_SECRET || "e2e-session-secret-not-for-production",
  CRON_SECRET: process.env.CRON_SECRET || "e2e-cron-secret",
  // A fake bot: the Bot API answers 401 (or is unreachable) and the code must stay quiet about it.
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "1:e2e-fake-token",
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET || "e2e-tg-secret",
  TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME || "kicksmash_bot",
  // A fake Discord app: the token decodes to a plausible id, the key pair exists only for these tests (private half in e2e/discord.mjs).
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || "MTU0NTk4ODEzODA1NTIzNzcyMw.e2e.fake-token",
  DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY || "7cb05c12c78f756c9e976f772d63dd58a6426129cc2d177f8314a2fce536bb96",
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
  .filter((f) => !process.env.E2E_ONLY || f === `${process.env.E2E_ONLY}.mjs`)
  .sort();
let failed = 0;
for (const f of suites) {
  console.log(`\n=== ${f} ===`);
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join("e2e", f)], { env: { ...env, BASE }, stdio: "inherit" });
    p.on("exit", (c) => resolve(c ?? 1));
  });
  if (code !== 0) failed++;
}
console.log(`\n${suites.length - failed}/${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
