import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { directDatabaseUrl } from "../src/lib/env";

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
