import { createHash } from "node:crypto";

/**
 * Environment resolution with friendly fallbacks so a first deploy needs as
 * little configuration as possible:
 *
 *  - DATABASE_URL, or the variables the Vercel ⇄ Supabase integration injects.
 *  - "[YOUR-PASSWORD]" left in the URL (as Supabase's Connect dialog shows it)
 *    is filled from DATABASE_PASSWORD, percent-encoded correctly.
 *  - APP_BASE_URL falls back to Vercel's production domain.
 *  - SESSION_SECRET falls back to a hash of the database URL (stable, secret).
 */

const PLACEHOLDER = "[YOUR-PASSWORD]";

function fillPassword(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const pw = process.env.DATABASE_PASSWORD;
  if (url.includes(PLACEHOLDER)) {
    if (!pw) return undefined;
    return url.replace(PLACEHOLDER, encodeURIComponent(pw));
  }
  return url;
}

export function databaseUrl(): string | undefined {
  return fillPassword(process.env.DATABASE_URL) ?? fillPassword(process.env.POSTGRES_URL) ?? fillPassword(process.env.SUPABASE_DB_URL);
}

export function directDatabaseUrl(): string | undefined {
  return fillPassword(process.env.DIRECT_DATABASE_URL) ?? fillPassword(process.env.POSTGRES_URL_NON_POOLING) ?? databaseUrl();
}

export function databaseSource(): "DATABASE_URL" | "POSTGRES_URL" | "SUPABASE_DB_URL" | "embedded" | "missing" {
  if (fillPassword(process.env.DATABASE_URL)) return "DATABASE_URL";
  if (fillPassword(process.env.POSTGRES_URL)) return "POSTGRES_URL";
  if (fillPassword(process.env.SUPABASE_DB_URL)) return "SUPABASE_DB_URL";
  return process.env.VERCEL ? "missing" : "embedded";
}

export const onVercel = () => Boolean(process.env.VERCEL);

export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  const db = databaseUrl();
  if (db) return createHash("sha256").update(`kicksmash-session:${db}`).digest("base64url");
  if (process.env.NODE_ENV === "production" && onVercel()) {
    throw new Error("Set SESSION_SECRET (or a database URL) in production");
  }
  return "dev-only-insecure-session-secret";
}

export function sessionSecretSource(): "SESSION_SECRET" | "derived" | "dev" {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return "SESSION_SECRET";
  return databaseUrl() ? "derived" : "dev";
}
