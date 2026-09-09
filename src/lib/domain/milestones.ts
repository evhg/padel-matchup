import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { events, milestones, players, slots, type Milestone, type Player } from "@/db/schema";
import { bandOf } from "@/lib/domain/levels";
import { getPlayerEvents, type MyEvent } from "@/lib/domain/queries";
import type { LevelChange } from "@/lib/domain/rating";

/**
 * Earned moments, and only those: a first win, the tenth and fiftieth match, three wins
 * in a row, ten different partners, a level that moved up a band, a podium. Each is
 * awarded once per player and value, so nobody is told twice and nobody is flattered
 * for showing up. Detection is pure; awarding is one insert that ignores repeats.
 */

export type MilestoneKind = "first_win" | "matches_10" | "matches_50" | "streak_3" | "partners_10" | "level_up" | "podium";
export type Detected = { kind: MilestoneKind; value: string };

const played = (past: MyEvent[]) => past.filter((m) => m.event.status !== "cancelled" && m.slot.position > 0 && m.slot.position <= m.event.capacity);

/** The moments this finished event earns for one player, given their whole history (newest first). */
export function detectMilestones(playerId: string, eventId: string, past: MyEvent[], partnersByEvent: Map<string, string[]>, levelChange?: LevelChange | null): Detected[] {
  const mine = played(past);
  const idx = mine.findIndex((m) => m.event.id === eventId);
  if (idx === -1) return [];
  const thisOne = mine[idx];
  const upToHere = mine.slice(idx); // newest first: this event and everything before it
  const out: Detected[] = [];
  const decided = upToHere.filter((m) => m.outcome === "won" || m.outcome === "lost");
  const wins = decided.filter((m) => m.outcome === "won");
  if (thisOne.outcome === "won" && wins.length === 1) out.push({ kind: "first_win", value: "1" });
  const count = upToHere.filter((m) => m.event.type === "match" ? m.outcome !== null : m.placement !== null || (m.event.standings?.length ?? 0) > 0).length;
  if (count === 10) out.push({ kind: "matches_10", value: "10" });
  if (count === 50) out.push({ kind: "matches_50", value: "50" });
  if (thisOne.outcome === "won" && decided.length >= 3 && decided.slice(0, 3).every((m) => m.outcome === "won") && !(decided.length >= 4 && decided[3].outcome === "won")) out.push({ kind: "streak_3", value: "3" });
  const partners = new Set<string>();
  for (const m of upToHere) for (const p of partnersByEvent.get(m.event.id) ?? []) if (p !== playerId) partners.add(p);
  const partnersBefore = new Set<string>();
  for (const m of upToHere.slice(1)) for (const p of partnersByEvent.get(m.event.id) ?? []) if (p !== playerId) partnersBefore.add(p);
  if (partners.size >= 10 && partnersBefore.size < 10) out.push({ kind: "partners_10", value: "10" });
  if (levelChange && levelChange.to > levelChange.from && bandOf(levelChange.to) !== bandOf(levelChange.from)) out.push({ kind: "level_up", value: bandOf(levelChange.to) });
  if (thisOne.event.type === "tournament" && thisOne.placement !== null && thisOne.placement <= 3 && (thisOne.playerCount >= 8 || thisOne.event.capacity >= 8)) out.push({ kind: "podium", value: `${thisOne.event.id}:${thisOne.placement}` });
  return out;
}

/** Partners per event for a set of players: the other player on the same team of a match. */
async function partnersFor(db: Db, playerIds: string[]): Promise<Map<string, Map<string, string[]>>> {
  const out = new Map<string, Map<string, string[]>>();
  if (playerIds.length === 0) return out;
  const mine = await db.select({ eventId: slots.eventId, playerId: slots.playerId, team: slots.team }).from(slots).where(and(inArray(slots.playerId, playerIds), inArray(slots.status, ["joined", "confirmed"])));
  const eventIds = [...new Set(mine.map((r) => r.eventId))];
  if (eventIds.length === 0) return out;
  const all = await db.select({ eventId: slots.eventId, playerId: slots.playerId, team: slots.team }).from(slots).where(and(inArray(slots.eventId, eventIds), inArray(slots.status, ["joined", "confirmed"])));
  for (const pid of playerIds) {
    const byEvent = new Map<string, string[]>();
    for (const r of mine.filter((x) => x.playerId === pid)) {
      if (!r.team) continue;
      byEvent.set(r.eventId, all.filter((x) => x.eventId === r.eventId && x.team === r.team && x.playerId && x.playerId !== pid).map((x) => x.playerId!));
    }
    out.set(pid, byEvent);
  }
  return out;
}

export type Awarded = { milestone: Milestone; player: Player };

/** After a confirmed result: every participant's new moments, inserted once, returned with the player. */
export async function awardMilestones(db: Db, eventId: string, changes: LevelChange[] = [], now = new Date()): Promise<Awarded[]> {
  const [ev] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!ev || ev.status === "cancelled") return [];
  const roster = await db.select({ playerId: slots.playerId }).from(slots).where(and(eq(slots.eventId, eventId), inArray(slots.status, ["joined", "confirmed"])));
  const ids = [...new Set(roster.map((r) => r.playerId).filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return [];
  const partners = await partnersFor(db, ids);
  const out: Awarded[] = [];
  for (const pid of ids) {
    const { past, upcoming } = await getPlayerEvents(db, pid, now);
    const history = [...past, ...upcoming.filter((m) => m.event.id === eventId)].sort((a, b) => b.event.startsAt.getTime() - a.event.startsAt.getTime());
    const [player] = await db.select().from(players).where(eq(players.id, pid)).limit(1);
    if (!player) continue;
    // The level that moved with this result, from the player's own log when the caller did not pass it.
    const logged = (player.levelLog ?? []).filter((e) => e.code === ev.code).at(-1);
    const change = changes.find((c) => c.playerId === pid) ?? (logged ? { playerId: pid, from: logged.from, to: logged.to } : null);
    const found = detectMilestones(pid, eventId, history, partners.get(pid) ?? new Map(), change);
    if (found.length === 0) continue;
    for (const d of found) {
      const [row] = await db.insert(milestones).values({ playerId: pid, kind: d.kind, value: d.value, eventId, createdAt: now }).onConflictDoNothing().returning();
      if (row) out.push({ milestone: row, player });
    }
  }
  return out;
}

export async function listMilestones(db: Db, playerId: string, limit = 12): Promise<Milestone[]> {
  return db.select().from(milestones).where(eq(milestones.playerId, playerId)).orderBy(desc(milestones.createdAt)).limit(limit);
}

export async function getMilestone(db: Db, id: string): Promise<{ milestone: Milestone; player: Player } | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const [row] = await db.select({ milestone: milestones, player: players }).from(milestones).innerJoin(players, eq(players.id, milestones.playerId)).where(eq(milestones.id, id)).limit(1);
  return row ?? null;
}
