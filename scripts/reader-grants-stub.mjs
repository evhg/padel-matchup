#!/usr/bin/env node
// Only the newest grants migration is whole.
//
//   node scripts/reader-grants-stub.mjs           make every older grants migration small
//   node scripts/reader-grants-stub.mjs --check   fail when an older one is still whole
//
// scripts/reader-grants.ts writes the reader's grants for the whole schema into a new migration after each
// schema change, about 17 KB each time, and every migration file ships in every function of every
// deployment (the first connection of a new database reads them). On 23 November 2026 there were 18 full
// copies, 0.27 MB of 0.43 MB of SQL, and a route went over the weight a route may have. Each copy starts
// with "revoke all" and states every grant again, so only the newest counts.
//
// The owner's decision of that day: an older copy keeps the role and nothing else. Production applied the
// full file, and drizzle applies a migration by its date, never by its text, so this touches no database.
// A new database gets the role from the first file and every grant from the newest one.
// tests/readonly.test.ts runs the check, so the step after a new grants migration cannot be forgotten.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "drizzle");
const WHOLE = "-- Generated from src/db/schema by src/lib/db/readonly.ts.";
const STUB = `-- The reader's grants as they were at this point. Each later grants migration states every grant again (the newest is
-- the truth; tests/readonly.test.ts holds it to the schema), so this file keeps only the role. The owner's decision of
-- 23 November 2026: 17 full copies were 0.27 MB in every function of every deployment. Production applied the
-- full file; a migration is applied by its date, never by its text, so this change touches no database.
`;
const BREAK = "--> statement-breakpoint";
const whole = readdirSync(dir)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f) && readFileSync(path.join(dir, f), "utf8").startsWith(WHOLE))
  .sort();
const older = whole.slice(0, -1);
if (process.argv.includes("--check")) {
  if (older.length) {
    console.error(`✗ ${older.length} older grants migration(s) are still whole: ${older.join(", ")}. Run: node scripts/reader-grants-stub.mjs`);
    process.exit(1);
  }
  console.log(`✓ only the newest grants migration is whole (${whole.at(-1) ?? "none"})`);
} else {
  for (const f of older) {
    const keep = readFileSync(path.join(dir, f), "utf8")
      .split(BREAK)
      .filter((st) => st.includes('create role "kicksmash_reader"') || st.trim().startsWith('grant "kicksmash_reader" to current_user') || st.trim().startsWith("grant usage on schema public"));
    if (keep.length !== 3) {
      console.error(`✗ ${f} does not have the three statements of the role; nothing was written to it`);
      process.exit(1);
    }
    writeFileSync(path.join(dir, f), `${STUB}${BREAK}${keep.join(BREAK).trimEnd()}\n`);
  }
  console.log(`made ${older.length} older grants migration(s) small; the whole one is ${whole.at(-1) ?? "none"}`);
}
