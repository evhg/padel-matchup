import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, events, players, slots, type Event, type Slot } from "@/db/schema";
import { newInviteCode } from "@/lib/codes";
import { EVENT_DURATION_MS } from "@/lib/config";
import { DomainError } from "./errors";
import { recomputeStatus } from "./events";
import { normalizeEmail, normalizeName, normalizePhone } from "./players";

export type JoinOutcome =
  | { outcome: "joined"; slot: Slot; event: Event }
  | { outcome: "waitlisted"; slot: Slot; event: Event }
  | { outcome: "already_in"; slot: Slot; event: Event }
  | { outcome: "full"; event: Event };

export type Promotion = { slot: Slot; playerId: string };

/** Locks the event row so every slot mutation for one event is serialized. */
export async function lockEvent(tx: Db, eventId: string): Promise<Event> {
  const [ev] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
  if (!ev) throw new DomainError("not_found");
  return ev;
}

function assertLive(ev: Event, now: Date) {
  if (ev.status === "cancelled") throw new DomainError("cancelled");
  if (ev.status === "past" || ev.startsAt.getTime() + EVENT_DURATION_MS <= now.getTime()) throw new DomainError("past");
}

const VACANT: Partial<typeof slots.$inferInsert> = {
  playerId: null,
  status: "empty",
  kind: "open",
  inviteCode: null,
  invitedName: null,
  invitedEmail: null,
  invitedPhone: null,
  invitedAt: null,
  lastRemindedAt: null,
  joinedAt: null,
  team: null,
};

/**
 * Atomically claims the lowest claimable roster slot for a player.
 * Two simultaneous taps on the last slot resolve cleanly: the event row lock
 * serializes them, and the single UPDATE…WHERE id=(SELECT … LIMIT 1) claims
 * exactly one slot. The loser sees waitlist or full.
 */
export async function joinEvent(db: Db, input: { eventId: string; playerId: string; now?: Date }): Promise<JoinOutcome> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    assertLive(ev, now);

    const [existing] = await tx
      .select()
      .from(slots)
      .where(and(eq(slots.eventId, ev.id), eq(slots.playerId, input.playerId)))
      .limit(1);
    if (existing) return { outcome: "already_in", slot: existing, event: ev };

    const [claimed] = await tx
      .update(slots)
      .set({ ...VACANT, playerId: input.playerId, status: "joined", joinedAt: now })
      .where(
        eq(
          slots.id,
          sql`(select s.id from ${slots} s where s.event_id = ${ev.id} and s.position <= ${ev.capacity} and s.status in ('empty','declined') order by s.position asc limit 1)`,
        ),
      )
      .returning();

    if (claimed) {
      await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.playerId, verb: "joined" });
      const status = await recomputeStatus(tx, ev);
      return { outcome: "joined", slot: claimed, event: { ...ev, status } };
    }

    if (ev.whenFull === "closed") return { outcome: "full", event: ev };

    const [wl] = await tx
      .insert(slots)
      .values({
        eventId: ev.id,
        playerId: input.playerId,
        kind: "open",
        status: "joined",
        joinedAt: now,
        position: sql`(select coalesce(max(s.position), ${ev.capacity}) + 1 from ${slots} s where s.event_id = ${ev.id})`,
      })
      .returning();
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.playerId, verb: "joined", meta: { waitlist: 1 } });
    return { outcome: "waitlisted", slot: wl, event: ev };
  });
}

/**
 * Empties a roster slot and promotes the first waitlisted player into it.
 * Must run inside a transaction that already holds the event lock.
 */
export async function vacateAndPromote(tx: Db, ev: Event, slot: Slot): Promise<Promotion | null> {
  if (slot.position > ev.capacity) {
    // Waitlist entry: just remove it.
    await tx.delete(slots).where(eq(slots.id, slot.id));
    return null;
  }
  await tx.update(slots).set(VACANT).where(eq(slots.id, slot.id));

  const [next] = await tx
    .select()
    .from(slots)
    .where(and(eq(slots.eventId, ev.id), gt(slots.position, ev.capacity), eq(slots.status, "joined"), isNotNull(slots.playerId)))
    .orderBy(asc(slots.position))
    .limit(1);
  if (!next || !next.playerId) return null;

  await tx.delete(slots).where(eq(slots.id, next.id));
  const [promoted] = await tx
    .update(slots)
    .set({ ...VACANT, playerId: next.playerId, status: "joined", joinedAt: next.joinedAt ?? new Date() })
    .where(eq(slots.id, slot.id))
    .returning();
  await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: next.playerId, verb: "promoted" });
  return { slot: promoted, playerId: next.playerId };
}

