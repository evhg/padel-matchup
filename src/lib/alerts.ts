import { createHash } from "node:crypto";
import { desc, eq, gt, lt, or, sql, isNull, and } from "drizzle-orm";
import type { Db } from "@/db";
import { errorEvents, type ErrorEvent } from "@/db/schema";

/**
 * Production exceptions: counted for /admin, and kept as one row per
 * fingerprint in error_events so the daily fixer can read what broke.
 * Best effort: never throws, never blocks the request path. No external service.
 */
export type ErrorKind = "server" | "client" | "cron";
export type ErrorContext = { path?: string | null; digest?: string | null };

export async function reportError(kind: ErrorKind, e?: unknown, ctx: ErrorContext = {}): Promise<void> {
  if (e) console.error(`[${kind}-error]`, e);
  try {
    const [{ getDb }, { bumpMetric }] = await Promise.all([import("@/db"), import("@/lib/domain/metrics")]);
    const db = await getDb();
    await bumpMetric(db, `errors_${kind}`);
    if (e) await recordError(db, kind, e, ctx);
  } catch {
    /* metrics are optional */
  }
}

/** Message and stack of anything thrown: Error, string, plain object. */
export function describeError(e: unknown): { message: string; stack: string | null } {
  if (e instanceof Error) return { message: e.message || e.name || "Error", stack: e.stack ?? null };
  if (typeof e === "string") return { message: e, stack: null };
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    const o = e as { message: string; stack?: unknown };
    return { message: o.message, stack: typeof o.stack === "string" ? o.stack : null };
  }
  try {
    return { message: JSON.stringify(e).slice(0, 500), stack: null };
  } catch {
    return { message: String(e), stack: null };
  }
}

/** Ids, numbers and hashes blanked, so one bug is one row however many rows it touched. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** The first frame in our own code, without line and column numbers. */
export function topFrame(stack: string | null): string {
  if (!stack) return "";
  const lines = stack.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at "));
  const own = lines.find((l) => /(\/src\/|\/app\/|\/lib\/|webpack-internal|\.next\/server)/.test(l) && !/node_modules/.test(l)) ?? lines[0] ?? "";
  return own.replace(/:\d+:\d+\)?$/, "").replace(/:\d+\)?$/, "").replace(/\?[^ )]*/g, "").slice(0, 200);
}

export function fingerprintOf(kind: ErrorKind, message: string, stack: string | null): string {
  const h = createHash("sha1");
  h.update(`${kind}\n${normalizeMessage(message)}\n${topFrame(stack)}`);
  return h.digest("hex").slice(0, 16);
}

/** One row per fingerprint; a repeat bumps the count and refreshes the sample. */
export async function recordError(db: Db, kind: ErrorKind, e: unknown, ctx: ErrorContext = {}, now = new Date()): Promise<ErrorEvent> {
  const { message, stack } = describeError(e);
  const fingerprint = fingerprintOf(kind, message, stack);
  const path = ctx.path ? String(ctx.path).slice(0, 200) : null;
  const sample = { message: (ctx.digest ? `${message} [digest ${String(ctx.digest).slice(0, 32)}]` : message).slice(0, 500), stack: stack ? stack.slice(0, 4000) : null };
  const [row] = await db
    .insert(errorEvents)
    .values({ fingerprint, kind, ...sample, path, firstAt: now, lastAt: now })
    .onConflictDoUpdate({
      target: errorEvents.fingerprint,
      set: { count: sql`${errorEvents.count} + 1`, lastAt: now, message: sample.message, stack: sample.stack, path: sql`coalesce(${path}, ${errorEvents.path})` },
    })
    .returning();
  return row;
}

export type ErrorListItem = ErrorEvent & { open: boolean };

/** Newest first. Open = never marked fixed, or seen again after the fix. */
export async function listErrors(db: Db, o: { includeFixed?: boolean; since?: Date; limit?: number } = {}): Promise<ErrorListItem[]> {
  const conds = [];
  if (!o.includeFixed) conds.push(or(isNull(errorEvents.fixedAt), gt(errorEvents.lastAt, errorEvents.fixedAt)));
  if (o.since) conds.push(gt(errorEvents.lastAt, o.since));
  const rows = await db
    .select()
    .from(errorEvents)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(errorEvents.lastAt))
    .limit(o.limit ?? 50);
  return rows.map((r) => ({ ...r, open: !r.fixedAt || r.lastAt > r.fixedAt }));
}

export async function markErrorFixed(db: Db, fingerprint: string, note: string | null, now = new Date()): Promise<ErrorEvent | null> {
  const [row] = await db
    .update(errorEvents)
    .set({ fixedAt: now, fixNote: note ? note.slice(0, 500) : null })
    .where(eq(errorEvents.fingerprint, fingerprint))
    .returning();
  return row ?? null;
}

/** Rows not seen for 90 days go; the table stays a page long. */
export async function pruneErrors(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 90 * 24 * 3600 * 1000);
  const gone = await db.delete(errorEvents).where(lt(errorEvents.lastAt, cutoff)).returning({ f: errorEvents.fingerprint });
  return gone.length;
}
