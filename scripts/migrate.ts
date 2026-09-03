import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set DIRECT_DATABASE_URL (or DATABASE_URL) to run migrations against Postgres.");
  process.exit(1);
}

const client = postgres(url, { max: 1, prepare: false });
const db = drizzle(client);
await migrate(db, { migrationsFolder: "./drizzle" });
console.log("✓ migrations applied");
await client.end();
