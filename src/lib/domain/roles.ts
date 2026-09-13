import { sql } from "drizzle-orm";
import type { Db } from "@/db";

/**
 * Who this person is, in one round trip.
 *
 * Every screen needs the same answer — player, coach, club, series, student — and before this
 * the answer was scattered: the coach came from a browser cookie, the clubs from a list inside
 * My matches, the series from a comparison on the series page. A cookie cannot be kept honest,
 * which is how a player who had never coached was shown a coach's button: the cookie outlived
 * the role that set it.
 *
 * One query, five indexed lookups inside it, a small row back (rule 12). It runs on a page
 * render, so it must stay one round trip: the pooler stalls on pipelined bursts (rule 8), and
 * five separate awaits is exactly that burst.
 */

export type RoleClub = { slug: string; name: string };
export type RoleSeries = { slug: string; name: string };

export type RoleSet = {
  /** The coach's book this person can open, whether they own it or run it for someone. */
  coach: { handle: string; as: "coach" | "manager" } | null;
  clubs: RoleClub[];
  series: RoleSeries[];
  /** Coaches this person is an accepted student of. */
  studentOf: number;
};

export const NO_ROLES: RoleSet = { coach: null, clubs: [], series: [], studentOf: 0 };

/** How many doors besides Play this person holds; the header changes shape on it. */
export const roleCount = (r: RoleSet): number => (r.coach ? 1 : 0) + r.clubs.length + r.series.length;

const rowOf = (r: unknown): Record<string, unknown> | undefined => {
  const rows = (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
  return rows[0];
};

/** Postgres hands json back parsed on one driver and as text on another; both arrive here. */
const asJson = <T,>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
};

export async function rolesFor(db: Db, playerId: string | null | undefined): Promise<RoleSet> {
  if (!playerId) return NO_ROLES;
  const res = await db.execute(sql`
    select
      (select json_build_object('handle', c.handle, 'as', 'coach')
         from coaches c
        where c.player_id = ${playerId} and c.archived_at is null
        limit 1) as own_coach,
      (select json_build_object('handle', c.handle, 'as', 'manager')
         from coach_managers m join coaches c on c.id = m.coach_id
        where m.player_id = ${playerId} and c.archived_at is null
        limit 1) as managed_coach,
      coalesce((select json_agg(json_build_object('slug', cl.slug, 'name', cl.name) order by cl.name)
         from clubs cl
        where cl.claimed_by = ${playerId}), '[]'::json) as clubs,
      coalesce((select json_agg(json_build_object('slug', s.slug, 'name', s.name) order by s.name)
         from series s
        where s.organizer_player_id = ${playerId} and s.active), '[]'::json) as series,
      (select count(*) from coach_students cs
        where cs.player_id = ${playerId} and cs.status = 'accepted') as student_of
  `);
  const row = rowOf(res);
  if (!row) return NO_ROLES;
  const own = asJson<RoleSet["coach"]>(row.own_coach, null);
  return {
    coach: own ?? asJson<RoleSet["coach"]>(row.managed_coach, null),
    clubs: asJson<RoleClub[]>(row.clubs, []),
    series: asJson<RoleSeries[]>(row.series, []),
    studentOf: Number(row.student_of ?? 0),
  };
}
