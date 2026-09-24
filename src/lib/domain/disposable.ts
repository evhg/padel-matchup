import { and, eq, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily, players } from "@/db/schema";
import { playerReferences } from "./merge";
import { bumpMetric, dayKey } from "./metrics";

/**
 * Player rows nobody will miss: a test, or a visit that never became anything.
 *
 * Identity is a UUID in a cookie, so every browser that types a name becomes a row. The owner, 24
 * September 2026: "any user without any contact, without any match, is a one-time disposable user
 * or a test. Both can be removed safely without upsetting anyone." Asked how, the owner chose a daily
 * job over a one-off purge, with four conditions and fourteen days, and added one: "even if a coach
 * page exists but no lesson was ever booked, then after 14 days it can be considered a test."
 *
 * A row goes when all of these hold:
 *   1. No way to reach them: no address (nor a recovery one), no phone, no Telegram, Discord or LINE
 *      account, no push subscription (a reference, so condition 3 covers it).
 *   2. No public profile: switching one on is a deliberate act of a real person.
 *   3. Nothing else in the database points at the row — read from the schema, the same list a merge
 *      moves (`playerReferences`), so a table added next month keeps a row without anybody
 *      remembering to — except what is theirs alone and goes with them: their saved clubs, and a
 *      coach page on which no lesson was ever booked. Three references are not foreign keys and are
 *      named here: a want (`demand_signals`), a level they confirmed, a tournament's standings or
 *      resting list. A note on the feedback desk keeps the row: it is a person's own words, and the
 *      thank-you (standing order 5) needs somebody to thank.
 *   4. Fourteen days old: a new visitor is never mistaken for a disposable one while still deciding.
 *
 * Reversible it is not, so it is conservative: anything unknown keeps the row.
 */

export const DISPOSABLE_AFTER_DAYS = 14;
const DAY = 24 * 3600 * 1000;

/** What goes with the row rather than keeping it. */
const BELONGINGS = new Set(["venues.creator_player_id", "coaches.player_id"]);

const id = (s: string) => sql.identifier(s);

/**
 * The four conditions on the `players` table, as one SQL predicate. Unaliased on purpose: the age
 * goes through `lt` on the column, which hands Postgres a typed parameter (rule 1: no Date in a raw
 * template).
 */
export function disposableWhere(now: Date): SQL {
  const pointing = playerReferences()
    .filter((r) => !BELONGINGS.has(`${r.table}.${r.column}`))
    .map((r) => sql`not exists (select 1 from ${id(r.table)} x where x.${id(r.column)} = players.id)`);
  return sql.join(
    [
      lt(players.createdAt, new Date(now.getTime() - DISPOSABLE_AFTER_DAYS * DAY)),
      sql`players.email is null and players.recovery_email is null and players.phone is null and players.telegram_id is null and players.discord_id is null and players.line_id is null`,
      sql`not players.public_profile`,
      ...pointing,
      sql`not exists (select 1 from coaches c join lessons l on l.coach_id = c.id where c.player_id = players.id)`,
      sql`not exists (select 1 from demand_signals d where d.player_id = players.id)`,
      sql`not exists (select 1 from players v where v.level_verified_by = players.id)`,
      sql`not exists (select 1 from events e where e.standings @> jsonb_build_array(players.id::text))`,
      sql`not exists (select 1 from tournament_rounds r where r.resting @> jsonb_build_array(players.id::text))`,
    ],
    sql` and `,
  );
}

export type Disposed = { id: string; displayName: string; createdAt: Date };

const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] }).rows ?? []));
const toDisposed = (r: Record<string, unknown>): Disposed => ({ id: String(r.id), displayName: String(r.display_name), createdAt: new Date(String(r.created_at)) });

/** The rows that would go today, oldest first. Reads only. */
export async function findDisposablePlayers(db: Db, now = new Date(), limit = 500): Promise<Disposed[]> {
  const r = await db.execute(sql`select players.id, players.display_name, players.created_at from players where ${disposableWhere(now)} order by players.created_at limit ${limit}`);
  return rowsOf(r).map(toDisposed);
}

/**
 * Removes them, in one statement, re-checking every condition as it deletes: a row that joined a
 * match a second ago is not in the result. Their saved clubs and an empty coach page go by cascade.
 */
export async function removeDisposablePlayers(db: Db, now = new Date(), limit = 500): Promise<Disposed[]> {
  const where = disposableWhere(now);
  const r = await db.execute(sql`delete from players where players.id in (select players.id from players where ${where} order by players.created_at limit ${limit}) and ${where} returning players.id, players.display_name, players.created_at`);
  return rowsOf(r).map(toDisposed);
}

/**
 * Once a day, from the hourly job: the first run after 03:00 UTC removes the day's rows. The day's
 * metric row says it ran, so a second hourly run does nothing; `players_disposed` counts the rows.
 */
export async function removeDisposableDaily(db: Db, now = new Date()): Promise<Disposed[] | null> {
  if (now.getUTCHours() < 3) return null;
  const day = dayKey(now);
  const [done] = await db.select({ value: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.day, day), eq(metricsDaily.key, "disposable_run"))).limit(1);
  if (done) return null;
  await bumpMetric(db, "disposable_run", 1, day);
  const gone = await removeDisposablePlayers(db, now);
  if (gone.length) await bumpMetric(db, "players_disposed", gone.length, day);
  return gone;
}
