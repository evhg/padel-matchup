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

/** How long a night's file stays in the repository and in its history; /privacy says so, read from here. */
export const BACKUP_KEEP_DAYS = 60;
/** Rows per table in one night's file. Far above today's counts, and said out loud when reached. */
export const BACKUP_ROW_CAP = 50_000;

/** One night's file name under backups/. */
const NIGHT_FILE = /^(\d{4}-\d{2}-\d{2})\.json\.gz$/;
/** The most nights the folder may hold when the history is rebuilt: the kept days, today, and one missed prune. */
export const BACKUP_MAX_FILES = BACKUP_KEEP_DAYS + 2;
/** What GitHub may put at the root of a new repository. Anything else there means it is not the backup repository. */
const ROOT_FILES = /^(README(\.md)?|LICENSE|\.gitignore|\.gitattributes)$/i;
/** The whole history rebuild must end well inside the hourly job's 60 seconds. */
const HISTORY_BUDGET_MS = 15_000;

/** The tables that filled the cap, so were cut short. A backup that silently drops rows is not one. */
export const cappedTables = (dump: Record<string, unknown[]>, cap = BACKUP_ROW_CAP): string[] =>
  Object.entries(dump)
    .filter(([, rows]) => rows.length >= cap)
    .map(([name]) => name);
const rowsOf = (r: unknown): unknown[] => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []));

/** Every table, every row (capped per table), as plain JSON. */
export async function dumpDatabase(db: Db, cap = BACKUP_ROW_CAP): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const name of BACKUP_TABLES) {
    if (!/^[a-z_]+$/.test(name)) continue;
    out[name] = rowsOf(await db.execute(sql.raw(`select * from "${name}" limit ${cap}`)));
  }
  return out;
}

/**
 * What became of the repository's history tonight. `rebuilt`: the branch now points at one new commit
 * with no parent, so every older copy is unreachable. `kept`: the history is as it was, and the reason
 * says why. `historyFrom` is where the branch pointed before; pointing it back there undoes a rebuild
 * (docs/OPERATING.md).
 */
export type BackupHistory = { history: "rebuilt" | "kept"; historyReason?: string; historyFrom?: string; historyTo?: string };

export type BackupResult = { status: "skipped" | "already" | "done" | "failed"; path?: string; bytes?: number; pruned?: number; capped?: string[]; error?: string } & Partial<BackupHistory>;

/** One entry of a recursive git tree, as the GitHub API returns it. */
export type TreeEntry = { path: string; type: string; sha: string };

/**
 * Why the tree at the branch's head must not become the repository's only history, or null when it may.
 *
 * The rebuild throws every older commit away, so it runs only on a tree that is plainly the backup
 * repository after a good night: read whole, nothing but night files under backups/ (and what GitHub
 * puts in a new repository), no more of them than the prune leaves, and today's file, the very one
 * just written. A token pointed at the wrong repository fails here, before anything is lost.
 */
export function historyRefusal(tree: { tree: TreeEntry[]; truncated?: boolean }, day: string, written?: string): string | null {
  if (tree.truncated) return "the tree is too big to read whole";
  const nights: TreeEntry[] = [];
  for (const e of tree.tree) {
    if (e.type === "tree" && e.path === "backups") continue;
    if (e.type === "blob" && !e.path.includes("/") && ROOT_FILES.test(e.path)) continue;
    const name = e.path.startsWith("backups/") ? e.path.slice("backups/".length) : null;
    if (e.type !== "blob" || name === null) return `${e.type} ${e.path} does not belong in the backup repository`;
    if (!NIGHT_FILE.test(name)) return `${e.path} is not a night's file`;
    nights.push(e);
  }
  if (nights.length > BACKUP_MAX_FILES) return `${nights.length} night files, more than ${BACKUP_MAX_FILES}`;
  const today = nights.find((e) => e.path === `backups/${day}.json.gz`);
  if (!today) return `today's file backups/${day}.json.gz is not in the tree`;
  if (written && today.sha !== written) return "today's file in the tree is not the one just written";
  return null;
}

class Refused extends Error {}
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const shaOf = (v: unknown, what: string): string => {
  if (typeof v === "string" && SHA.test(v)) return v;
  throw new Refused(`no commit id from ${what}`);
};

/**
 * Tonight's history rebuild: the branch's head tree becomes one new commit with no parent, and the
 * branch is forced onto it. Never throws, and never moves the branch unless every step before succeeded,
 * the tree passed `historyRefusal`, and the branch still points where it did when it was read.
 */
