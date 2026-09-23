import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { BACKUP_TABLES } from "@/lib/backup";
import { HIDDEN_COLUMNS } from "@/lib/db/readonly";

/**
 * A night's backup, loaded into a database on a laptop without the keys to anybody's account.
 *
 * The nightly backup (`src/lib/backup.ts`) is every table as it stands, which includes what signs a
 * person in (`personal_token`), what opens an organiser's door (`manage_code`) and what pushes to
 * somebody's phone (a push subscription). A copy on a laptop with those in it is a copy of everybody's
 * account. So a restore replaces every credential with a random value of the same shape (the
 * `HIDDEN_COLUMNS` the read-only role may never see), drops the push subscriptions whole, and by
 * default masks what reaches a person: addresses, phone numbers, and the messenger ids a local bot
 * token would write to. The masking maps one real value to one fake value everywhere, so a card
 * still finds its chat and an invite still finds its player.
 *
 * `scripts/restore-backup.ts` is the command; this is the part a test can hold.
 */
export type BackupFile = { format: string; at: string; tables: Record<string, Record<string, unknown>[]>; capped?: string[] };

const ADDRESS = new Set(["email", "recovery_email", "invited_email", "counterpart_email"]);
const PHONE = new Set(["phone", "invited_phone"]);
/** Telegram ids are numbers; Discord and LINE ids are text. */
const TELEGRAM_ID = new Set(["telegram_id", "telegram_user_id", "telegram_chat_id", "chat_id"]);
const TEXT_ID = new Set(["discord_id", "discord_user_id", "discord_channel_id", "discord_guild_id", "channel_id", "guild_id", "line_id", "room_id"]);
/** A row of these is nothing but a key to somebody's device. */
export const DROPPED_TABLES = new Set(["push_subscriptions"]);
/** Telegram ids fit in 52 bits (under 4.5e15). A fake from this range can never be a real chat. */
const FAKE_TELEGRAM_FROM = 5_000_000_000_000_000;

export type Scrub = (table: string, row: Record<string, unknown>) => Record<string, unknown> | null;

export function makeScrubber(o: { keepContacts?: boolean; salt?: string } = {}): Scrub {
  // A salt per run, so a masked address cannot be reversed by hashing guesses.
  const salt = o.salt ?? randomBytes(16).toString("hex");
  const hash = (kind: string, v: unknown) => createHash("sha256").update(`${salt}:${kind}:${String(v).trim().toLowerCase()}`).digest("hex");
  const replaceToken = (v: string) => {
    const alphabet = /^[0-9a-f]+$/.test(v) ? "0123456789abcdef" : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = randomBytes(v.length);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  };
  return (table, row) => {
    if (DROPPED_TABLES.has(table)) return null;
    const out: Record<string, unknown> = { ...row };
    for (const [k, v] of Object.entries(out)) {
      if (v === null || v === undefined) continue;
      if (HIDDEN_COLUMNS.includes(k)) out[k] = replaceToken(String(v));
      else if (o.keepContacts) continue;
      else if (ADDRESS.has(k)) out[k] = `masked-${hash("address", v).slice(0, 12)}@example.invalid`;
      // +999 is a country code nobody has been given.
      else if (PHONE.has(k)) out[k] = `+999${(parseInt(hash("phone", v).slice(0, 12), 16) % 1_000_000_000).toString().padStart(9, "0")}`;
      else if (TELEGRAM_ID.has(k)) out[k] = String(FAKE_TELEGRAM_FROM + (parseInt(hash("telegram", v).slice(0, 12), 16) % 1_000_000_000_000_000));
      else if (TEXT_ID.has(k)) out[k] = `masked-${hash("messenger", v).slice(0, 16)}`;
    }
    return out;
  };
}

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];

export type RestoreResult = { tables: number; rows: number; skipped: string[]; dropped: string[] };

/**
 * Empties the schema's tables and loads the file into them in one transaction. A table the file has
 * and the schema does not is skipped; a column the file lacks takes its default. Foreign keys are not
 * checked while loading, because the file's table order is alphabetical, not the order they refer.
 */
export async function restoreDump(db: Db, file: BackupFile, scrub: Scrub): Promise<RestoreResult> {
  const known = new Set(BACKUP_TABLES);
  const result: RestoreResult = { tables: 0, rows: 0, skipped: [], dropped: [] };
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local session_replication_role = replica`));
    await tx.execute(sql.raw(`truncate ${BACKUP_TABLES.map((t) => `"${t}"`).join(", ")} cascade`));
    for (const [table, raw] of Object.entries(file.tables)) {
      if (!known.has(table) || !/^[a-z_]+$/.test(table)) {
        result.skipped.push(table);
        continue;
      }
      if (DROPPED_TABLES.has(table)) {
        if (raw.length) result.dropped.push(table);
        continue;
      }
      const rows = raw.map((r) => scrub(table, r)).filter((r): r is Record<string, unknown> => r !== null);
      if (!rows.length) continue;
      const columns = rowsOf<{ name: string }>(
        await tx.execute(sql`select column_name as name from information_schema.columns where table_schema = 'public' and table_name = ${table} order by ordinal_position`),
      ).map((c) => c.name);
      const present = columns.filter((c) => rows.some((r) => c in r));
      const list = sql.join(
        present.map((c) => sql.identifier(c)),
        sql`, `,
      );
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = JSON.stringify(rows.slice(i, i + 500));
        await tx.execute(sql`insert into ${sql.identifier(table)} (${list}) select ${list} from json_populate_recordset(null::${sql.identifier(table)}, ${chunk}::json)`);
      }
      result.tables++;
      result.rows += rows.length;
    }
  });
  return result;
}
