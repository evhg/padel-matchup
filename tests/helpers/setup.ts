import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

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

afterAll(async () => {
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