export type LeaveResult = { left: boolean; wasWaitlisted: boolean; promotion: Promotion | null; event: Event };

export async function leaveEvent(db: Db, input: { eventId: string; playerId: string; now?: Date }): Promise<LeaveResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    if (ev.status === "cancelled") throw new DomainError("cancelled");
    if (ev.startsAt.getTime() <= now.getTime()) throw new DomainError("past");
    const [mine] = await tx
      .select()
      .from(slots)
      .where(and(eq(slots.eventId, ev.id), eq(slots.playerId, input.playerId)))
      .limit(1);
    if (!mine) throw new DomainError("not_member");
    const wasWaitlisted = mine.position > ev.capacity;
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.playerId, verb: "left" });
    const promotion = await vacateAndPromote(tx, ev, mine);
    const status = await recomputeStatus(tx, ev);
    return { left: true, wasWaitlisted, promotion, event: { ...ev, status } };
  });
}

/** Creator removes anyone (player, waitlist entry, or pending invitation). */
export async function removeFromSlot(
  db: Db,
  input: { eventId: string; slotId: string; actorPlayerId: string | null; now?: Date },
): Promise<{ removedPlayerId: string | null; removedName: string | null; promotion: Promotion | null; event: Event }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    assertLive(ev, now);
    const [slot] = await tx.select().from(slots).where(and(eq(slots.id, input.slotId), eq(slots.eventId, ev.id))).limit(1);
    if (!slot) throw new DomainError("not_found");
    if (slot.status === "empty") return { removedPlayerId: null, removedName: null, promotion: null, event: ev };
    let removedName = slot.invitedName;
    if (slot.playerId) {
      const [p] = await tx.select({ n: players.displayName }).from(players).where(eq(players.id, slot.playerId));
      removedName = p?.n ?? removedName;
    }
    await tx.insert(activity).values({
      eventId: ev.id,
      actorPlayerId: input.actorPlayerId,
      verb: "removed",
      meta: { name: removedName, targetPlayerId: slot.playerId },
    });
    const promotion = await vacateAndPromote(tx, ev, slot);
    const status = await recomputeStatus(tx, ev);
    return { removedPlayerId: slot.playerId, removedName, promotion, event: { ...ev, status } };
  });
}

/** Creator reserves a roster slot by name; returns the slot with its personal invite code. */
export async function reserveSlot(
  db: Db,
  input: { eventId: string; actorPlayerId: string | null; name: string; email?: string | null; phone?: string | null; slotId?: string | null; now?: Date },
): Promise<{ slot: Slot; event: Event }> {
  const now = input.now ?? new Date();
  const name = normalizeName(input.name);
  if (!name) throw new DomainError("invalid", "name");
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    assertLive(ev, now);
    const claimable = and(eq(slots.eventId, ev.id), sql`${slots.position} <= ${ev.capacity}`, inArray(slots.status, ["empty", "declined"]));
    const [target] = await tx
      .select()
      .from(slots)
      .where(input.slotId ? and(claimable, eq(slots.id, input.slotId)) : claimable)
      .orderBy(asc(slots.position))
      .limit(1);
    if (!target) throw new DomainError(input.slotId ? "invalid" : "full", input.slotId ? "slot_taken" : undefined);

    let slot: Slot | undefined;
    for (let attempt = 0; attempt < 5 && !slot; attempt++) {
      const inviteCode = newInviteCode();
      const [clash] = await tx.select({ id: slots.id }).from(slots).where(eq(slots.inviteCode, inviteCode)).limit(1);
      if (clash) continue;
      [slot] = await tx
        .update(slots)
        .set({
          ...VACANT,
          kind: "reserved",
          status: "invited",
          inviteCode,
          invitedName: name,
          invitedEmail: normalizeEmail(input.email),
          invitedPhone: normalizePhone(input.phone),
          invitedAt: now,
        })
        .where(eq(slots.id, target.id))
        .returning();
    }
    if (!slot) throw new Error("Could not allocate an invite code");
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.actorPlayerId, verb: "invited", meta: { name } });
    const status = await recomputeStatus(tx, ev);
    return { slot, event: { ...ev, status } };
  });
}

export type ConfirmOutcome =
  | { outcome: "confirmed"; slot: Slot; event: Event }
  | { outcome: "already_confirmed"; slot: Slot; event: Event }
  | { outcome: "already_in"; slot: Slot; event: Event }
  | { outcome: "gone"; event: Event };

