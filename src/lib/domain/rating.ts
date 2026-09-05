import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, scores, slots, type LevelLogEntry } from "@/db/schema";
import { clampLevel, matchDeltas, normalizeLevel, tournamentDeltas } from "./levels";
import { tally } from "./scores";
import { lockEvent } from "./slots";
import { getTournamentState } from "./tournament";

const LOG_CAP = 20;

/** Player declares (or re-declares) their level: quarter steps, source "self". */
export async function setPlayerLevel(db: Db, playerId: string, raw: unknown, now = new Date()): Promise<number | null> {
  const level = normalizeLevel(raw);
  if (level == null) return null;
  await db.update(players).set({ level, levelSource: "self", levelUpdatedAt: now }).where(eq(players.id, playerId));
  return level;
}

export type LevelChange = { playerId: string; from: number; to: number };

/**
 * Nudges levels from a finalized result, once per event. Matches need the
 * organizer's confirmed score and 2v2 teams; tournaments need finalized
 * standings. Safe to call repeatedly: the second call is a no-op.
 */
export async function applyEventLevels(db: Db, eventId: string, now = new Date()): Promise<{ applied: boolean; changes: LevelChange[] }> {
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, eventId);
    if (ev.levelsAppliedAt || !ev.scoreLockedByCreator || ev.status === "cancelled") return { applied: false, changes: [] };

    let deltas = new Map<string, number>();
    if (ev.type === "match") {
      const sets = await tx.select().from(scores).where(eq(scores.eventId, ev.id)).orderBy(asc(scores.setNumber));
      const roster = await tx
        .select({ playerId: slots.playerId, team: slots.team, level: players.level })
        .from(slots)
        .innerJoin(players, eq(players.id, slots.playerId))
        .where(and(eq(slots.eventId, ev.id), sql`${slots.position} <= ${ev.capacity}`, inArray(slots.status, ["joined", "confirmed"])));
      const a = roster.filter((r) => r.team === "a").map((r) => ({ id: r.playerId!, level: r.level }));
      const b = roster.filter((r) => r.team === "b").map((r) => ({ id: r.playerId!, level: r.level }));
      if (sets.length === 0 || a.length !== 2 || b.length !== 2) return { applied: false, changes: [] };
      const t = tally(sets);
      deltas = matchDeltas(a, b, t.a > t.b ? "a" : t.b > t.a ? "b" : "draw");
    } else {
      if (!ev.standings || ev.standings.length < 2) return { applied: false, changes: [] };
      const state = await getTournamentState(tx, ev, ev.standings);
      const ids = state.standings.map((r) => r.playerId);
      const levelRows = ids.length ? await tx.select({ id: players.id, level: players.level }).from(players).where(inArray(players.id, ids)) : [];
      const levelOf = new Map(levelRows.map((r) => [r.id, r.level]));
      deltas = tournamentDeltas(state.standings.map((r) => ({ id: r.playerId, level: levelOf.get(r.playerId) ?? null, rank: r.rank })));
    }

    const changes: LevelChange[] = [];
    for (const [playerId, delta] of deltas) {
      const [p] = await tx.select({ level: players.level, log: players.levelLog }).from(players).where(eq(players.id, playerId));
      if (!p || p.level == null) continue;
      const to = clampLevel(p.level + delta);
      if (to === p.level) continue;
      const entry: LevelLogEntry = { at: now.toISOString(), from: p.level, to, code: ev.code, type: ev.type };
      await tx
        .update(players)
        .set({ level: to, levelSource: "adjusted", levelUpdatedAt: now, levelLog: [...(p.log ?? []).slice(-(LOG_CAP - 1)), entry] })
        .where(eq(players.id, playerId));
      changes.push({ playerId, from: p.level, to });
    }
    await tx.update(events).set({ levelsAppliedAt: now }).where(eq(events.id, ev.id));
    return { applied: true, changes };
  });
}
