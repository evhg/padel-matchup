import { gzipSync } from "node:zlib";
import { and, eq, getTableName, is, sql, type Table } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { metricsDaily } from "@/db/schema";
import { bumpMetric, dayKey } from "@/lib/domain/metrics";

/**
 * The nightly backup. The database plan keeps no backups of its own, so once a
 * day every table is written as one gzipped JSON file into a private GitHub
 * repository the owner controls. Two variables switch it on: BACKUP_GITHUB_REPO
 * ("owner/name") and BACKUP_GITHUB_TOKEN (a fine-grained token with contents
 * write on that one repository). Without them nothing runs and the cron says so.
 */
export const backupConfigured = () => Boolean(process.env.BACKUP_GITHUB_TOKEN && process.env.BACKUP_GITHUB_REPO);

/** Every table the schema declares, by its SQL name. */
export const BACKUP_TABLES: readonly string[] = (Object.values(schema).filter((t) => is(t, PgTable)) as unknown as Table[]).map((t) => getTableName(t)).sort();

const KEEP_DAYS = 60;
const rowsOf = (r: unknown): unknown[] => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []));

/** Every table, every row (capped per table), as plain JSON. */
export async function dumpDatabase(db: Db, cap = 50_000): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const name of BACKUP_TABLES) {
    if (!/^[a-z_]+$/.test(name)) continue;
    out[name] = rowsOf(await db.execute(sql.raw(`select * from "${name}" limit ${cap}`)));
  }
  return out;
}

export type BackupResult = { status: "skipped" | "already" | "done" | "failed"; path?: string; bytes?: number; pruned?: number; error?: string };

/** Once a day after 03:00 UTC: dump, gzip, put into the repository, prune files older than KEEP_DAYS. Never throws. */
export async function runBackup(db: Db, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<BackupResult> {
  if (!backupConfigured() || now.getUTCHours() < 3) return { status: "skipped" };
  const day = dayKey(now);
  const [done] = await db.select({ value: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.day, day), eq(metricsDaily.key, "backup_done"))).limit(1);
  if (done && Number(done.value) > 0) return { status: "already" };
  const repo = process.env.BACKUP_GITHUB_REPO!;
  const headers = { authorization: `Bearer ${process.env.BACKUP_GITHUB_TOKEN!}`, accept: "application/vnd.github+json", "user-agent": "kicksmash-backup", "content-type": "application/json" };
  const api = (path: string) => `https://api.github.com/repos/${repo}/contents/${path}`;
  try {
    const dump = await dumpDatabase(db);
    const body = gzipSync(Buffer.from(JSON.stringify({ format: "kicksmash-backup/1", at: now.toISOString(), tables: dump })));
    const path = `backups/${day}.json.gz`;
    const existing = await fetchImpl(api(path), { headers });
    const sha = existing.ok ? ((await existing.json()) as { sha?: string }).sha : undefined;
    const put = await fetchImpl(api(path), { method: "PUT", headers, body: JSON.stringify({ message: `backup ${day}`, content: body.toString("base64"), ...(sha ? { sha } : {}) }) });
    if (!put.ok) return { status: "failed", error: `github ${put.status}` };
    await bumpMetric(db, "backup_done", 1, day);
    await bumpMetric(db, "backup_bytes", body.length, day);
    // Old days go: the repository keeps their history anyway.
    let pruned = 0;
    const cutoff = dayKey(new Date(now.getTime() - KEEP_DAYS * 86_400_000));
    const list = await fetchImpl(api("backups"), { headers });
    if (list.ok) {
      const files = (await list.json()) as { name: string; sha: string; path: string }[];
      for (const f of files) {
        const d = f.name.match(/^(\d{4}-\d{2}-\d{2})\.json\.gz$/)?.[1];
        if (!d || d >= cutoff) continue;
        const del = await fetchImpl(api(f.path), { method: "DELETE", headers, body: JSON.stringify({ message: `prune ${d}`, sha: f.sha }) });
        if (del.ok) pruned++;
      }
    }
    return { status: "done", path, bytes: body.length, pruned };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}
