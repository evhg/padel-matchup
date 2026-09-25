import { and, desc, eq, gte, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, scores, slots } from "@/db/schema";

/**
 * A crew's season: who played, who won, and who is on a run, over the crew's own matches of the last
 * ninety days. The owner asked for "a small season table for each crew" (25 September 2026).
 *
 * Small on purpose. It counts a match with a result and both pairs set, because a match nobody
 * scored, or scored without pairs, has no winner to count. It lists members only, by first name
 * (rule 7), and only those who played. It shows from the crew's second scored match: one result is a
 * score, not a season (rule 3). Nothing is stored: the table is read from the matches every time.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** The season is the last ninety days, the same window as the club ranking. */
export const SEASON_WINDOW_MS = 90 * DAY_MS;
/** The table appears with the crew's second scored match in the window. */
export const SEASON_MIN_MATCHES = 2;
/** 🔥 from three wins in a row: the run that also earns the streak moment (DECIDING rule 18). */
export const SEASON_HOT_STREAK = 3;
/** Seats read for one table: four a match, a match a day for ninety days, and room to spare. */
const SEASON_SEATS_MAX = 400;

/** One seat in one of the crew's scored matches, with the sets each pair won. The table is made of these. */
export type SeasonSeat = { eventId: string; startsAt: Date; playerId: string; team: "a" | "b" | null; setsA: number; setsB: number };

export type SeasonLine = { playerId: string; name: string; played: number; won: number; /** Wins in a row, from the latest match back. */ streak: number };

/** A first name: what the person typed, up to the first space. */
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

/**
 * The table, or null while the crew has fewer than two scored matches in the window. Most wins first,
 * then most played, then by name. A draw or a loss ends a run; so does a match the player sat in
 * without a pair of their own, because nobody can say they won it.
 */
export function seasonTable(seats: SeasonSeat[], members: { playerId: string; name: string }[], now: Date): SeasonLine[] | null {
  const since = now.getTime() - SEASON_WINDOW_MS;
  const inWindow = seats.filter((s) => s.startsAt.getTime() >= since && s.startsAt.getTime() <= now.getTime());
  // A match counts when both pairs are known: the winner is a side, and a side needs its players.
  const byEvent = new Map<string, SeasonSeat[]>();
  for (const s of inWindow) byEvent.set(s.eventId, [...(byEvent.get(s.eventId) ?? []), s]);
  const winner = new Map<string, "a" | "b" | "draw">();
  for (const [id, list] of byEvent) {
    if (!list.some((s) => s.team === "a") || !list.some((s) => s.team === "b")) continue;
    const { setsA, setsB } = list[0];
    winner.set(id, setsA > setsB ? "a" : setsB > setsA ? "b" : "draw");
  }
  if (winner.size < SEASON_MIN_MATCHES) return null;

  const lines: SeasonLine[] = [];
  for (const m of members) {
    const mine = inWindow.filter((s) => s.playerId === m.playerId && winner.has(s.eventId)).sort((x, y) => y.startsAt.getTime() - x.startsAt.getTime());
    if (mine.length === 0) continue;
    const won = mine.map((s) => s.team !== null && winner.get(s.eventId) === s.team);
    const streak = won.findIndex((w) => !w);
    lines.push({ playerId: m.playerId, name: firstName(m.name), played: mine.length, won: won.filter(Boolean).length, streak: streak === -1 ? won.length : streak });
  }
  return lines.sort((x, y) => y.won - x.won || y.played - x.played || x.name.localeCompare(y.name));
}

/**
 * The seats of the crew's scored matches in the window, one query: the crew's matches by
 * `events_group_idx`, their line-ups by the seats' own index, the sets each pair won counted beside
 * them. Bounded, newest first.
 */
export async function crewSeasonSeats(db: Db, groupId: string, now: Date): Promise<SeasonSeat[]> {
  const since = new Date(now.getTime() - SEASON_WINDOW_MS);
  const rows = await db
    .select({
      eventId: events.id,
      startsAt: events.startsAt,
      playerId: slots.playerId,
      team: slots.team,
      setsA: sql<number>`(select count(*)::int from ${scores} sc where sc.event_id = ${events.id} and sc.side_a > sc.side_b)`,
      setsB: sql<number>`(select count(*)::int from ${scores} sc where sc.event_id = ${events.id} and sc.side_b > sc.side_a)`,
    })
    .from(events)
    .innerJoin(slots, and(eq(slots.eventId, events.id), inArray(slots.status, ["joined", "confirmed"]), lte(slots.position, events.capacity), isNotNull(slots.playerId)))
    .where(and(eq(events.groupId, groupId), eq(events.type, "match"), ne(events.status, "cancelled"), gte(events.startsAt, since), lte(events.startsAt, now), sql`exists (select 1 from ${scores} sc where sc.event_id = ${events.id})`))
    .orderBy(desc(events.startsAt))
    .limit(SEASON_SEATS_MAX);
  return rows.map((r) => ({ eventId: r.eventId, startsAt: r.startsAt, playerId: r.playerId!, team: r.team, setsA: Number(r.setsA), setsB: Number(r.setsB) }));
}
