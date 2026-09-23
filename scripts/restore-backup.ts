/**
 * Loads one night's backup into a local database, without the keys to anybody's account.
 *
 *   pnpm exec tsx scripts/restore-backup.ts <day>.json.gz [--into=.pglite-backup] [--replace] [--keep-contacts]
 *   PGLITE_DATA_DIR=.pglite-backup pnpm dev
 *
 * The file comes from the private backup repository (BACKUP_GITHUB_REPO, `backups/<day>.json.gz`),
 * downloaded by whoever may read it. Every credential is replaced and the push subscriptions are
 * dropped, always; addresses, phone numbers and messenger ids are masked unless --keep-contacts.
 * The folder and the file are personal data: both are in .gitignore, and neither belongs anywhere
 * but the machine that needs them. src/lib/backupRestore.ts has the why.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { makeScrubber, restoreDump, type BackupFile } from "../src/lib/backupRestore";
import type { Db } from "../src/db";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const file = args.find((a) => !a.startsWith("--"));

async function main() {
  if (!file) throw new Error("Which backup? pnpm exec tsx scripts/restore-backup.ts <day>.json.gz");
  const into = path.resolve(option("into", ".pglite-backup"));
  if (existsSync(into)) {
    if (!flag("replace")) throw new Error(`${into} exists. Pass --replace to empty it first.`);
    rmSync(into, { recursive: true, force: true });
  }
  const raw = readFileSync(file);
  const backup = JSON.parse((file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8")) as BackupFile;
  if (!backup.format?.startsWith("kicksmash-backup/")) throw new Error(`${file} is not a Kicksmash backup`);

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite(into);
  const db = drizzle(client) as unknown as Db;
  await migrate(db as never, { migrationsFolder: path.resolve("drizzle") });
  const result = await restoreDump(db, backup, makeScrubber({ keepContacts: flag("keep-contacts") }));
  await client.close();

  console.log(`restored the backup of ${backup.at}: ${result.rows} rows in ${result.tables} tables, into ${into}`);
  console.log(`credentials replaced${flag("keep-contacts") ? "" : "; addresses, phone numbers and messenger ids masked"}`);
  if (result.dropped.length) console.log(`dropped whole: ${result.dropped.join(", ")}`);
  if (result.skipped.length) console.log(`not in today's schema, so skipped: ${result.skipped.join(", ")}`);
  if (backup.capped?.length) console.log(`cut short at the backup's row cap: ${backup.capped.join(", ")}`);
  // A local server with a real key would write to real people from a copy of their data.
  const live = ["RESEND_API_KEY", "TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN", "LINE_CHANNEL_TOKEN", "WHATSAPP_TOKEN", "VAPID_PRIVATE_KEY"].filter((v) => process.env[v]);
  if (live.length) console.log(`careful: ${live.join(", ")} set in this shell. Unset them before running the app on this copy.`);
  const shown = path.relative(process.cwd(), into);
  console.log(`run it: PGLITE_DATA_DIR=${shown && !shown.startsWith("..") ? shown : into} pnpm dev`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
