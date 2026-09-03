import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { databaseUrl, onVercel } from "@/lib/env";
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
    // No array columns → skip the type-introspection roundtrip on every new connection.
    fetch_types: false,
    max: process.env.NODE_ENV === "production" ? 5 : 3,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  const db = drizzle(client, { schema }) as unknown as Db;
  if (process.env.AUTO_MIGRATE !== "false") await autoMigrate(db);
  return db;
}

/**
 * Applies ./drizzle migrations on first connection so a fresh deploy needs no
 * manual `pnpm db:migrate`. Idempotent; tolerant of two cold starts racing.
 */
async function autoMigrate(db: Db): Promise<void> {
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const path = await import("node:path");
  const migrationsFolder = path.join(process.cwd(), "drizzle");
  try {
    await migrate(db as never, { migrationsFolder });
  } catch (e) {
    const exists = await db
      .execute(sql`select to_regclass('public.events') as t`)
      .then((r: unknown) => {
        const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
        return Boolean((rows[0] as { t?: string | null } | undefined)?.t);
      })
      .catch(() => false);
    if (!exists) throw e;
    console.warn("[db] auto-migrate raced another instance; schema is present:", (e as Error).message);
  }
}

async function createPgliteDb(): Promise<Db> {
  if (onVercel()) {
    throw new Error(
      "No database configured. Add DATABASE_URL (and DATABASE_PASSWORD) in Vercel → Settings → Environment Variables, then redeploy. See /api/health.",
    );
  }
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
    const url = databaseUrl();
    g.__padelDb = url ? createPostgresDb(url) : createPgliteDb();
    g.__padelDb.catch(() => {
      // Allow a retry on next request instead of caching a rejected promise.
      g.__padelDb = undefined;
    });
  }
  return g.__padelDb;
}

export const usingEmbeddedDb = () => !databaseUrl();
