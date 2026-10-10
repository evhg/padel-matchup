import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, slots, tournamentRounds, type Event, type Slot } from "@/db/schema";
import { newInviteCode } from "@/lib/codes";
import { DomainError } from "./errors";
import { recomputeStatus } from "./events";
import { isNamedSeat, seatUnits } from "./fixedPairs";
import { isOver } from "./matchLength";
import { normalizeName } from "./players";
import { joinEvent, lockEvent, reserveLocked, vacateSeats, type JoinOutcome, type Promotion } from "./slots";

/**
 * The seats of a fixed-pairs night (the owner's decision F, 9 October 2026): pairs sign up together,
 * a single player is listed as "Partner needed", and anybody can be their partner.
 *
 * A pair is two named seats sharing `slots.pair_id` (`seatUnits`). Every write here is one
 * transaction under the event lock, like every other seat write, and a pair always gets a fresh key:
 * a key is never handed on, so a seat that once belonged to a pair cannot rejoin a different one.
 *
 * The partner is a name until they claim the spot (DECIDING rule 24): the name becomes a reserved seat
 * with its own invite link, the same row the organiser's "reserve for someone" makes, and whoever
 * opens that link confirms it, signed in or by typing their name. Nothing is sent to the name.
 *
 * Leaving needs nothing new for one partner: `leaveEvent` empties the seat, its key goes with it, and
 * the other half reads as a single. `vacateAndPromote` lets the waiting list in by pairs on such a
 * night (`vacateSeats`), and the notices are the ones every promotion and every removal already sends.
 */

function assertOpen(ev: Event, now: Date) {
  if (ev.status === "cancelled") throw new DomainError("cancelled");
  if (ev.status === "past" || isOver(ev, now)) throw new DomainError("past");
}

function assertPairs(ev: Event) {
  if (ev.type !== "tournament" || !ev.fixedPairs) throw new DomainError("invalid", "not_fixed_pairs");
}

const newPairId = () => crypto.randomUUID();

async function seatsOf(tx: Db, ev: Event): Promise<Slot[]> {
  return tx.select().from(slots).where(eq(slots.eventId, ev.id)).orderBy(asc(slots.position));
}

/** The seat's partner: the other named seat with its key, or null for a single. */
export function partnerOf<T extends { id: string; pairId: string | null; status: string; position: number }>(seats: readonly T[], seat: T): T | null {
  for (const u of seatUnits(seats)) if (u.kind === "pair" && u.seats.some((s) => s.id === seat.id)) return u.seats.find((s) => s.id !== seat.id)!;
  return null;
}

/** An invite code nobody holds, for a reserved seat on the waiting list (`reserveLocked` makes one for a roster seat). */
async function freeInviteCode(tx: Db): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newInviteCode();
    const [clash] = await tx.select({ id: slots.id }).from(slots).where(eq(slots.inviteCode, code)).limit(1);
    if (!clash) return code;
  }
  throw new Error("Could not allocate an invite code");
}

/** A seat at the end of the waiting list. */
async function appendWaiting(tx: Db, ev: Event, values: Partial<typeof slots.$inferInsert>): Promise<Slot> {
  const [row] = await tx
    .insert(slots)
    .values({ eventId: ev.id, kind: "open", status: "joined", ...values, position: sql`(select coalesce(max(s.position), ${ev.capacity}) + 1 from ${slots} s where s.event_id = ${ev.id})` })
    .returning();
  return row;
}

/** The partner's name as a reserved seat: a free roster seat when `slotId` is given, else the end of the waiting list. */
async function reservePartner(tx: Db, ev: Event, input: { actorPlayerId: string | null; name: string; slotId: string | null; pairId: string; now: Date }): Promise<Slot> {
  if (input.slotId) {
    const { slot } = await reserveLocked(tx, ev, { actorPlayerId: input.actorPlayerId, name: input.name, slotId: input.slotId, now: input.now });
    const [paired] = await tx.update(slots).set({ pairId: input.pairId }).where(eq(slots.id, slot.id)).returning();
    return paired;
  }
  const row = await appendWaiting(tx, ev, { kind: "reserved", status: "invited", inviteCode: await freeInviteCode(tx), invitedName: input.name, invitedAt: input.now, pairId: input.pairId });
  await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.actorPlayerId, verb: "invited", meta: { name: input.name } });
  return row;
}

export type PairJoinOutcome = JoinOutcome & {
  /** The partner's reserved seat, with the invite link's code, when a name was given and it found a place. */
  partner?: Slot | null;
};

/**
 * Join a fixed-pairs night, with a partner's name or alone.
 *
 * - Alone: `joinEvent` as on any night, and the seat reads "Partner needed".
 * - With a name: two seats, the player's and the partner's reserved one, sharing a fresh key. When
 *   fewer than two seats are free the pair waits together at the end of the waiting list (or the
 *   night says full when it keeps no list).
 * - Already in as a single, with a name: the name becomes their partner, in a free seat beside them
 *   on the roster, or behind them on the waiting list. With no free seat the roster single stays a
 *   single and hears `full`.
 * - Already in a pair: `already_in`.
 */
