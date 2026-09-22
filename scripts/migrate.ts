import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { directDatabaseUrl } from "../src/lib/env";

// Everything below sits inside a function on purpose. package.json has no `"type": "module"`, so tsx
// compiles this file to CommonJS, where a top-level `await` is not a slow path but a build error:
// esbuild refuses the file before one line of it runs. The first Migrate run died on exactly that,
// after the merge, and the database never heard from it. scripts/check-migrate-runner.mjs now runs
// this file in the gate, so the next one cannot.
async function main() {
  const url = directDatabaseUrl();
  if (!url) {
    console.error("Set DIRECT_DATABASE_URL (or DATABASE_URL) to run migrations against Postgres.");
    process.exit(1);
  }

  // `lock_timeout`, in milliseconds, is what the by-hand procedure always set, and the workflow must be at least as
  // careful as a pair of hands: a migration that cannot take its lock inside five seconds gives up
  // instead of queueing behind a live query and blocking every reader behind it.
  const client = postgres(url, { max: 1, prepare: false, connection: { lock_timeout: 5000 } });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("✓ migrations applied");
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
