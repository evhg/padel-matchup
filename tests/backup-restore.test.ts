import { describe, expect, it } from "vitest";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { emailOptOuts, players, pushSubscriptions } from "@/db/schema";
import { cappedTables, dumpDatabase } from "@/lib/backup";
import { makeScrubber, restoreDump, type BackupFile } from "@/lib/backupRestore";
import { createTestDb, makePlayer } from "./helpers/db";

/**
 * A night's backup on a laptop (scripts/restore-backup.ts): real rows, and not one key to anybody's
 * account. The backup carries personal tokens and push subscriptions as they stand; this proves the
 * restore replaces the first, drops the second, masks what reaches a person, and keeps the rows
 * joined to each other.
 */

async function freshDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const db = drizzle(new PGlite()) as unknown as Db;
  await migrate(db as never, { migrationsFolder: path.resolve("drizzle") });
  return db;
}

async function backupOf(db: Db): Promise<BackupFile> {
  // The same JSON round trip the nightly file makes: dates become strings, numbers may become text.
  return JSON.parse(JSON.stringify({ format: "kicksmash-backup/1", at: "2026-09-23T03:00:00Z", tables: await dumpDatabase(db) }));
}

describe("a backup restored on a laptop", () => {
  it("keeps the rows and replaces every key to an account", async () => {
    const { db } = await createTestDb();
    const micky = await makePlayer(db, "Micky", { email: "micky@example.com", telegramId: 1248577943, phone: "+66812345678", personalToken: "Ab3dEf6hIj9k" });
    await makePlayer(db, "Erik");
    await db.insert(emailOptOuts).values({ email: "micky@example.com" });
    await db.insert(pushSubscriptions).values({ playerId: micky.id, endpoint: "https://push.example/abc", p256dh: "key", auth: "secret" });

    const target = await freshDb();
    const result = await restoreDump(target, await backupOf(db), makeScrubber());
    expect(result.dropped).toEqual(["push_subscriptions"]);

    const rows = await target.select().from(players).orderBy(players.displayName);
    expect(rows.map((p) => p.displayName)).toEqual(["Erik", "Micky"]);
    const restored = rows.find((p) => p.id === micky.id)!;
    // The same player, under the same id, whose link no longer opens anything real.
    expect(restored.personalToken).not.toBe(micky.personalToken);
    expect(restored.personalToken).toHaveLength("Ab3dEf6hIj9k".length);
    expect(restored.email).toMatch(/^masked-[0-9a-f]{12}@example\.invalid$/);
    expect(restored.phone).toMatch(/^\+999\d{9}$/);
    expect(Number(restored.telegramId)).toBeGreaterThanOrEqual(5e15);
    // One address, one mask, in every table: the opt-out still belongs to the same person.
    const [optOut] = await target.select().from(emailOptOuts);
    expect(optOut.email).toBe(restored.email);
    expect(await target.select().from(pushSubscriptions)).toEqual([]);
  });

  it("keeps the addresses when asked, and never the keys", async () => {
    const { db } = await createTestDb();
    const micky = await makePlayer(db, "Micky", { email: "micky@example.com", personalToken: "Ab3dEf6hIj9k" });
    const target = await freshDb();
    await restoreDump(target, await backupOf(db), makeScrubber({ keepContacts: true }));
    const [restored] = await target.select().from(players);
    expect(restored.email).toBe("micky@example.com");
    expect(restored.personalToken).not.toBe(micky.personalToken);
  });

  it("skips a table today's schema no longer has, and says when a table filled the cap", async () => {
    const { db } = await createTestDb();
    await makePlayer(db, "Micky");
    const file = await backupOf(db);
    file.tables.a_table_since_dropped = [{ id: 1 }];
    const target = await freshDb();
    const result = await restoreDump(target, file, makeScrubber());
    expect(result.skipped).toEqual(["a_table_since_dropped"]);
    const counted = (await target.execute(sql`select count(*)::int as n from players`)) as unknown as { rows: { n: number }[] };
    expect(counted.rows[0].n).toBe(1);
    expect(cappedTables({ players: [1, 2, 3], events: [1] }, 3)).toEqual(["players"]);
    expect(cappedTables({ players: [1, 2] }, 3)).toEqual([]);
  });
});
