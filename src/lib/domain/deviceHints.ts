import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { deviceHints, type DeviceHint } from "@/db/schema";
import { dayKey } from "./metrics";

/**
 * Device hints, the rows (design B, the owner's decision of 28 October 2026; DECIDING rule 40, "A device
 * hint asks 'Welcome back, Tim?'"). The values and their rules are in `hintSignals.ts`; the key and the
 * switch are in src/lib/deviceHint.ts, so this file stays free of crypto, like `merge.ts`, which reads it.
 *
 * A hint is a key, a label and two dates, kept for a player when one of the player's own acts happens in a
 * browser: a join of their own record, or a sign-in into it (an email code, Telegram, a passkey, the
 * personal link, "That's me", a held place's link, the seated question). It never signs anybody in. The
 * question reads it only to ask "Welcome back, Tim?" in another browser on the same phone (`deviceHintAsk.ts`).
 *
 * Its limits, each here once:
 *   - at most `HINTS_PER_PLAYER` rows a player: a fourth key pushes out the one seen least recently;
 *   - `HINT_KEEP_DAYS` after its last use the hourly job deletes it, `HINT_PRUNE_MAX` rows a run;
 *   - a merge moves the rows and drops a key both records held (`mergePlayers`, then `capHintsSql`);
 *   - an account deletion deletes them (`anonymizePlayer`), and they keep no record alive (`disposable.ts`);
 *   - "Don't recognise my phones" (`players.hints_off`, `setHintsOff`) deletes them all, and while it is set
 *     no door keeps one: the save's own statement inserts nothing (Thai PDPA s.32, the right to object to a
 *     use under legitimate interest). A merge keeps the mark when either record has it.
 */

export const HINTS_PER_PLAYER = 3;
/** One year after the last use: what /privacy says, through `legalValues`. */
export const HINT_KEEP_DAYS = 365;
export const HINT_PRUNE_MAX = 500;
const DAY = 24 * 3600 * 1000;

const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] }).rows ?? []));

/**
 * The cap, as one statement for a player: every row but the `keep` seen most recently goes, and every row
 * goes while the player objects (`players.hints_off`). For a merge, which may leave a survivor with six
 * (`mergePlayers`), or with the rows of a record that never objected beside a mark that the other record
 * set; for nothing else: a save keeps the cap itself.
 */
export function capHintsSql(playerId: string, keep = HINTS_PER_PLAYER) {
  return sql`delete from device_hints d where d.player_id = ${playerId} and (exists (select 1 from players p where p.id = ${playerId} and p.hints_off is not null) or d.id not in (select o.id from device_hints o where o.player_id = ${playerId} order by o.last_seen_at desc, o.created_at desc limit ${keep}))`;
}

/** Where a save happened: a match whose other remembered records a clash is counted against, by its id or its code. */
export type HintScope = { eventId: string } | { code: string } | null;

export type HintSave = { saved: boolean; collide: boolean };

/**
 * Keeps one key for one player, in one statement: the row is made or its `last_seen_at` moves, the
 * player's other rows beyond the newest `HINTS_PER_PLAYER - 1` go, and the day's counters move:
 * `hint_saved` for every save, `hint_collide` when another record in the same match already has a row of
 * this key seen within the year (`scope`; the match's places, every status, and its organiser; one read
 * down `slots_event_position_idx` and `device_hints_key_idx`). With no scope (a sign-in on My matches),
 * nothing can collide. Times go in as text with a cast, never as a Date (rule 1).
 *
 * A player who switched on "Don't recognise my phones" (`players.hints_off`) gets nothing: the same
 * statement asks the player's row first (`ok`, one lookup down the primary key, no extra round trip), and
 * then the insert, the cap and both counters do nothing. The answer is `saved: false`.
 */
