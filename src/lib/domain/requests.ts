import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, joinRequests, players, type Event, type JoinRequest, type Player } from "@/db/schema";
import { DomainError } from "./errors";
import { joinEvent, lockEvent, type JoinOutcome } from "./slots";

export type JoinRequestWithPlayer = JoinRequest & { player: Player | null };

/** A player outside the level range asks in. One live request per player and event; a declined one stays declined. */
export async function createJoinRequest(db: Db, input: { eventId: string; playerId: string; level: number | null; now?: Date }): Promise<JoinRequest> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    if (ev.status === "cancelled") throw new DomainError("cancelled");
    if (ev.startsAt.getTime() <= now.getTime()) throw new DomainError("past");
    const [existing] = await tx.select().from(joinRequests).where(and(eq(joinRequests.eventId, ev.id), eq(joinRequests.playerId, input.playerId))).limit(1);
    if (existing && (existing.status === "pending" || existing.status === "declined" || existing.status === "approved")) return existing;
    const [row] = existing
      ? await tx.update(joinRequests).set({ status: "pending", level: input.level, createdAt: now, decidedAt: null, decidedByPlayerId: null }).where(eq(joinRequests.id, existing.id)).returning()
      : await tx.insert(joinRequests).values({ eventId: ev.id, playerId: input.playerId, level: input.level, status: "pending", createdAt: now }).returning();
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.playerId, verb: "requested", meta: { level: input.level } });
    return row;
  });
}

export async function withdrawJoinRequest(db: Db, input: { eventId: string; playerId: string }): Promise<boolean> {
  const rows = await db
    .update(joinRequests)
    .set({ status: "withdrawn", decidedAt: new Date() })
    .where(and(eq(joinRequests.eventId, input.eventId), eq(joinRequests.playerId, input.playerId), eq(joinRequests.status, "pending")))
    .returning({ id: joinRequests.id });
  return rows.length > 0;
}

/** Organizer approves (seats the player, or waitlists them) or declines. */
export async function decideJoinRequest(
  db: Db,
  input: { eventId: string; requestId: string; approve: boolean; actorPlayerId: string | null; now?: Date },
): Promise<{ request: JoinRequest; player: Player | null; join: JoinOutcome | null; event: Event }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    const [req] = await tx.select().from(joinRequests).where(and(eq(joinRequests.id, input.requestId), eq(joinRequests.eventId, ev.id))).for("update");
    if (!req) throw new DomainError("not_found");
    if (req.status !== "pending") throw new DomainError("invalid", "not_pending");
    const [player] = await tx.select().from(players).where(eq(players.id, req.playerId));
    let join: JoinOutcome | null = null;
    if (input.approve) {
      join = await joinEvent(tx, { eventId: ev.id, playerId: req.playerId, now });
      if (join.outcome === "full") throw new DomainError("full");
    }
    const [request] = await tx
      .update(joinRequests)
      .set({ status: input.approve ? "approved" : "declined", decidedAt: now, decidedByPlayerId: input.actorPlayerId })
      .where(eq(joinRequests.id, req.id))
      .returning();
    await tx.insert(activity).values({
      eventId: ev.id,
      actorPlayerId: input.actorPlayerId,
      verb: input.approve ? "approved" : "rejected",
      meta: { name: player?.displayName ?? null, targetPlayerId: req.playerId },
    });
    return { request, player: player ?? null, join, event: join?.event ?? ev };
  });
}

/** Everything but withdrawn, newest first (the page shows pending to the organizer, own state to the requester). */
export async function getJoinRequests(db: Db, eventId: string): Promise<JoinRequestWithPlayer[]> {
  const rows = await db
    .select({ request: joinRequests, player: players })
    .from(joinRequests)
    .leftJoin(players, eq(players.id, joinRequests.playerId))
    .where(eq(joinRequests.eventId, eventId))
    .orderBy(desc(joinRequests.createdAt))
    .limit(100);
  return rows.filter((r) => r.request.status !== "withdrawn").map((r) => ({ ...r.request, player: r.player }));
}