export async function joinPair(db: Db, input: { eventId: string; playerId: string; partnerName?: string | null; now?: Date }): Promise<PairJoinOutcome> {
  const now = input.now ?? new Date();
  const partnerName = normalizeName(input.partnerName ?? "");
  if (!partnerName) return joinEvent(db, { eventId: input.eventId, playerId: input.playerId, now });
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    assertOpen(ev, now);
    assertPairs(ev);
    const seats = await seatsOf(tx, ev);
    const mine = seats.find((s) => s.playerId === input.playerId);
    const free = seats.filter((s) => s.position <= ev.capacity && (s.status === "empty" || s.status === "declined"));
    const pairId = newPairId();
    if (mine) {
      if (partnerOf(seats, mine)) return { outcome: "already_in", slot: mine, event: ev };
      const onRoster = mine.position <= ev.capacity;
      if (onRoster && free.length === 0) return { outcome: "full", event: ev };
      const partner = await reservePartner(tx, ev, { actorPlayerId: input.playerId, name: partnerName, slotId: onRoster ? free[0].id : null, pairId, now });
      const [slot] = await tx.update(slots).set({ pairId }).where(eq(slots.id, mine.id)).returning();
      const status = await recomputeStatus(tx, ev);
      return { outcome: "already_in", slot, event: { ...ev, status }, partner };
    }
    if (free.length >= 2) {
      const [slot] = await tx
        .update(slots)
        .set({ playerId: input.playerId, status: "joined", kind: "open", joinedAt: now, pairId, inviteCode: null, invitedName: null, invitedEmail: null, invitedPhone: null, invitedAt: null, lastRemindedAt: null, team: null })
        .where(eq(slots.id, free[0].id))
        .returning();
      await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.playerId, verb: "joined", createdAt: now });
      const partner = await reservePartner(tx, ev, { actorPlayerId: input.playerId, name: partnerName, slotId: free[1].id, pairId, now });
      const status = await recomputeStatus(tx, ev);
      return { outcome: "joined", slot, event: { ...ev, status }, partner };
    }
    if (ev.whenFull === "closed") return { outcome: "full", event: ev };
    const slot = await appendWaiting(tx, ev, { playerId: input.playerId, joinedAt: now, pairId });
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.playerId, verb: "joined", meta: { waitlist: 1 }, createdAt: now });
    const partner = await reservePartner(tx, ev, { actorPlayerId: input.playerId, name: partnerName, slotId: null, pairId, now });
    return { outcome: "waitlisted", slot, event: ev, partner };
  });
}

/**
 * "Be their partner": the player takes the place beside a single on the list.
 *
 * Somebody already in as a single pairs with them where they sit (`joined` false); somebody on the
 * waiting list, or not in at all, takes a free seat (`full` when there is none) and `joined` is true.
 * The single must be on the list and still single, else `taken`. The pair gets a fresh key.
 */
export async function bePartner(db: Db, input: { eventId: string; playerId: string; slotId: string; now?: Date }): Promise<{ slot: Slot; partner: Slot; event: Event; joined: boolean }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    assertOpen(ev, now);
    assertPairs(ev);
    const seats = await seatsOf(tx, ev);
    const single = seats.find((s) => s.id === input.slotId);
    if (!single || !isNamedSeat(single) || single.position > ev.capacity || single.playerId === input.playerId || partnerOf(seats, single)) throw new DomainError("invalid", "taken");
    const mine = seats.find((s) => s.playerId === input.playerId);
    if (mine && partnerOf(seats, mine)) throw new DomainError("invalid", "already_paired");
    const pairId = newPairId();
    let slot: Slot;
    let joined = false;
    if (mine && mine.position <= ev.capacity) {
      [slot] = await tx.update(slots).set({ pairId }).where(eq(slots.id, mine.id)).returning();
    } else {
      const free = seats.find((s) => s.position <= ev.capacity && (s.status === "empty" || s.status === "declined"));
      if (!free) throw new DomainError("full");
      // From the waiting list: the queue row goes, the seat beside the single is theirs.
      if (mine) await tx.delete(slots).where(eq(slots.id, mine.id));
      [slot] = await tx
        .update(slots)
        .set({ playerId: input.playerId, status: "joined", kind: "open", joinedAt: mine?.joinedAt ?? now, pairId, inviteCode: null, invitedName: null, invitedEmail: null, invitedPhone: null, invitedAt: null, lastRemindedAt: null, team: null })
        .where(eq(slots.id, free.id))
        .returning();
      await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.playerId, verb: mine ? "promoted" : "joined", createdAt: now });
      // New to the list either way: the organiser hears it and the calendar invitation goes, as for any join.
      joined = true;
    }
    const [partner] = await tx.update(slots).set({ pairId }).where(eq(slots.id, single.id)).returning();
    const status = await recomputeStatus(tx, ev);
    return { slot, partner, event: { ...ev, status }, joined };
  });
}

