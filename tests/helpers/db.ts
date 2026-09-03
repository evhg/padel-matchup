import path from "node:path";
import type { Db } from "@/db";
import * as schema from "@/db/schema";

/**
 * Tests run against in-memory PGlite by default (zero setup). Set
 * TEST_DATABASE_URL to a real Postgres to exercise true concurrency.
 */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL;
  const migrationsFolder = path.resolve(process.cwd(), "drizzle");
  if (url) {
    // Real Postgres: TEST_DATABASE_URL must point to a DISPOSABLE database —
    // the public schema is dropped and recreated before every test file.
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const postgres = (await import("postgres")).default;
    const client = postgres(url, { max: 10, prepare: false });
    await client.unsafe("drop schema if exists public cascade; create schema public; drop schema if exists drizzle cascade;");
    const db = drizzle(client, { schema }) as unknown as Db;
    await migrate(db as never, { migrationsFolder });
    return { db, close: () => client.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder });
  return { db, close: () => client.close() };
}

export async function makePlayer(db: Db, name: string, extra: Partial<typeof schema.players.$inferInsert> = {}) {
  const [p] = await db.insert(schema.players).values({ displayName: name, locale: "en", ...extra }).returning();
  return p;
}

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;
