import path from "node:path";
import type { Db } from "@/db";
import * as schema from "@/db/schema";

/**
 * Tests run against in-memory PGlite by default (zero setup). Set
 * TEST_DATABASE_URL to a real Postgres to exercise true concurrency.
 *
 * One database per worker process, not per test file. Standing a database up is
 * the expensive part by a wide margin — a fresh PGlite costs three to six seconds
 * and replaying the migrations into it costs half of one — so the first file in a
 * worker builds it and every file after that empties it instead, which costs
 * milliseconds. `close()` is therefore a no-op: the worker keeps the database for
 * the next file and the process exit takes it away.
 */
type Pooled = { db: Db; empty: () => Promise<void> };
let pooled: Promise<Pooled> | null = null;

/** Every table in `public`, emptied together so foreign keys and sequences do not object. */
const emptier = (exec: (sql: string) => Promise<unknown>, names: string[]) => {
  const list = names.map((n) => `"${n}"`).join(", ");
  return async () => {
    if (list) await exec(`truncate ${list} restart identity cascade;`);
  };
};

async function build(): Promise<Pooled> {
  const url = process.env.TEST_DATABASE_URL;
  const migrationsFolder = path.resolve(process.cwd(), "drizzle");
  if (url) {
    // Real Postgres: TEST_DATABASE_URL must point to a DISPOSABLE database —
    // the public schema is dropped and recreated once per worker.
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const postgres = (await import("postgres")).default;
    const client = postgres(url, { max: 10, prepare: false });
    await client.unsafe("drop schema if exists public cascade; create schema public; drop schema if exists drizzle cascade;");
    const db = drizzle(client, { schema }) as unknown as Db;
    await migrate(db as never, { migrationsFolder });
    const rows = await client.unsafe<{ tablename: string }[]>("select tablename from pg_tables where schemaname = 'public'");
    return { db, empty: emptier((s) => client.unsafe(s), rows.map((r) => r.tablename)) };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder });
  const res = await client.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'");
  return { db, empty: emptier((s) => client.exec(s), res.rows.map((r) => r.tablename)) };
}

export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  pooled ??= build();
  const { db, empty } = await pooled;
  await empty();
  return { db, close: async () => undefined };
}

export async function makePlayer(db: Db, name: string, extra: Partial<typeof schema.players.$inferInsert> = {}) {
  const [p] = await db.insert(schema.players).values({ displayName: name, locale: "en", ...extra }).returning();
  return p;
}

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;
