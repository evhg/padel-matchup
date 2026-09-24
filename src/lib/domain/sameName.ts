import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { players, type Player } from "@/db/schema";
import { safeToMerge } from "./dupes";
import { mergePlayers } from "./merge";

/**
 * The same person in two rows: one that proved who it is, and one of the same name that nobody can
 * reach, with matches on it.
 *
 * Identity is a cookie, so a second browser, a private window or an in-app browser makes a second
 * row, and the matches played from it never reach the person's own list. The owner, 24 September
 * 2026, chose how far a name may carry a merge (option A):
 *
 *   - **Automatically, at the moment of proof** (a code from their address came back, or a Telegram
 *     account was linked), when the row of the same name can be reached by nothing, and it shares a
 *     match, an organiser or a club with the person proving. The shared context is what makes a name
 *     enough: two strangers called Alex rarely also share a court and an organiser.
 *   - **Otherwise the person decides**: "Are these yours?" on My matches, with the matches shown.
 *   - **Never** a row that can be reached (an address, a phone, a chat account, a push subscription):
 *     that is somebody, and a name does not say it is the same somebody.
 *
 * `safeToMerge` still has the last word on every pair (`same_name_one_address`), so this adds a
 * guard in front of the existing rule and never widens it. Not on a nightly sweep: `dupes.ts` says why.
 */

export type SameNameRow = { id: string; displayName: string; matches: number; shared: boolean; createdAt: Date };

/** Proved: an address that came back with a code, or a Telegram account. */
export const proved = (p: Pick<Player, "emailVerifiedAt" | "telegramId">) => Boolean(p.emailVerifiedAt || p.telegramId);

const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] }).rows ?? []));

/**
 * Rows of the same name that nobody can reach and that hold at least one match, with whether each
 * shares a match, an organiser or a club with this player. Bounded: five rows.
 *
 * Two reads on purpose (rule 12). The first finds rows of the same name that nobody can reach, which
 * is almost always none, and the page stops there. Only for the few it finds does the second look at
 * matches: a single query over every seat in the database would have run on each view of My matches.
 */
export async function sameNameRows(db: Db, playerId: string): Promise<SameNameRow[]> {
  const found = rowsOf(
    await db.execute(sql`
      select o.id, o.display_name, o.created_at
      from players o, (select lower(regexp_replace(btrim(display_name), '[[:space:]]+', ' ', 'g')) as name from players where id = ${playerId}) me
      where o.id <> ${playerId}
        and me.name <> '' and o.display_name <> 'Deleted player'
        and lower(regexp_replace(btrim(o.display_name), '[[:space:]]+', ' ', 'g')) = me.name
        and o.email is null and o.recovery_email is null and o.phone is null
        and o.telegram_id is null and o.discord_id is null and o.line_id is null
        and not exists (select 1 from push_subscriptions ps where ps.player_id = o.id)
      order by o.created_at
      limit 5`),
  );
  if (found.length === 0) return [];
  const ids = sql.join(
    found.map((x) => sql`${String(x.id)}`),
    sql`, `,
  );
  const facts = rowsOf(
    await db.execute(sql`
      with mine as (
        select s.event_id as id from slots s where s.player_id = ${playerId} and s.status in ('joined', 'confirmed')
        union select e.id from events e where e.creator_player_id = ${playerId}
      ),
      orgs as (select distinct e.creator_player_id as id from events e join mine m on m.id = e.id),
      clubs as (select distinct e.venue_slug as slug from events e join mine m on m.id = e.id where e.venue_slug is not null)
      select o.id,
        (select count(*) from events e where e.creator_player_id = o.id or e.id in (select s.event_id from slots s where s.player_id = o.id)) as matches,
        exists (
          select 1 from events e
          where (e.creator_player_id = o.id or e.id in (select s.event_id from slots s where s.player_id = o.id))
            and (e.id in (select id from mine) or e.creator_player_id in (select id from orgs) or e.venue_slug in (select slug from clubs))
        ) as shared
      from players o
      where o.id in (${ids})`),
  );
  const byId = new Map(facts.map((x) => [String(x.id), x]));
  return found
    .map((x) => {
      const f = byId.get(String(x.id));
      return { id: String(x.id), displayName: String(x.display_name), createdAt: new Date(String(x.created_at)), matches: Number(f?.matches ?? 0), shared: f?.shared === true || f?.shared === "t" || f?.shared === "true" };
    })
    .filter((r) => r.matches > 0);
}

/**
 * At the moment of proof: folds in every row of the same name that nobody can reach and that shares
 * a match, an organiser or a club. Returns the ids it folded. Never throws: a proof must not fail
 * because a merge could not run.
 */
export async function foldSameNameRows(db: Db, playerId: string): Promise<string[]> {
  try {
    const [me] = await db.select().from(players).where(eq(players.id, playerId)).limit(1);
    if (!me || !proved(me)) return [];
    const rows = (await sameNameRows(db, playerId)).filter((r) => r.shared);
    const ids: string[] = [];
    for (const r of rows) {
      const [other] = await db.select().from(players).where(eq(players.id, r.id)).limit(1);
      if (other && safeToMerge(me, other).ok) ids.push(other.id);
    }
    if (ids.length) await mergePlayers(db, playerId, ids);
    return ids;
  } catch (e) {
    console.warn("[identity] folding same-name rows failed", playerId, e);
    return [];
  }
}

/**
 * "These are mine": the person folds one row in themselves. Checked again here, whatever the screen
 * showed: the person proved who they are, the row still carries their name, and still nobody can
 * reach it. Returns false when any of that no longer holds.
 */
export async function claimSameNameRow(db: Db, playerId: string, rowId: string): Promise<boolean> {
  const [me] = await db.select().from(players).where(eq(players.id, playerId)).limit(1);
  if (!me || !proved(me)) return false;
  const row = (await sameNameRows(db, playerId)).find((r) => r.id === rowId);
  if (!row) return false;
  const [other] = await db.select().from(players).where(eq(players.id, rowId)).limit(1);
  if (!other || !safeToMerge(me, other).ok) return false;
  await mergePlayers(db, playerId, [rowId]);
  return true;
}

export type SameNameMatch = { code: string; startsAt: Date; tz: string; venue: string | null; with: string[] };

/** Up to three recent matches of each row, with who else played: what a person needs to recognise their own games. One query. */
export async function sameNameMatches(db: Db, ids: string[]): Promise<Map<string, SameNameMatch[]>> {
  const out = new Map<string, SameNameMatch[]>();
  if (ids.length === 0) return out;
  const r = await db.execute(sql`
    select x.player_id, x.code, x.starts_at, x.tz, x.venue_name,
      (select string_agg(coalesce(p.display_name, s2.invited_name, '?'), '|' order by s2.position) from slots s2 left join players p on p.id = s2.player_id
        where s2.event_id = x.event_id and s2.player_id is distinct from x.player_id and s2.status in ('joined', 'confirmed')) as others
    from (
      select s.player_id, e.id as event_id, e.code, e.starts_at, e.tz, e.venue_name,
        row_number() over (partition by s.player_id order by e.starts_at desc) as rn
      from slots s join events e on e.id = s.event_id
      where s.player_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    ) x
    where x.rn <= 3
    order by x.starts_at desc`);
  for (const x of rowsOf(r)) {
    const id = String(x.player_id);
    const list = out.get(id) ?? [];
    list.push({ code: String(x.code), startsAt: new Date(String(x.starts_at)), tz: String(x.tz), venue: x.venue_name ? String(x.venue_name) : null, with: x.others ? String(x.others).split("|") : [] });
    out.set(id, list);
  }
  return out;
}
