import { and, desc, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import { events, matchStats, players, slots } from "@/db/schema";
import { DomainError } from "./errors";
import { BOARD_ROWS, STAT_KIND_NAMES, STAT_KINDS, boardOf, checkStat, isHealthKind, isStatKind, oncePerPair, type StatKind, type StatRefusal } from "./matchStatKinds";
import { firstName } from "./result";

/**
 * The numbers of a filmed match, as rows (the owner, 22 November 2026). The rules are in
 * `matchStatKinds.ts`; this file is the one write and the three reads.
 *
 * Who sees a number (the owner's decisions of 22 and 23 November 2026: "by default add all stats for
 * everyone always", and "Show me in rankings is on by default"):
 *   - the match page shows the match's numbers to whoever sees the match,
 *   - the public profile shows a player's bests, and a profile exists only for a player who opened one,
 *   - the club's board lists every player except one who chose "Remove me from rankings"
 *     (`players.ranking_opt_in`, on by default), like the ranking beside it,
 *   - a heart rate is kept and shown unless the player switched off "Keep my heart rate" on My stats
 *     (`share_heart_rate`, on by default); off deletes it.
 */

const HEALTH_KINDS = STAT_KIND_NAMES.filter(isHealthKind);
/** A sender's list is one match: a handful of kinds for four players. */
export const MAX_STATS_PER_WRITE = 60;

export type StatWriteRefusal = StatRefusal | "unknown_player" | "heart_off" | "not_an_entry";
export type StatWriteResult = { saved: number; refused: { index: number; why: StatWriteRefusal }[] };

/**
 * Keep the numbers of one match. `stats` is a list of `{ player, partner?, kind, value, margin? }`; a
 * player is named by id, or by the first name of somebody seated in that match when exactly one seat
 * has it (the waiting list is not a seat). An entry that may not be kept is refused by itself and the rest is saved: the answer says
 * which and why. A number that is sent again replaces the one that was there. A match that is still to
 * come or was called off takes none.
 */
export async function recordMatchStats(db: Db, input: { code: string; stats: unknown; now?: Date }): Promise<StatWriteResult> {
  if (!Array.isArray(input.stats) || input.stats.length === 0 || input.stats.length > MAX_STATS_PER_WRITE) throw new DomainError("invalid", "stats");
  const [ev] = await db.select({ id: events.id, venueSlug: events.venueSlug, capacity: events.capacity, startsAt: events.startsAt, status: events.status }).from(events).where(eq(events.code, input.code)).limit(1);
  if (!ev) throw new DomainError("not_found");
  // A match that was not played has no numbers: one that is still to come, or one that was called off.
  if (ev.status === "cancelled" || ev.startsAt > (input.now ?? new Date())) throw new DomainError("invalid", "not_played");
  const seated = await db
    .select({ id: players.id, name: players.displayName, heartYes: players.shareHeartRate })
    .from(slots)
    .innerJoin(players, eq(players.id, slots.playerId))
    .where(and(eq(slots.eventId, ev.id), inArray(slots.status, ["joined", "confirmed"]), lte(slots.position, ev.capacity)));
  const find = (who: unknown) => {
    if (typeof who !== "string" || !who.trim()) return null;
    const byId = seated.filter((p) => p.id === who);
    if (byId.length === 1) return byId[0];
    const name = who.trim().toLowerCase();
    const byName = seated.filter((p) => firstName(p.name).toLowerCase() === name);
    return byName.length === 1 ? byName[0] : null;
  };
  const refused: StatWriteResult["refused"] = [];
  const rows = new Map<string, typeof matchStats.$inferInsert>();
  input.stats.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null) return void refused.push({ index, why: "not_an_entry" });
    const e = raw as Record<string, unknown>;
    const verdict = checkStat({ kind: e.kind, value: e.value, margin: e.margin, partner: e.partner });
    if (!verdict.ok) return void refused.push({ index, why: verdict.why });
    const player = find(e.player);
    const partner = STAT_KINDS[verdict.kind].pair ? find(e.partner) : null;
    if (!player || (STAT_KINDS[verdict.kind].pair && (!partner || partner.id === player.id))) return void refused.push({ index, why: "unknown_player" });
    if (isHealthKind(verdict.kind) && !player.heartYes) return void refused.push({ index, why: "heart_off" });
    const base = { eventId: ev.id, kind: verdict.kind, value: verdict.value, margin: verdict.margin, venueSlug: ev.venueSlug };
    rows.set(`${player.id}:${verdict.kind}`, { ...base, playerId: player.id, partnerId: partner?.id ?? null });
    if (partner) rows.set(`${partner.id}:${verdict.kind}`, { ...base, playerId: partner.id, partnerId: player.id });
  });
  if (rows.size > 0) {
    await db
      .insert(matchStats)
      .values([...rows.values()])
      .onConflictDoUpdate({
        target: [matchStats.eventId, matchStats.playerId, matchStats.kind],
        set: { value: sql`excluded.value`, margin: sql`excluded.margin`, partnerId: sql`excluded.partner_id`, venueSlug: sql`excluded.venue_slug` },
      });
  }
  return { saved: rows.size, refused };
}

