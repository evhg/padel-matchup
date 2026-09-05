import { and, eq, gte, inArray, like, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, scores, slots, type Event, type Player } from "@/db/schema";
import { venueInCity, type City } from "./cities";
import { DomainError } from "./errors";
import { isLevelVerified } from "./levels";
import { tally } from "./scores";

export { isLevelVerified, VERIFIED_TOLERANCE } from "./levels";

/**
 * The organizer of a finished event confirms a participant's level. Nothing
 * changes on the number itself: it is a second pair of eyes, shown as a tick.
 */
export async function verifyPlayerLevel(db: Db, input: { eventId: string; byPlayerId: string; playerId: string; now?: Date }): Promise<Player> {
  const now = input.now ?? new Date();
  const [ev] = await db.select().from(events).where(eq(events.id, input.eventId)).limit(1);
  if (!ev) throw new DomainError("not_found");
  if (ev.creatorPlayerId !== input.byPlayerId) throw new DomainError("forbidden");
  if (!ev.scoreLockedByCreator) throw new DomainError("invalid", "no_result");
  if (input.playerId === input.byPlayerId) throw new DomainError("invalid", "self");
  const [seat] = await db
    .select({ id: slots.id })
    .from(slots)
    .where(and(eq(slots.eventId, ev.id), eq(slots.playerId, input.playerId), inArray(slots.status, ["joined", "confirmed"]), sql`${slots.position} <= ${ev.capacity}`))
    .limit(1);
  if (!seat) throw new DomainError("not_participant");
  const [target] = await db.select().from(players).where(eq(players.id, input.playerId)).limit(1);
  if (!target) throw new DomainError("not_found");
  if (target.level == null) throw new DomainError("invalid", "level_required");
  const [updated] = await db
    .update(players)
    .set({ levelVerifiedAt: now, levelVerifiedBy: input.byPlayerId, levelVerifiedLevel: target.level })
    .where(eq(players.id, target.id))
    .returning();
  return updated;
}

export async function setRankingOptIn(db: Db, playerId: string, on: boolean): Promise<Player> {
  const [p] = await db.update(players).set({ rankingOptIn: on }).where(eq(players.id, playerId)).returning();
  return p;
}

export type RankingRow = {
  playerId: string;
  name: string;
  level: number | null;
  levelVerified: boolean;
  rank: number;
  points: number;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  /** Tournament podiums (1st to 3rd). */
  podiums: number;
};

export type RankingScope = { venueSlug: string } | { city: City };

/** Rolling season: the last 90 days. */
export const RANKING_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Points: 3 per match win, 1 per draw; tournaments give 3, 2, 1 to the podium. Opted-in players only. */
export const RANKING_POINTS = { win: 3, draw: 1, podium: [3, 2, 1] } as const;

function scopeCondition(scope: RankingScope) {
  if ("venueSlug" in scope) return eq(events.venueSlug, scope.venueSlug);
  const city = scope.city;
  const parts = [...city.venueSlugs.map((s) => eq(events.venueSlug, s)), ...city.needles.map((n) => like(events.venueSlug, `%${n}%`))];
  const inCity = parts.length ? or(...parts) : sql`${events.venueSlug} is not null`;
  return and(eq(events.tz, city.tz), inCity);
}

/**
 * Standings from finalized results in the window. Matches need the organizer's
 * confirmed score and two teams; tournaments need finalized standings.
 */
export async function getRanking(db: Db, scope: RankingScope, now = new Date()): Promise<{ rows: RankingRow[]; events: number; since: Date }> {
  const since = new Date(now.getTime() - RANKING_WINDOW_MS);
  const evs: Event[] = await db
    .select()
    .from(events)
    .where(and(eq(events.scoreLockedByCreator, true), ne(events.status, "cancelled"), gte(events.startsAt, since), scopeCondition(scope)))
    .orderBy(events.startsAt);
  const inScope = "city" in scope ? evs.filter((e) => venueInCity(scope.city, e.venueSlug, e.tz)) : evs;
  if (inScope.length === 0) return { rows: [], events: 0, since };
  const ids = inScope.map((e) => e.id);
  const seats = await db
    .select({ eventId: slots.eventId, playerId: slots.playerId, team: slots.team, position: slots.position })
    .from(slots)
    .where(and(inArray(slots.eventId, ids), inArray(slots.status, ["joined", "confirmed"])));
  const sets = await db.select().from(scores).where(inArray(scores.eventId, ids));
  const stats = new Map<string, Omit<RankingRow, "name" | "level" | "levelVerified" | "rank">>();
  const row = (p: string) => {
    let r = stats.get(p);
    if (!r) {
      r = { playerId: p, points: 0, played: 0, wins: 0, draws: 0, losses: 0, podiums: 0 };
      stats.set(p, r);
    }
    return r;
  };
  let counted = 0;
  for (const ev of inScope) {
    if (ev.type === "match") {
      const roster = seats.filter((s) => s.eventId === ev.id && s.playerId && s.position <= ev.capacity);
      const a = roster.filter((s) => s.team === "a").map((s) => s.playerId!);
      const b = roster.filter((s) => s.team === "b").map((s) => s.playerId!);
      const evSets = sets.filter((s) => s.eventId === ev.id).map((s) => ({ sideA: s.sideA, sideB: s.sideB }));
      if (a.length === 0 || b.length === 0 || evSets.length === 0) continue;
      const t = tally(evSets);
      const outcome = t.a > t.b ? "a" : t.b > t.a ? "b" : "draw";
      counted++;
      for (const side of ["a", "b"] as const) {
        for (const p of side === "a" ? a : b) {
          const r = row(p);
          r.played++;
          if (outcome === "draw") {
            r.draws++;
            r.points += RANKING_POINTS.draw;
          } else if (outcome === side) {
            r.wins++;
            r.points += RANKING_POINTS.win;
          } else r.losses++;
        }
      }
    } else if (ev.standings && ev.standings.length >= 4) {
      counted++;
      ev.standings.forEach((p, i) => {
        const r = row(p);
        r.played++;
        if (i < RANKING_POINTS.podium.length) {
          r.podiums++;
          r.points += RANKING_POINTS.podium[i];
        }
        if (i === 0) r.wins++;
        else r.losses++;
      });
    }
  }
  if (stats.size === 0) return { rows: [], events: counted, since };
  const people = await db
    .select({ id: players.id, displayName: players.displayName, level: players.level, levelVerifiedLevel: players.levelVerifiedLevel, rankingOptIn: players.rankingOptIn })
    .from(players)
    .where(and(inArray(players.id, [...stats.keys()]), eq(players.rankingOptIn, true)));
  const rows: RankingRow[] = people
    .map((p) => ({ ...stats.get(p.id)!, name: p.displayName, level: p.level, levelVerified: isLevelVerified(p), rank: 0 }))
    .filter((r) => r.played > 0)
    .sort((x, y) => y.points - x.points || y.wins / y.played - x.wins / x.played || y.played - x.played || x.name.localeCompare(y.name));
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  return { rows, events: counted, since };
}
