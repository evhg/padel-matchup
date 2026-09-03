import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export { schema };

/**
 * Driver-agnostic database handle. All domain logic is written against this
 * type so the same code runs on Supabase Postgres (postgres-js) in production,
 * an embedded PGlite database in zero-config local dev, and in-memory PGlite
 * in tests.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

type GlobalWithDb = typeof globalThis & { __padelDb?: Promise<Db> };

async function createPostgresDb(url: string): Promise<Db> {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const client = postgres(url, {
    // Supabase transaction pooler (port 6543) does not support prepared statements.
    prepare: false,
    max: process.env.NODE_ENV === "production" ? 5 : 3,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return drizzle(client, { schema }) as unknown as Db;
}

async function createPgliteDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const path = await import("node:path");
  const dataDir = process.env.PGLITE_DATA_DIR ?? path.join(process.cwd(), ".pglite");
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  const { seedIfEmpty } = await import("./seed");
  await seedIfEmpty(db);
  console.log(`[db] DATABASE_URL not set → using embedded PGlite at ${dataDir}`);
  return db;
}

/**
 * Returns the shared database handle (cached across hot reloads).
 */
export function getDb(): Promise<Db> {
  const g = globalThis as GlobalWithDb;
  if (!g.__padelDb) {
    const url = process.env.DATABASE_URL;
    g.__padelDb = url ? createPostgresDb(url) : createPgliteDb();
    g.__padelDb.catch(() => {
      // Allow a retry on next request instead of caching a rejected promise.
      g.__padelDb = undefined;
    });
  }
  return g.__padelDb;
}

export const usingEmbeddedDb = () => !process.env.DATABASE_URL;