export async function saveDeviceHint(db: Db, input: { playerId: string; key: string; label: string; scope?: HintScope; now?: Date }): Promise<HintSave> {
  const now = input.now ?? new Date();
  const seen = now.toISOString();
  const yearAgo = new Date(now.getTime() - HINT_KEEP_DAYS * DAY).toISOString();
  const day = dayKey(now);
  const me = input.playerId;
  const scope = input.scope ?? null;
  const event = scope === null ? null : "eventId" in scope ? sql`${scope.eventId}::uuid` : sql`(select e.id from events e where e.code = ${scope.code} limit 1)`;
  const clash = event
    ? sql`select exists (select 1 from device_hints c where c.key = ${input.key} and c.player_id <> ${me} and c.last_seen_at >= ${yearAgo}::timestamptz and c.player_id in (select s.player_id from slots s where s.event_id = ${event} and s.player_id is not null union all select e.creator_player_id from events e where e.id = ${event})) as hit`
    : sql`select false as hit`;
  const r = await db.execute(sql`
    with ok as (
      select not exists (select 1 from players p where p.id = ${me}::uuid and p.hints_off is not null) as yes
    ),
    up as (
      insert into device_hints (player_id, key, label, created_at, last_seen_at)
      select ${me}::uuid, ${input.key}::text, ${input.label}::text, ${seen}::timestamptz, ${seen}::timestamptz from ok where ok.yes
      on conflict (player_id, key) do update set last_seen_at = excluded.last_seen_at, label = excluded.label
      returning id
    ),
    gone as (
      delete from device_hints d
      where d.player_id = ${me} and d.key <> ${input.key} and (select yes from ok)
        and d.id not in (select o.id from device_hints o where o.player_id = ${me} and o.key <> ${input.key} order by o.last_seen_at desc, o.created_at desc limit ${HINTS_PER_PLAYER - 1})
      returning d.id
    ),
    clash as (select (select yes from ok) and found.hit as hit from (${clash}) found),
    counted as (
      insert into metrics_daily (day, key, value)
      select ${day}::date, 'hint_saved', 1 from up
      union all select ${day}::date, 'hint_collide', 1 from clash where hit
      on conflict (day, key) do update set value = metrics_daily.value + 1
      returning key
    )
    select (select count(*) from up)::int as saved, coalesce((select hit from clash), false) as collide, (select count(*) from counted)::int as counted, (select count(*) from gone)::int as gone
  `);
  const row = rowsOf(r)[0] ?? {};
  return { saved: Number(row.saved ?? 0) > 0, collide: row.collide === true || row.collide === "t" };
}

/** What a tap of the switch did: whether the mark moved, and how many rows went with it. */
export type HintsOffChange = { changed: boolean; forgotten: number };

/**
 * "Don't recognise my phones" on My matches (the player's lasting objection, Thai PDPA s.32; DECIDING rule
 * 40). On: one statement marks the moment (`players.hints_off`; a mark already there keeps its first
 * moment), deletes every row of the player, and counts `hint_objected` when the mark is new. Off: one
 * statement clears the mark, and the next join or sign-in keeps a key again. Only a session that is not by
 * name may call it (`hintsOffAction`). Times go in as text with a cast (rule 1).
 *
 * A save that a door started in the same instant, from another browser, may keep one row after the
 * delete. My matches then lists that phone under the switch, "Forget this phone" takes it, and every later
 * save is refused by its own statement.
 */
export async function setHintsOff(db: Db, playerId: string, off: boolean, now = new Date()): Promise<HintsOffChange> {
  const when = now.toISOString();
  const day = dayKey(now);
  const r = off
    ? await db.execute(sql`
        with mark as (
          update players set hints_off = ${when}::timestamptz where id = ${playerId}::uuid and hints_off is null returning id
        ),
        gone as (
          delete from device_hints where player_id = ${playerId}::uuid returning id
        ),
        counted as (
          insert into metrics_daily (day, key, value)
          select ${day}::date, 'hint_objected', 1 from mark
          on conflict (day, key) do update set value = metrics_daily.value + 1
          returning key
        )
        select (select count(*) from mark)::int as changed, (select count(*) from gone)::int as forgotten, (select count(*) from counted)::int as counted
      `)
    : await db.execute(sql`
        with mark as (
          update players set hints_off = null where id = ${playerId}::uuid and hints_off is not null returning id
        )
        select (select count(*) from mark)::int as changed, 0 as forgotten
      `);
  const row = rowsOf(r)[0] ?? {};
  return { changed: Number(row.changed ?? 0) > 0, forgotten: Number(row.forgotten ?? 0) };
}

/** The rows My matches lists and the export carries, oldest first: one read down `device_hints_player_idx`. Never the key. */
export async function deviceHintsOf(db: Db, playerId: string): Promise<Pick<DeviceHint, "id" | "label" | "createdAt" | "lastSeenAt">[]> {
  return db
    .select({ id: deviceHints.id, label: deviceHints.label, createdAt: deviceHints.createdAt, lastSeenAt: deviceHints.lastSeenAt })
    .from(deviceHints)
    .where(eq(deviceHints.playerId, playerId))
    .orderBy(asc(deviceHints.createdAt))
    .limit(HINTS_PER_PLAYER * 2);
}

/**
 * Forgets a player's hints: the one of this key, or every one, in one statement. The account deletion calls
 * it with no key; "Not me" under "Welcome back, Tim?" calls it with that browser's key, and so does "Sign out
 * on this browser" for the record it leaves (`signOutAction`). The reason for the sign-out: a wrong sign-in on
 * a person's own phone ("That's me" on another player's seat) saved that phone's key under the other record.
 * A phone is never shared (DECIDING, "A phone is never shared"), so the person who taps "Not you?" holds the
 * phone, and its key belongs to that person, not to the record. Returns how many went.
 */