export type PairLeaveResult = { wasWaitlisted: boolean; promotion: Promotion | null; event: Event; /** The partner taken out with them, when the pair left together. */ partner: Slot | null };

/**
 * The pair leaves together: both seats empty in one write, then the waiting list moves up into both,
 * so a waiting pair fits. Either partner may take the pair out, as either may enter it. One partner
 * leaving alone is `leaveEvent`, which leaves the other as a single.
 */
export async function leavePair(db: Db, input: { eventId: string; playerId: string; now?: Date }): Promise<PairLeaveResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    if (ev.status === "cancelled") throw new DomainError("cancelled");
    if (ev.startsAt.getTime() <= now.getTime()) throw new DomainError("past");
    assertPairs(ev);
    const seats = await seatsOf(tx, ev);
    const mine = seats.find((s) => s.playerId === input.playerId);
    if (!mine) throw new DomainError("not_member");
    const partner = partnerOf(seats, mine);
    const wasWaitlisted = mine.position > ev.capacity;
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.playerId, verb: "left", meta: wasWaitlisted ? { waitlist: 1 } : null, createdAt: now });
    if (partner) await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.playerId, verb: "removed", meta: { name: partner.invitedName, targetPlayerId: partner.playerId }, createdAt: now });
    const [first, ...also] = await vacateSeats(tx, ev, partner ? [mine, partner] : [mine]);
    const status = await recomputeStatus(tx, ev);
    return { wasWaitlisted, promotion: first ? { ...first, also } : null, event: { ...ev, status }, partner };
  });
}

/** The organiser's tools come off once round 1 is drawn: from then the pairs are the field. */
async function assertBeforeRound1(tx: Db, ev: Event) {
  const [drawn] = await tx.select({ id: tournamentRounds.id }).from(tournamentRounds).where(eq(tournamentRounds.eventId, ev.id)).limit(1);
  if (drawn) throw new DomainError("invalid", "pairs_locked");
}

/** The organiser pairs two singles: both named, both on the list or both waiting, neither in a pair. */
export async function pairSingles(db: Db, input: { eventId: string; slotIds: [string, string]; actorPlayerId: string | null }): Promise<Event> {
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    assertPairs(ev);
    await assertBeforeRound1(tx, ev);
    const seats = await seatsOf(tx, ev);
    const [a, b] = input.slotIds.map((id) => seats.find((s) => s.id === id));
    const listed = (s: Slot) => s.position <= ev.capacity;
    if (!a || !b || a.id === b.id || !isNamedSeat(a) || !isNamedSeat(b) || listed(a) !== listed(b) || partnerOf(seats, a) || partnerOf(seats, b)) throw new DomainError("invalid", "taken");
    const pairId = newPairId();
    await tx.update(slots).set({ pairId }).where(and(eq(slots.eventId, ev.id), inArray(slots.id, [a.id, b.id])));
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.actorPlayerId, verb: "updated", meta: { paired: 1 } });
    return ev;
  });
}

/** The organiser splits a pair: both partners read as singles, each in their own seat. */
export async function splitPair(db: Db, input: { eventId: string; slotId: string; actorPlayerId: string | null }): Promise<Event> {
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    assertPairs(ev);
    await assertBeforeRound1(tx, ev);
    const seats = await seatsOf(tx, ev);
    const seat = seats.find((s) => s.id === input.slotId);
    const partner = seat ? partnerOf(seats, seat) : null;
    if (!seat || !partner) throw new DomainError("invalid", "taken");
    await tx.update(slots).set({ pairId: null }).where(and(eq(slots.eventId, ev.id), inArray(slots.id, [seat.id, partner.id])));
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.actorPlayerId, verb: "updated", meta: { split: 1 } });
    return ev;
  });
}

/**
 * Names that arrived together pair in order: the organiser's own seat with the first name, then every
 * two. The create form's list and the americano generator's names land as singles (`seatNames`), and
 * this makes them the pairs they were typed as. A last name without a second stays a single.
 */
export async function pairInOrder(db: Db, input: { eventId: string }): Promise<number> {
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    if (!ev.fixedPairs) return 0;
    const singles = seatUnits((await seatsOf(tx, ev)).filter((s) => s.position <= ev.capacity)).flatMap((u) => (u.kind === "single" ? [u.seat] : []));
    let made = 0;
    for (let i = 0; i + 1 < singles.length; i += 2) {
      const pairId = newPairId();
      await tx.update(slots).set({ pairId }).where(and(eq(slots.eventId, ev.id), inArray(slots.id, [singles[i].id, singles[i + 1].id])));
      made++;
    }
    return made;
  });
}
