import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, coaches, events, joinRequests, levelChecks, players, type Club, type Coach, type Event, type LevelCheck, type Player } from "@/db/schema";
import { isClubLive } from "./clubs";
import { coachesAtClub } from "./coaching";
import { DomainError } from "./errors";
import { joinGroup } from "./groups";
import { admission, normalizeLevel } from "./levels";
import { decideJoinRequest } from "./requests";
import type { JoinOutcome } from "./slots";

/**
 * Verified levels. A level is a claim until someone who saw the player play
 * confirms it: the organizer of a finished match (ranking.ts), a coach, or the
 * club. A verified-only event admits confirmed levels inside its range and
 * sends everyone else to the organizer's list, exactly like an out-of-range
 * level. A player on that list asks a coach at the club, or the club, in one
 * tap; the confirmation seats them without anyone else typing.
 */

export type VerifierSource = "organizer" | "coach" | "club";
export type Verifier = { kind: "coach"; id: string; name: string } | { kind: "club"; slug: string; name: string };
export type LevelCheckTarget = { coachId: string } | { clubSlug: string };
export type LevelCheckWithPlayer = LevelCheck & { player: Player };

/** Who can confirm a level for this event: listed coaches who named the venue as their club, then the live club itself (when claimed). */
export async function verifiersFor(db: Db, ev: Pick<Event, "venueName" | "venueSlug">): Promise<Verifier[]> {
  const out: Verifier[] = [];
  if (ev.venueName) for (const c of await coachesAtClub(db, ev.venueName)) out.push({ kind: "coach", id: c.id, name: c.displayName });
  if (ev.venueSlug) {
    const [club] = await db.select().from(clubs).where(eq(clubs.slug, ev.venueSlug)).limit(1);
    if (club && isClubLive(club) && club.claimedBy) out.push({ kind: "club", slug: club.slug, name: club.name });
  }
  return out;
}

/** Confirms a player's level: the verifier's number becomes the level when it differs, and the tick records who confirmed. */
export async function confirmLevel(db: Db, input: { playerId: string; level?: unknown; byPlayerId: string | null; source: VerifierSource; now?: Date }): Promise<Player> {
  const now = input.now ?? new Date();
  const [p] = await db.select().from(players).where(eq(players.id, input.playerId)).limit(1);
  if (!p) throw new DomainError("not_found");
  const wanted = input.level === undefined || input.level === null ? p.level : normalizeLevel(input.level);
  if (wanted == null) throw new DomainError("invalid", "level_required");
  const set: Partial<typeof players.$inferInsert> = { levelVerifiedAt: now, levelVerifiedBy: input.byPlayerId, levelVerifiedLevel: wanted, levelVerifiedSource: input.source };
  if (p.level == null || Math.abs(p.level - wanted) > 1e-9) Object.assign(set, { level: wanted, levelSource: "confirmed", levelUpdatedAt: now });
  const [u] = await db.update(players).set(set).where(eq(players.id, p.id)).returning();
  return u;
}

const targetWhere = (t: LevelCheckTarget) => ("coachId" in t ? eq(levelChecks.coachId, t.coachId) : eq(levelChecks.clubSlug, t.clubSlug));

/** The coach or club behind a target, when it can still answer; null otherwise. */
export async function resolveTarget(db: Db, t: LevelCheckTarget): Promise<{ coach: Coach; club: null } | { coach: null; club: Club } | null> {
  if ("coachId" in t) {
    const [coach] = await db.select().from(coaches).where(and(eq(coaches.id, t.coachId), isNull(coaches.archivedAt))).limit(1);
    return coach ? { coach, club: null } : null;
  }
  const [club] = await db.select().from(clubs).where(eq(clubs.slug, t.clubSlug)).limit(1);
  return club && isClubLive(club) && club.claimedBy ? { coach: null, club } : null;
}

/** Is this target one of the event's verifiers (a coach at the venue, or the live club itself)? */
export const isVerifierFor = (verifiers: Verifier[], t: LevelCheckTarget): boolean => verifiers.some((v) => ("coachId" in t ? v.kind === "coach" && v.id === t.coachId : v.kind === "club" && v.slug === t.clubSlug));

/**
 * A player asks a coach or a club to confirm their level. One open ask per
 * pair: asking again returns the open one (`created: false`, so nobody is
 * notified twice); two asks at the same instant meet the partial unique index
 * and the second reads the first.
 */
