import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, events, metricsDaily, players, pushSubscriptions, slots } from "@/db/schema";

/**
 * Self-measured usage: counters bumped by the app, snapshots taken by the hourly cron.
 * Queries here run one after another on purpose: bursts larger than the pool make
 * postgres-js pipeline on a connection, which the Supabase transaction pooler stalls on.
 */

export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

async function databaseBytes(db: Db): Promise<number> {
  try {
    const r = (await db.execute(sql`select pg_database_size(current_database()) as n`)) as unknown as { rows?: { n: unknown }[] } & { n?: unknown }[];
    return Number(r.rows?.[0]?.n ?? r[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

export async function bumpMetric(db: Db, key: string, by = 1, day = dayKey()): Promise<void> {
  await db
    .insert(metricsDaily)
    .values({ day, key, value: by })
    .onConflictDoUpdate({ target: [metricsDaily.day, metricsDaily.key], set: { value: sql`${metricsDaily.value} + ${by}` } });
}

export async function setMetric(db: Db, key: string, value: number, day = dayKey()): Promise<void> {
  await db
    .insert(metricsDaily)
    .values({ day, key, value })
    .onConflictDoUpdate({ target: [metricsDaily.day, metricsDaily.key], set: { value } });
}

/** Daily snapshot of sizes and totals (idempotent for the day). */
export async function snapshotMetrics(db: Db): Promise<void> {
  const count = async (q: Promise<{ n: number | string }[]>) => Number((await q)[0]?.n ?? 0);
  const dbBytes = await databaseBytes(db);
  const nPlayers = await count(db.select({ n: sql<number>`count(*)` }).from(players));
  const nEvents = await count(db.select({ n: sql<number>`count(*)` }).from(events));
  const nSlots = await count(db.select({ n: sql<number>`count(*)` }).from(slots).where(inArray(slots.status, ["joined", "confirmed"])));
  const nPush = await count(db.select({ n: sql<number>`count(*)` }).from(pushSubscriptions));
  await setMetric(db, "db_bytes", dbBytes);
  await setMetric(db, "players_total", nPlayers);
  await setMetric(db, "events_total", nEvents);
  await setMetric(db, "slots_total", nSlots);
  await setMetric(db, "push_subs", nPush);
}

export type DaySeries = { days: string[]; values: Record<string, number[]> };

/** Last `n` days (oldest first) of the given metric keys, zero-filled. */
export async function metricSeries(db: Db, keys: string[], n: number, now = new Date()): Promise<DaySeries> {
  const days = Array.from({ length: n }, (_, i) => dayKey(new Date(now.getTime() - (n - 1 - i) * 86400000)));
  const rows = await db.select().from(metricsDaily).where(and(inArray(metricsDaily.key, keys), gte(metricsDaily.day, days[0])));
  const values: Record<string, number[]> = {};
  for (const k of keys) values[k] = days.map(() => 0);
  for (const r of rows) {
    const i = days.indexOf(String(r.day));
    if (i >= 0 && values[r.key]) values[r.key][i] = Number(r.value);
  }
  return { days, values };
}

/** Per-day counts derived from timestamps: new players, events created, joins (activity). */
export async function activitySeries(db: Db, n: number, now = new Date()): Promise<DaySeries> {
  const days = Array.from({ length: n }, (_, i) => dayKey(new Date(now.getTime() - (n - 1 - i) * 86400000)));
  const since = new Date(now.getTime() - (n - 1) * 86400000);
  since.setUTCHours(0, 0, 0, 0);
  const bucket = (rows: { d: unknown; n: unknown }[]) => {
    const out = days.map(() => 0);
    for (const r of rows) {
      const d = String(r.d).slice(0, 10);
      const i = days.indexOf(d);
      if (i >= 0) out[i] = Number(r.n);
    }
    return out;
  };
  const p = await db.select({ d: sql<string>`to_char(${players.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`, n: sql<number>`count(*)` }).from(players).where(gte(players.createdAt, since)).groupBy(sql`1`);
  const e = await db.select({ d: sql<string>`to_char(${events.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`, n: sql<number>`count(*)` }).from(events).where(gte(events.createdAt, since)).groupBy(sql`1`);
  const j = await db
    .select({ d: sql<string>`to_char(${activity.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`, n: sql<number>`count(*)` })
    .from(activity)
    .where(and(gte(activity.createdAt, since), inArray(activity.verb, ["joined", "confirmed"])))
    .groupBy(sql`1`);
  return { days, values: { newPlayers: bucket(p), eventsCreated: bucket(e), joins: bucket(j) } };
}

export type Totals = { players: number; events: number; matches: number; tournaments: number; upcoming: number; joinedSlots: number; pushSubs: number; dbBytes: number };

export async function totals(db: Db, now = new Date()): Promise<Totals> {
  const one = async (q: Promise<{ n: number | string }[]>) => Number((await q)[0]?.n ?? 0);
  const playersN = await one(db.select({ n: sql<number>`count(*)` }).from(players));
  const eventsN = await one(db.select({ n: sql<number>`count(*)` }).from(events));
  const matches = await one(db.select({ n: sql<number>`count(*)` }).from(events).where(eq(events.type, "match")));
  const tournaments = await one(db.select({ n: sql<number>`count(*)` }).from(events).where(eq(events.type, "tournament")));
  const upcoming = await one(db.select({ n: sql<number>`count(*)` }).from(events).where(and(gte(events.startsAt, now), inArray(events.status, ["open", "full"]))));
  const joinedSlots = await one(db.select({ n: sql<number>`count(*)` }).from(slots).where(inArray(slots.status, ["joined", "confirmed"])));
  const pushSubs = await one(db.select({ n: sql<number>`count(*)` }).from(pushSubscriptions));
  const dbBytes = await databaseBytes(db);
  return { players: playersN, events: eventsN, matches, tournaments, upcoming, joinedSlots, pushSubs, dbBytes };
}
