import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, scores, slots, type Score, type Slot } from "@/db/schema";
import { venueInCity } from "./cities";
import { scopeCondition, type RankingScope } from "./ranking";
import { endedBy } from "./reminders";
import { firstName, matchResult } from "./result";

/**
 * The "Recent results" strip on a club page and a city page: the last scored matches played there.
 *
 * A club page showed a ranking table that read "No finalized results here yet" beside matches that
 * had a score, because the ranking waits for the organiser's confirmation and for players who opted
 * in. The strip asks less and shows less: a score, the first names, the day, and the result card.
 *
 * A name still follows the ranking's consent. A player who switched on `ranking_opt_in` shows by
 * first name; every other seat shows as "Player". The help text under that switch, and the levels
 * FAQ, promise that club and city pages name only those who switched it on. These pages are indexed.
 *
 * What counts is what the city board already lists: a match its organiser put on the venue board
 * (`public_listing`), never cancelled, from the last half year. On top of that it must be over by
 * its own length (`endedBy`) and carry at least one set.
 */

/** How many results the strip shows. */
export const RECENT_RESULTS = 10;

/** The city board's window: a match from before it is not "recent" any more. */
export const RECENT_RESULTS_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

export type RecentResult = {
  code: string;
  startsAt: Date;
  tz: string;
  venueName: string | null;
  /** First names per side, as the result card has them; null for a player who did not opt in. */
  a: (string | null)[];
  b: (string | null)[];
  /** Empty when only the winner is known. */
  sets: { sideA: number; sideB: number }[];
  winner: "a" | "b" | "draw";
};

type Row = {
  code: string;
  startsAt: Date;
  tz: string;
  venueName: string | null;
  venueSlug: string | null;
  sets: Pick<Score, "setNumber" | "sideA" | "sideB">[] | null;
  roster: (Pick<Slot, "team" | "status"> & { name: string; optIn: boolean })[] | null;
};

/**
 * Stands in for the name of a player who did not opt in, while `matchResult` sorts the seats into
 * sides. A typed name can never be it. The seat keeps its place: a seat with no name at all ("?")
 * stays as it is, so `matchResult` still leaves an empty invitation out.
 */
const UNNAMED = "\u0000";

/**
 * One row of the query as a line of the strip, through the same `matchResult` the result card reads,
 * so the two never disagree about who won. Null when the result has no two sides to name. Pure.
 */
export function toRecentResult(row: Row): RecentResult | null {
  const roster = (row.roster ?? []).map((s) => ({ team: s.team, status: s.status, name: s.optIn ? firstName(s.name) : s.name.trim() === "" || s.name === "?" ? s.name : UNNAMED }));
  const r = matchResult(row.sets ?? [], roster);
  if (!r || !r.hasTeams) return null;
  const named = (side: string[]) => side.map((n) => (n === UNNAMED ? null : n));
  return { code: row.code, startsAt: row.startsAt, tz: row.tz, venueName: row.venueName, a: named(r.a), b: named(r.b), sets: r.sets, winner: r.winner };
}

/**
 * The strip for one venue or one city: one query, newest first, at most `RECENT_RESULTS` rows.
 *
 * The sets and the seats come back inside each row as JSON, so ten results cost one round trip and
 * not twenty-one (rule 12). The inner tables are aliased and the outer one is named by hand: in a
 * select from one table drizzle writes `${events.id}` bare, which the subquery would read as its own.
 */
export async function recentResults(db: Db, scope: RankingScope, now = new Date()): Promise<RecentResult[]> {
  const since = new Date(now.getTime() - RECENT_RESULTS_WINDOW_MS);
  const rows: Row[] = await db
    .select({
      code: events.code,
      startsAt: events.startsAt,
      tz: events.tz,
      venueName: events.venueName,
      venueSlug: events.venueSlug,
      sets: sql<Row["sets"]>`(select json_agg(json_build_object('setNumber', sc.set_number, 'sideA', sc.side_a, 'sideB', sc.side_b)) from ${scores} sc where sc.event_id = ${events}.id)`,
      roster: sql<Row["roster"]>`(select json_agg(json_build_object('team', sl.team, 'status', sl.status, 'name', coalesce(p.display_name, sl.invited_name, '?'), 'optIn', coalesce(p.ranking_opt_in, false)) order by sl.position) from ${slots} sl left join ${players} p on p.id = sl.player_id where sl.event_id = ${events}.id and sl.position <= ${events}.capacity)`,
    })
    .from(events)
    .where(
      and(
        eq(events.type, "match"),
        eq(events.publicListing, true),
        inArray(events.status, ["open", "full", "past"]),
        gte(events.startsAt, since),
        ...endedBy(now),
        sql`exists (select 1 from ${scores} sc where sc.event_id = ${events}.id)`,
        scopeCondition(scope),
      ),
    )
    .orderBy(desc(events.startsAt), desc(events.id))
    .limit(RECENT_RESULTS);
  const inScope = "city" in scope ? rows.filter((r) => venueInCity(scope.city, r.venueSlug, r.tz)) : rows;
  return inScope.map(toRecentResult).filter((r): r is RecentResult => r !== null);
}