/** A number as a screen reads it: the kind, the value, and first names only. */
export type ShownStat = {
  eventId: string;
  kind: StatKind;
  value: number;
  margin: number | null;
  playerId: string;
  partnerId: string | null;
  name: string;
  partnerName: string | null;
};

const partners = alias(players, "partner");
const shownColumns = {
  eventId: matchStats.eventId,
  kind: matchStats.kind,
  value: matchStats.value,
  margin: matchStats.margin,
  playerId: matchStats.playerId,
  partnerId: matchStats.partnerId,
  name: players.displayName,
  partnerName: partners.displayName,
};
/** A heart rate unless its player switched it off; every other kind always. */
const heartRule = or(sql`${matchStats.kind} not in (${sql.join(HEALTH_KINDS.map((k) => sql`${k}`), sql`, `)})`, eq(players.shareHeartRate, true));
const byKind = (a: { kind: StatKind }, b: { kind: StatKind }) => STAT_KIND_NAMES.indexOf(a.kind) - STAT_KIND_NAMES.indexOf(b.kind);
function shown<T extends { kind: string; name: string; partnerName: string | null }>(rows: T[]) {
  return rows.flatMap((r) => (isStatKind(r.kind) ? [{ ...r, kind: r.kind, name: firstName(r.name), partnerName: r.partnerName == null ? null : firstName(r.partnerName) }] : []));
}

/** The numbers of one match, a pair once, in the order of the kinds. One read on the match's own index. */
export async function matchNumbers(db: Db, eventId: string): Promise<ShownStat[]> {
  const rows = await db
    .select(shownColumns)
    .from(matchStats)
    .innerJoin(players, eq(players.id, matchStats.playerId))
    .leftJoin(partners, eq(partners.id, matchStats.partnerId))
    .where(and(eq(matchStats.eventId, eventId), heartRule))
    .orderBy(matchStats.playerId)
    .limit(MAX_STATS_PER_WRITE * 2);
  return oncePerPair(shown(rows)).sort((a, b) => byKind(a, b) || b.value - a.value);
}

export type PlayerStat = ShownStat & { code: string; startsAt: Date; venueName: string | null };

/** A player's own numbers, the newest match first: "My stats" and the bests of the public profile read it. */
export async function playerNumbers(db: Db, playerId: string, limit = 200): Promise<PlayerStat[]> {
  const rows = await db
    .select({ ...shownColumns, code: events.code, startsAt: events.startsAt, venueName: events.venueName })
    .from(matchStats)
    .innerJoin(players, eq(players.id, matchStats.playerId))
    .innerJoin(events, eq(events.id, matchStats.eventId))
    .leftJoin(partners, eq(partners.id, matchStats.partnerId))
    .where(and(eq(matchStats.playerId, playerId), heartRule))
    .orderBy(desc(events.startsAt))
    .limit(limit);
  return shown(rows);
}

export type VenueRecord = ShownStat & { startsAt: Date };

/**
 * The club's board: for each kind the highest numbers at this venue, without the players who chose
 * "Remove me from rankings". A partner who chose it is not named: the pair's number shows with one name. One
 * read: a window over the venue's own index, cut at twice the board (a pair is two rows).
 */
export async function venueRecords(db: Db, venueSlug: string): Promise<Map<StatKind, VenueRecord[]>> {
  const ranked = db.$with("ranked").as(
    db
      .select({
        ...shownColumns,
        partnerName: sql<string | null>`case when ${partners.rankingOptIn} then ${partners.displayName} end`.as("partner_name"),
        name: sql<string>`${players.displayName}`.as("player_name"),
        startsAt: events.startsAt,
        place: sql<number>`row_number() over (partition by ${matchStats.kind} order by ${matchStats.value} desc)`.as("place"),
      })
      .from(matchStats)
      .innerJoin(players, eq(players.id, matchStats.playerId))
      .innerJoin(events, eq(events.id, matchStats.eventId))
      .leftJoin(partners, eq(partners.id, matchStats.partnerId))
      .where(and(eq(matchStats.venueSlug, venueSlug), eq(players.rankingOptIn, true), ne(events.status, "cancelled"), heartRule)),
  );
  const rows = await db
    .with(ranked)
    .select()
    .from(ranked)
    .where(lte(ranked.place, BOARD_ROWS * 2));
  const all = shown(rows);
  const out = new Map<StatKind, VenueRecord[]>();
  for (const kind of STAT_KIND_NAMES) {
    const board = boardOf(all, kind);
    if (board.length > 0) out.set(kind, board);
  }
  return out;
}

/**
 * "Keep my heart rate", on by default. Off deletes every heart rate the player had, in the same
 * transaction, so the switch is the whole answer and nothing stays behind it.
 */
export async function setShareHeartRate(db: Db, playerId: string, on: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(players).set({ shareHeartRate: on }).where(eq(players.id, playerId));
    if (!on) await tx.delete(matchStats).where(and(eq(matchStats.playerId, playerId), inArray(matchStats.kind, HEALTH_KINDS)));
  });
}