export async function forgetDeviceHints(db: Db, playerId: string, key?: string): Promise<number> {
  const where = key === undefined ? eq(deviceHints.playerId, playerId) : and(eq(deviceHints.playerId, playerId), eq(deviceHints.key, key));
  const gone = await db.delete(deviceHints).where(where).returning({ id: deviceHints.id });
  return gone.length;
}

/** "Forget this phone" on My matches: one row, by its id, and only the player's own. True when one went. */
export async function forgetHintRow(db: Db, playerId: string, id: string): Promise<boolean> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return false;
  const gone = await db
    .delete(deviceHints)
    .where(and(eq(deviceHints.id, id), eq(deviceHints.playerId, playerId)))
    .returning({ id: deviceHints.id });
  return gone.length === 1;
}

/**
 * The counts-only report on the keys (`hintKeyStats`, GET /api/admin/hints-stats). Never a key, an id, a
 * name or a label for one player. The counts are exact, so beside the read-only door's labels and players
 * a small group shows who shares a key: the two are never joined (DECIDING rule 40).
 */
export type HintKeyStats = {
  /** Players with at least one key. */
  players: number;
  /** Keys in all: one a player and phone (the rows). */
  keys: number;
  distinctKeys: number;
  /** Keys that exactly one player holds. */
  unique: number;
  /** Keys that two players or more hold: their phones give the same values. */
  shared: number;
  /** Players who hold at least one shared key: for that phone, a key cannot tell them from somebody else. */
  indistinguishablePlayers: number;
  /** For each size of group (how many players hold one key), how many keys have that size, smallest first. */
  groups: { size: number; keys: number }[];
};

/**
 * The owner's question of 30 October 2026, "how many uniques and how many are indistinguishable?", as one
 * statement with the app's own role (the read-only role never sees `key`, rule 40). It groups the keys and
 * answers counts only: what goes out is numbers, and the label it was asked for. `label` counts the rows of
 * one label; a key has one label, because the platform is part of what makes it. A whole read of the
 * table, which holds three rows a player at most: an operator's report, never a page's.
 */
export async function hintKeyStats(db: Db, label: string | null = null): Promise<HintKeyStats> {
  const only = label === null ? sql`true` : sql`d.label = ${label}::text`;
  const r = await db.execute(sql`
    with picked as (
      select d.player_id, d.key from device_hints d where ${only}
    ),
    held as (
      select key, count(*)::int as size from picked group by key
    ),
    sizes as (
      select size, count(*)::int as keys from held group by size
    )
    select
      (select count(distinct player_id) from picked)::int as players,
      (select count(*) from picked)::int as keys,
      (select count(*) from held)::int as distinct_keys,
      (select count(*) from held where size = 1)::int as unique_keys,
      (select count(*) from held where size >= 2)::int as shared_keys,
      (select count(distinct r.player_id) from picked r join held h on h.key = r.key and h.size >= 2)::int as indistinguishable,
      (select coalesce(json_agg(json_build_object('size', size, 'keys', keys) order by size), '[]'::json) from sizes) as groups
  `);
  const row = rowsOf(r)[0] ?? {};
  const raw = typeof row.groups === "string" ? (JSON.parse(row.groups) as unknown) : row.groups;
  const groups = (Array.isArray(raw) ? raw : []).map((g: { size?: unknown; keys?: unknown }) => ({ size: Number(g.size), keys: Number(g.keys) }));
  return {
    players: Number(row.players ?? 0),
    keys: Number(row.keys ?? 0),
    distinctKeys: Number(row.distinct_keys ?? 0),
    unique: Number(row.unique_keys ?? 0),
    shared: Number(row.shared_keys ?? 0),
    indistinguishablePlayers: Number(row.indistinguishable ?? 0),
    groups,
  };
}

/**
 * The hourly job: rows last seen more than `HINT_KEEP_DAYS` ago go, at most `max` a run. The table holds
 * three rows a player at most, so the read of the old ones is small; it needs no index of its own.
 */
export async function pruneDeviceHints(db: Db, now = new Date(), max = HINT_PRUNE_MAX): Promise<number> {
  const before = new Date(now.getTime() - HINT_KEEP_DAYS * DAY);
  const old = db.select({ id: deviceHints.id }).from(deviceHints).where(lt(deviceHints.lastSeenAt, before)).limit(max);
  const r = await db.delete(deviceHints).where(inArray(deviceHints.id, old)).returning({ id: deviceHints.id });
  return r.length;
}
