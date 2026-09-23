import { eq, getTableName, inArray, is, sql, type SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { events, players, slots, tournamentRounds } from "@/db/schema";
import { DomainError } from "./errors";

/**
 * Every column in the schema that points at a player, with the other columns of each unique key it
 * is part of.
 *
 * Read from the schema rather than listed by hand, because the hand-written list is how merges lost
 * data. Until 23 September 2026 `mergePlayers` moved matches, slots, scores, tournaments, activity
 * and venues, then deleted the old rows, and every other table that points at a player went with
 * them: a student's place on a coach's list and their lesson packages by `on delete cascade`, their
 * lessons' student and a note's author blanked by `set null`. Erik's question lost its way back to
 * him like that, on a morning with four merges in it. A table added next month is moved without
 * anybody remembering to.
 */
export type PlayerReference = { table: string; column: string; uniqueWith: string[][] };

export function playerReferences(): PlayerReference[] {
  const out: PlayerReference[] = [];
  for (const t of Object.values(schema)) {
    if (!is(t, PgTable)) continue;
    const c = getTableConfig(t);
    const named = (cols: readonly unknown[]) => cols.map((x) => (x as { name?: unknown }).name);
    // An index on an expression has no plain column names; it is left out, and a clash on it fails
    // the merge loudly rather than losing a row quietly.
    const keys = [
      ...c.indexes.filter((i) => i.config.unique).map((i) => named(i.config.columns)),
      ...c.uniqueConstraints.map((u) => named(u.columns)),
      ...c.primaryKeys.map((p) => named(p.columns)),
      ...c.columns.filter((col) => col.isUnique || col.primary).map((col) => [col.name]),
    ].filter((k): k is string[] => k.every((n) => typeof n === "string"));
    for (const fk of c.foreignKeys) {
      const ref = fk.reference();
      if (getTableName(ref.foreignTable) !== "players") continue;
      for (const col of ref.columns) {
        out.push({ table: c.name, column: col.name, uniqueWith: keys.filter((k) => k.includes(col.name)).map((k) => k.filter((n) => n !== col.name)) });
      }
    }
  }
  return out;
}

/** One row per player, and deleting the source's would take real data with it: both having one is a person to ask, not a merge to run. */
const REFUSE_WHEN_BOTH = new Set(["coaches"]);

const ident = (s: string) => sql.identifier(s);
const count = (r: unknown) => (Array.isArray(r) ? r.length : ((r as { rows?: unknown[] }).rows ?? []).length);

/**
 * Folds identities `from` into `into`, in one transaction, and deletes the sources.
 *
 * Three things keep a rule of their own: a seat in a match both already hold (the source's is
 * freed), and a player id inside a tournament round's resting list or an event's standings (arrays,
 * not foreign keys). Everything else that points at a player moves, table by table from the schema.
 * Where a unique key would clash — both in the same group, both students of one coach — the
 * survivor's row stays and the source's goes. Then the sources are deleted, and the survivor takes
 * any address or chat account it lacked. Crypto-free on purpose so slot code (reachable from client
 * bundles) can import it.
 */
export async function mergePlayers(db: Db, into: string, from: string[]): Promise<void> {
  const sources = [...new Set(from)].filter((id) => id !== into);
  if (sources.length === 0) return;
  await db.transaction(async (tx) => {
    const [target] = await tx.select().from(players).where(eq(players.id, into));
    if (!target) throw new DomainError("not_found");
    const srcRows = await tx.select().from(players).where(inArray(players.id, sources));

    const mine = await tx.select({ eventId: slots.eventId }).from(slots).where(eq(slots.playerId, into));
    const mineEvents = new Set(mine.map((m) => m.eventId));
    const theirs = await tx.select().from(slots).where(inArray(slots.playerId, sources));
    for (const s of theirs) {
      if (mineEvents.has(s.eventId)) {
        const [ev] = await tx.select({ capacity: events.capacity }).from(events).where(eq(events.id, s.eventId));
        if (ev && s.position > ev.capacity) await tx.delete(slots).where(eq(slots.id, s.id));
        else
          await tx
            .update(slots)
            .set({ playerId: null, status: "empty", kind: "open", inviteCode: null, invitedName: null, invitedEmail: null, invitedPhone: null, invitedAt: null, lastRemindedAt: null, joinedAt: null, team: null })
            .where(eq(slots.id, s.id));
      } else {
        await tx.update(slots).set({ playerId: into }).where(eq(slots.id, s.id));
        mineEvents.add(s.eventId);
      }
    }

    const rounds = await tx.select({ id: tournamentRounds.id, resting: tournamentRounds.resting }).from(tournamentRounds);
    for (const r of rounds) {
      if (r.resting.some((id) => sources.includes(id))) {
        await tx.update(tournamentRounds).set({ resting: [...new Set(r.resting.map((id) => (sources.includes(id) ? into : id)))] }).where(eq(tournamentRounds.id, r.id));
      }
    }
    const withStandings = await tx.select({ id: events.id, standings: events.standings }).from(events).where(sql`${events.standings} is not null`);
    for (const e of withStandings) {
      if (e.standings?.some((id) => sources.includes(id))) {
        await tx.update(events).set({ standings: [...new Set(e.standings.map((id) => (sources.includes(id) ? into : id)))] }).where(eq(events.id, e.id));
      }
    }

    for (const ref of playerReferences()) {
      const t = ident(ref.table);
      const c = ident(ref.column);
      for (const src of sources) {
        for (const other of ref.uniqueWith) {
          if (other.length === 0) {
            // One row per player: the survivor's stays and the source's goes, unless that loses data.
            const both = count(await tx.execute(sql`select 1 from ${t} a where a.${c} = ${src} and exists (select 1 from ${t} b where b.${c} = ${into})`));
            if (both && REFUSE_WHEN_BOTH.has(ref.table)) throw new DomainError("invalid");
            if (both) await tx.execute(sql`delete from ${t} where ${c} = ${src}`);
            continue;
          }
          // Both rows would share this key once moved: keep the survivor's. `=` on purpose, not
          // `is not distinct from`: a unique key lets two NULLs stand side by side, so they never clash.
          const same: SQL = sql.join(
            other.map((k) => sql`b.${ident(k)} = a.${ident(k)}`),
            sql` and `,
          );
          await tx.execute(sql`delete from ${t} a where a.${c} = ${src} and exists (select 1 from ${t} b where b.${c} = ${into} and ${same})`);
        }
        await tx.execute(sql`update ${t} set ${c} = ${into} where ${c} = ${src}`);
      }
    }

    // After the sources are gone: a chat account is unique to one row, so the survivor can only take
    // it once nobody else holds it.
    const first = <K extends keyof (typeof srcRows)[number]>(k: K) => srcRows.find((s) => s[k] !== null && s[k] !== undefined)?.[k] ?? null;
    const patch: Partial<typeof players.$inferInsert> = {};
    if (!target.email && first("email")) patch.email = first("email");
    if (!target.phone && first("phone")) patch.phone = first("phone");
    if (!target.telegramId && first("telegramId")) patch.telegramId = first("telegramId");
    if (!target.discordId && first("discordId")) patch.discordId = first("discordId");
    if (!target.lineId && first("lineId")) patch.lineId = first("lineId");
    await tx.delete(players).where(inArray(players.id, sources));
    if (Object.keys(patch).length) await tx.update(players).set(patch).where(eq(players.id, into));
  });
}
