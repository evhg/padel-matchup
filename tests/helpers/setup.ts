import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll } from "vitest";

// What `next start` does before any app code loads (next/dist/server/node-environment-baseline.js):
// without it, Next's request storage is a stand-in that throws on `run`, so a test cannot call a server
// action inside a request (`asAction` in tests/helpers/action.ts). Set before the first file imports
// Next, because each storage is made once, when its module loads, and the worker keeps it for every file.
if (typeof (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage !== "function") (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

/**
 * Runs once per test file. A test that reaches the app's own database (`getDb()` with no DATABASE_URL, the
 * path a route handler takes) gets an embedded database of its own in a temporary directory, so two files
 * running in parallel never open the same on-disk PGlite, and nothing from a previous run is there.
 */
const dir = mkdtempSync(path.join(tmpdir(), "kicksmash-test-"));
process.env.PGLITE_DATA_DIR = dir;
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.SUPABASE_DB_URL;

// Files share a worker (`isolate: false`), so one file's environment is the next one's. Whatever a
// test sets, adds or deletes is undone when the file ends, and a file therefore starts from the same
// environment whether it runs alone, first or last. Without this, a test that turns a feature on by
// setting its key silently turns it on for every file after it — which is how a test asserting a
// feature is off failed in CI and nowhere else.
const envAtStart = { ...process.env };

afterAll(async () => {
  for (const k of Object.keys(process.env)) if (!(k in envAtStart)) delete process.env[k];
  for (const [k, v] of Object.entries(envAtStart)) if (process.env[k] !== v) process.env[k] = v;

  // Close the app's database before its directory goes, or PGlite's last flush finds no files (ENOENT, errno 44).
  const g = globalThis as { __padelDb?: Promise<{ $client?: { close?: () => Promise<void> } }> };
  try {
    const db = await g.__padelDb;
    await db?.$client?.close?.();
  } catch {
    // A database that never opened, or failed to, has nothing to close.
  }
  g.__padelDb = undefined;
  rmSync(dir, { recursive: true, force: true });
});