export async function askLevelCheck(db: Db, input: { playerId: string; target: LevelCheckTarget; eventId?: string | null; now?: Date }): Promise<{ check: LevelCheck; created: boolean }> {
  const now = input.now ?? new Date();
  const [p] = await db.select().from(players).where(eq(players.id, input.playerId)).limit(1);
  if (!p) throw new DomainError("not_found");
  if (p.level == null) throw new DomainError("invalid", "level_required");
  const target = await resolveTarget(db, input.target);
  if (!target) throw new DomainError("not_found");
  if (target.coach?.playerId === p.id || target.club?.claimedBy === p.id) throw new DomainError("invalid", "self");
  const open = () => db.select().from(levelChecks).where(and(eq(levelChecks.playerId, p.id), targetWhere(input.target), eq(levelChecks.status, "pending"))).limit(1);
  const [existing] = await open();
  if (existing) return { check: existing, created: false };
  const [row] = await db
    .insert(levelChecks)
    .values({ playerId: p.id, coachId: target.coach?.id ?? null, clubSlug: target.club?.slug ?? null, level: p.level, eventId: input.eventId ?? null, status: "pending", createdAt: now })
    .onConflictDoNothing()
    .returning();
  if (row) return { check: row, created: true };
  const [raced] = await open();
  if (!raced) throw new DomainError("not_found");
  return { check: raced, created: false };
}

/** Open asks for a coach or a club, oldest first, with the player. */
export async function listLevelChecks(db: Db, target: LevelCheckTarget, limit = 50): Promise<LevelCheckWithPlayer[]> {
  const rows = await db
    .select({ check: levelChecks, player: players })
    .from(levelChecks)
    .innerJoin(players, eq(players.id, levelChecks.playerId))
    .where(and(targetWhere(target), eq(levelChecks.status, "pending")))
    .orderBy(asc(levelChecks.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.check, player: r.player }));
}

/** The player's own open asks (to grey out the buttons they already tapped). */
export async function myLevelChecks(db: Db, playerId: string): Promise<LevelCheck[]> {
  return db.select().from(levelChecks).where(and(eq(levelChecks.playerId, playerId), eq(levelChecks.status, "pending"))).orderBy(asc(levelChecks.createdAt)).limit(20);
}

export async function withdrawLevelCheck(db: Db, id: string, playerId: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(levelChecks)
    .set({ status: "withdrawn", decidedAt: now })
    .where(and(eq(levelChecks.id, id), eq(levelChecks.playerId, playerId), eq(levelChecks.status, "pending")))
    .returning({ id: levelChecks.id });
  return rows.length > 0;
}

/** The coach or club answers: confirmed (at the declared level, or the number they choose) or declined. */
export async function decideLevelCheck(
  db: Db,
  input: { id: string; target: LevelCheckTarget; approve: boolean; level?: unknown; byPlayerId: string | null; now?: Date },
): Promise<{ check: LevelCheck; player: Player }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [check] = await tx.select().from(levelChecks).where(and(eq(levelChecks.id, input.id), targetWhere(input.target))).for("update");
    if (!check) throw new DomainError("not_found");
    if (check.status !== "pending") throw new DomainError("invalid", "not_pending");
    let player: Player;
    let decidedLevel: number | null = null;
    if (input.approve) {
      player = await confirmLevel(tx, { playerId: check.playerId, level: input.level ?? check.level, byPlayerId: input.byPlayerId, source: "coachId" in input.target ? "coach" : "club", now });
      decidedLevel = player.levelVerifiedLevel;
    } else {
      const [p] = await tx.select().from(players).where(eq(players.id, check.playerId)).limit(1);
      if (!p) throw new DomainError("not_found");
      player = p;
    }
    const [updated] = await tx
      .update(levelChecks)
      .set({ status: input.approve ? "confirmed" : "declined", decidedAt: now, decidedByPlayerId: input.byPlayerId, decidedLevel })
      .where(eq(levelChecks.id, check.id))
      .returning();
    return { check: updated, player };
  });
}

export type Admitted = { event: Event; join: JoinOutcome };

/**
 * After a confirmation: every open ask to join a coming verified-only event
 * that the confirmed level now fits is approved, as if the organizer had
 * tapped. Full events keep the ask pending (the organizer still decides).
 */
export async function admitConfirmed(db: Db, player: Player, byPlayerId: string | null, now = new Date()): Promise<Admitted[]> {
  const rows = await db
    .select({ request: joinRequests, event: events })
    .from(joinRequests)
    .innerJoin(events, eq(events.id, joinRequests.eventId))
    .where(and(eq(joinRequests.playerId, player.id), eq(joinRequests.status, "pending"), eq(events.levelVerifiedOnly, true), gt(events.startsAt, now), sql`${events.status} <> 'cancelled'`))
    .limit(20);
  const out: Admitted[] = [];
  for (const { request, event } of rows) {
    if (admission(event, player) !== "ok") continue;
    try {
      const res = await decideJoinRequest(db, { eventId: event.id, requestId: request.id, approve: true, actorPlayerId: byPlayerId, now });
      if (res.join) {
        out.push({ event: res.event, join: res.join });
        // A seat in a group's match makes you part of the group, the same as tapping Join would.
        if (event.groupId && (res.join.outcome === "joined" || res.join.outcome === "waitlisted")) await joinGroup(db, event.groupId, player.id).catch(() => undefined);
      }
    } catch {
      // Full or already decided: the organizer's list keeps it.
    }
  }
  return out;
}