async function rebuildHistory(repo: string, headers: Record<string, string>, day: string, written: string | undefined, fetchImpl: typeof fetch): Promise<BackupHistory & { branch?: string }> {
  const base = `https://api.github.com/repos/${repo}`;
  const signal = AbortSignal.timeout(HISTORY_BUDGET_MS);
  let step = "read the repository";
  let branch: string | undefined;
  let from: string | undefined;
  const kept = (reason: string) => ({ history: "kept" as const, historyReason: reason, branch, ...(from ? { historyFrom: from } : {}) });
  const call = async <T>(what: string, path: string, write?: { method: "POST" | "PATCH"; body: unknown }): Promise<T> => {
    step = what;
    const res = await fetchImpl(`${base}${path}`, { method: write?.method ?? "GET", headers, signal, ...(write ? { body: JSON.stringify(write.body) } : {}) });
    if (!res.ok) throw new Refused(`github ${res.status} at ${what}`);
    return (await res.json()) as T;
  };
  try {
    // The contents API writes to the default branch, so that is the branch whose history goes.
    branch = (await call<{ default_branch?: string }>("read the repository", "")).default_branch;
    if (!branch) throw new Refused("no default branch");
    const ref = `heads/${branch}`;
    const head = shaOf((await call<{ object?: { sha?: string } }>("read the branch", `/git/ref/${ref}`)).object?.sha, "the branch");
    from = head;
    const tree = shaOf((await call<{ tree?: { sha?: string } }>("read the commit", `/git/commits/${head}`)).tree?.sha, "the commit");
    const refusal = historyRefusal(await call<{ tree: TreeEntry[]; truncated?: boolean }>("read the tree", `/git/trees/${tree}?recursive=1`), day, written);
    if (refusal) return kept(refusal);
    // The new commit names the one it replaces, so the way back survives the job's logs.
    const message = `backups as of ${day}\n\nThe branch pointed at ${head} before this commit.`;
    const fresh = shaOf((await call<{ sha?: string }>("make the new commit", "/git/commits", { method: "POST", body: { message, tree, parents: [] } })).sha, "the new commit");
    const now = shaOf((await call<{ object?: { sha?: string } }>("read the branch again", `/git/ref/${ref}`)).object?.sha, "the branch");
    if (now !== head) return kept(`the branch moved from ${head} to ${now} during the rebuild`);
    await call("move the branch", `/git/refs/${ref}`, { method: "PATCH", body: { sha: fresh, force: true } });
    return { history: "rebuilt", historyFrom: head, historyTo: fresh, branch };
  } catch (e) {
    return kept(e instanceof Refused ? e.message : `${step}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Once a day after 03:00 UTC: dump, gzip, put into the repository, prune files older than BACKUP_KEEP_DAYS, rebuild the history. Never throws. */
export async function runBackup(db: Db, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<BackupResult> {
  if (!backupConfigured() || now.getUTCHours() < 3) return { status: "skipped" };
  const day = dayKey(now);
  const [done] = await db.select({ value: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.day, day), eq(metricsDaily.key, "backup_done"))).limit(1);
  if (done && Number(done.value) > 0) return { status: "already" };
  const repo = process.env.BACKUP_GITHUB_REPO!;
  const headers = { authorization: `Bearer ${process.env.BACKUP_GITHUB_TOKEN!}`, accept: "application/vnd.github+json", "user-agent": "kicksmash-backup", "content-type": "application/json" };
  const api = (path: string) => `https://api.github.com/repos/${repo}/contents/${path}`;
  // Every night counts its history once, rebuilt or kept, and says so in the job's log. The log line
  // carries where the branch pointed before, which is the way back from a rebuild that went wrong.
  const settle = async ({ branch, ...h }: BackupHistory & { branch?: string }): Promise<BackupHistory> => {
    await bumpMetric(db, h.history === "rebuilt" ? "backup_history_rebuilt" : "backup_history_kept", 1, day).catch(() => undefined);
    if (h.history === "rebuilt") console.info(`[backup] ${day}: history rebuilt, ${repo} ${branch} moved from ${h.historyFrom} to ${h.historyTo}; to undo, point ${branch} back at ${h.historyFrom}`);
    else console.warn(`[backup] ${day}: history kept, ${h.historyReason}${h.historyFrom ? `; ${repo} ${branch} is at ${h.historyFrom}` : ""}`);
    return h;
  };
  try {
    const dump = await dumpDatabase(db);
    const capped = cappedTables(dump);
    const body = gzipSync(Buffer.from(JSON.stringify({ format: "kicksmash-backup/1", at: now.toISOString(), capped, tables: dump })));
    const path = `backups/${day}.json.gz`;
    const existing = await fetchImpl(api(path), { headers });
    const sha = existing.ok ? ((await existing.json()) as { sha?: string }).sha : undefined;
    const put = await fetchImpl(api(path), { method: "PUT", headers, body: JSON.stringify({ message: `backup ${day}`, content: body.toString("base64"), ...(sha ? { sha } : {}) }) });
    // No file tonight, no rebuild tonight: the history is only ever cut down to a tree that has today in it.
    if (!put.ok) return { status: "failed", error: `github ${put.status}`, ...(await settle({ history: "kept", historyReason: "today's file was not written" })) };
    const written = ((await put.json().catch(() => null)) as { content?: { sha?: string } } | null)?.content?.sha;
    await bumpMetric(db, "backup_done", 1, day);
    await bumpMetric(db, "backup_bytes", body.length, day);
    if (capped.length) await bumpMetric(db, "backup_capped", capped.length, day);
    // A contents-API DELETE is one more commit, so an old day leaves the folder here and leaves the
    // history only when the rebuild below makes every older commit unreachable. GitHub then removes
    // those at a time of its own. /privacy says "about BACKUP_KEEP_DAYS days" for exactly that reason
    // (the owner's decision of 10 October 2026: rebuild the history each night).
    let pruned = 0;
    const cutoff = dayKey(new Date(now.getTime() - BACKUP_KEEP_DAYS * 86_400_000));
    const list = await fetchImpl(api("backups"), { headers });
    if (list.ok) {
      const files = (await list.json()) as { name: string; sha: string; path: string }[];
      for (const f of files) {
        const d = f.name.match(NIGHT_FILE)?.[1];
        if (!d || d >= cutoff) continue;
        const del = await fetchImpl(api(f.path), { method: "DELETE", headers, body: JSON.stringify({ message: `prune ${d}`, sha: f.sha }) });
        if (del.ok) pruned++;
      }
    }
    const history = await settle(await rebuildHistory(repo, headers, day, written, fetchImpl));
    return { status: "done", path, bytes: body.length, pruned, capped, ...history };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e), ...(await settle({ history: "kept", historyReason: "the backup failed before the history step" })) };
  }
}