export async function confirmInvite(
  db: Db,
  input: { inviteCode: string; playerId: string; email?: string | null; now?: Date },
): Promise<ConfirmOutcome> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [found] = await tx.select().from(slots).where(eq(slots.inviteCode, input.inviteCode)).limit(1);
    if (!found) throw new DomainError("not_found");
    const ev = await lockEvent(tx, found.eventId);
    assertLive(ev, now);
    const [slot] = await tx.select().from(slots).where(eq(slots.id, found.id));

    if (slot.status === "confirmed" || slot.status === "joined") {
      if (slot.playerId === input.playerId) return { outcome: "already_confirmed", slot, event: ev };
      return { outcome: "gone", event: ev };
    }
    if (slot.status === "empty") return { outcome: "gone", event: ev };

    // invited or declined → confirm
    const [elsewhere] = await tx
      .select()
      .from(slots)
      .where(and(eq(slots.eventId, ev.id), eq(slots.playerId, input.playerId)))
      .limit(1);
    if (elsewhere) {
      // Player already got in through the public link: release the reservation.
      await tx.update(slots).set(VACANT).where(eq(slots.id, slot.id));
      await recomputeStatus(tx, ev);
      return { outcome: "already_in", slot: elsewhere, event: ev };
    }

    const email = normalizeEmail(input.email);
    const [confirmed] = await tx
      .update(slots)
      .set({
        playerId: input.playerId,
        status: "confirmed",
        joinedAt: now,
        invitedEmail: email ?? slot.invitedEmail,
      })
      .where(eq(slots.id, slot.id))
      .returning();
    if (email) {
      await tx.update(players).set({ email }).where(and(eq(players.id, input.playerId), sql`${players.email} is null`));
    }
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.playerId, verb: "confirmed" });
    const status = await recomputeStatus(tx, ev);
    return { outcome: "confirmed", slot: confirmed, event: { ...ev, status } };
  });
}

export type DeclineOutcome =
  | { outcome: "declined"; slot: Slot; event: Event; promotion: Promotion | null }
  | { outcome: "already_declined"; slot: Slot; event: Event }
  | { outcome: "gone"; event: Event };

export async function declineInvite(db: Db, input: { inviteCode: string; now?: Date }): Promise<DeclineOutcome> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [found] = await tx.select().from(slots).where(eq(slots.inviteCode, input.inviteCode)).limit(1);
    if (!found) throw new DomainError("not_found");
    const ev = await lockEvent(tx, found.eventId);
    assertLive(ev, now);
    const [slot] = await tx.select().from(slots).where(eq(slots.id, found.id));
    if (slot.status === "declined") return { outcome: "already_declined", slot, event: ev };
    if (slot.status !== "invited") return { outcome: "gone", event: ev };

    const [declined] = await tx.update(slots).set({ status: "declined" }).where(eq(slots.id, slot.id)).returning();
    await tx.insert(activity).values({ eventId: ev.id, verb: "declined", meta: { name: slot.invitedName } });

    // A declined reservation is an open spot: hand it to the waitlist if any.
    let promotion: Promotion | null = null;
    const [next] = await tx
      .select({ id: slots.id })
      .from(slots)
      .where(and(eq(slots.eventId, ev.id), gt(slots.position, ev.capacity), eq(slots.status, "joined")))
      .limit(1);
    if (next) promotion = await vacateAndPromote(tx, ev, declined);

    const status = await recomputeStatus(tx, ev);
    return { outcome: "declined", slot: declined, event: { ...ev, status }, promotion };
  });
}

/** Defensive: fills any empty roster slot from the waitlist (called by cron). */
export async function promoteWaitlists(db: Db, now = new Date()): Promise<Promotion[]> {
  const candidates = await db
    .selectDistinct({ eventId: slots.eventId })
    .from(slots)
    .innerJoin(events, eq(events.id, slots.eventId))
    .where(and(gt(slots.position, events.capacity), eq(slots.status, "joined"), inArray(events.status, ["open", "full"]), gt(events.startsAt, now)));
  const promotions: Promotion[] = [];
  for (const { eventId } of candidates) {
    await db.transaction(async (tx) => {
      const ev = await lockEvent(tx, eventId);
      for (;;) {
        const [empty] = await tx
          .select()
          .from(slots)
          .where(and(eq(slots.eventId, ev.id), sql`${slots.position} <= ${ev.capacity}`, inArray(slots.status, ["empty", "declined"])))
          .orderBy(asc(slots.position))
          .limit(1);
        if (!empty) break;
        const p = await vacateAndPromote(tx, ev, empty);
        if (!p) break;
        promotions.push(p);
      }
      await recomputeStatus(tx, ev);
    });
  }
  return promotions;
}
