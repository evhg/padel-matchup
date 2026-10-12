import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, events, groupMembers, groups, players, slots, tournamentRounds, type Event, type Slot } from "@/db/schema";
import { newInviteCode } from "@/lib/codes";
import { isOver } from "./matchLength";
import { DomainError } from "./errors";
import { recomputeStatus } from "./events";
import { isNamedSeat, partnerOf, seatUnits } from "./fixedPairs";
import { mergePlayers } from "./merge";
import { normalizeEmail, normalizeName, normalizePhone } from "./players";
import { normalName } from "./dupes";

export type JoinOutcome =
  | { outcome: "joined"; slot: Slot; event: Event }
  | { outcome: "waitlisted"; slot: Slot; event: Event }
  | { outcome: "already_in"; slot: Slot; event: Event }
  | { outcome: "full"; event: Event };

export type Promotion = {
  slot: Slot;
  playerId: string;
  /** A fixed-pairs night moves a pair up together, so one freed spot can seat more than one player: the others, told the same way (`promotedOf`). */
  also?: Promotion[];
};

/** Everybody a promotion moved up, the first and then `also`: whoever reads a promotion tells each of them. */
export const promotedOf = (p: Promotion | null | undefined): Promotion[] => (p ? [p, ...(p.also ?? [])] : []);

/** Locks the event row so every slot mutation for one event is serialized. */
export async function lockEvent(tx: Db, eventId: string): Promise<Event> {
  const [ev] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
  if (!ev) throw new DomainError("not_found");
  return ev;
}

/**
 * Why a match takes nobody now: it is cancelled, or it is over. Null while it is live. Joinable until
 * the match's own length has run out, not a fixed two hours after the start. Pure: the writes below
 * and the held place by name (`heldByName.ts`) ask the same question.
 */
export function liveRefusal(ev: Pick<Event, "status" | "startsAt" | "durationMinutes">, now: Date): "cancelled" | "past" | null {
  if (ev.status === "cancelled") return "cancelled";
  if (ev.status === "past" || isOver(ev, now)) return "past";
  return null;
}

function assertLive(ev: Event, now: Date) {
  const why = liveRefusal(ev, now);
  if (why) throw new DomainError(why);
}

/**
 * The organiser of this match, or a co-organiser (an admin or the creator of the crew it belongs to).
 * Two reads down primary keys at most, and none for a match outside a crew.
 */
export async function runsMatch(db: Db, ev: Pick<Event, "creatorPlayerId" | "groupId">, playerId: string): Promise<boolean> {
  if (playerId === ev.creatorPlayerId) return true;
  if (!ev.groupId) return false;
  const [admin] = await db
    .select({ id: groupMembers.playerId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, ev.groupId), eq(groupMembers.playerId, playerId), eq(groupMembers.role, "admin")))
    .limit(1);
  if (admin) return true;
  const [creator] = await db.select({ id: groups.id }).from(groups).where(and(eq(groups.id, ev.groupId), eq(groups.creatorPlayerId, playerId))).limit(1);
  return Boolean(creator);
}

/**
 * May a record that holds a place in this match already use the personal link of a held place in it?
 * "I'm in" from such a record does not seat it: it frees the held place (`confirmInvite`). The server
 * asks this before that tap, and the invite page asks it before it shows "I'm in" (DECIDING rule 34).
 *
 *   - Yes when the place carries the record's own name: the person it is held for, in by another
 *     door, frees it for the waiting list. The organiser or a co-organiser of that name too.
 *   - Yes for a partner link on a fixed-pairs night, unless the record runs the match: the player who
 *     named the partner holds that link, and the typed name ("Dani") can differ from the record
 *     ("Daniel"). The tap makes the pair (rule 32).
 *   - No for anybody else, because the tap would free another person's place.
 *
 * Reads `runsMatch` only for a partner link that does not carry the record's name.
 */
export async function mayUseHeldLink(
  db: Db,
  ev: Pick<Event, "fixedPairs" | "creatorPlayerId" | "groupId">,
  slot: Pick<Slot, "invitedName" | "pairId">,
  player: { id: string; displayName: string },
): Promise<boolean> {
  const held = normalName(slot.invitedName);
  if (held && normalName(player.displayName) === held) return true;
  if (!ev.fixedPairs || !slot.pairId) return false;
  return !(await runsMatch(db, ev, player.id));
}

/**
 * A place the organiser holds that nobody took yet: reserved, invited or declined, on the line-up. With
 * a record on it, the record is the person it is held for (the owner, 11 October 2026: "Yes, keep the
 * record"), or a tournament's placeholder for a name (`hasLifeOutside` tells the two apart). Pure.
 */
export const isHeldPlace = (s: Pick<Slot, "kind" | "status" | "position">, capacity: number): boolean => s.kind === "reserved" && (s.status === "invited" || s.status === "declined") && s.position <= capacity;

/**
 * Has this record a life outside this match: a seat taken in another match, or a match it made? A
 * past player whom the organiser picked for a held place has one by the picker's own rule (a seat in a
 * match that started). A tournament's placeholder (`generateRound` makes one for each name that never
 * confirmed) has none, so the personal link still folds a placeholder into whoever confirms, as
 * before, and never folds a real player's record. Two lookups, down `slots_player_idx` and
 * `events_creator_idx`, each stopping at its first row.
 */
export async function hasLifeOutside(db: Db, playerId: string, eventId: string): Promise<boolean> {
  const [seat] = await db
    .select({ id: slots.id })
    .from(slots)
    .where(and(eq(slots.playerId, playerId), ne(slots.eventId, eventId), inArray(slots.status, ["joined", "confirmed"])))
    .limit(1);
  if (seat) return true;
  const [made] = await db.select({ id: events.id }).from(events).where(and(eq(events.creatorPlayerId, playerId), ne(events.id, eventId))).limit(1);
  return Boolean(made);
}

/** The same number, with or without its plus and whatever spaces it was typed with. */
const samePhone = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const digits = (p: string | null | undefined) => (normalizePhone(p) ?? "").replace(/^\+/, "");
  return digits(a).length > 0 && digits(a) === digits(b);
};

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
  // An emptied seat is nobody's partner: the other half of a fixed pair reads as a single by itself.
  pairId: null,
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
    // The place the organiser holds for this very record (a past player picked for it): the join takes
    // it, on a full match too, the way the personal link does (`confirmLocked`, "Danny confirmed").
    // Every door that joins ends here: the web's Join, Telegram, WhatsApp, LINE, Discord and the API.
    if (existing && isHeldPlace(existing, ev.capacity)) {
      const done = await confirmLocked(tx, ev, existing, { playerId: input.playerId, now });
      return { outcome: "joined", slot: done.slot, event: done.event };
    }
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
      await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.playerId, verb: "joined", createdAt: now });
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
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.playerId, verb: "joined", meta: { waitlist: 1 }, createdAt: now });
    return { outcome: "waitlisted", slot: wl, event: ev };
  });
}

/**
 * Empties a roster slot and promotes the first waitlisted player into it.
 * Must run inside a transaction that already holds the event lock.
 */
export async function vacateAndPromote(tx: Db, ev: Event, slot: Slot): Promise<Promotion | null> {
  if (ev.fixedPairs) {
    const [first, ...also] = await vacateSeats(tx, ev, [slot]);
    return first ? { ...first, also } : null;
  }
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

/**
 * A fixed-pairs night's way of freeing seats: empty every seat given (a waiting-list entry goes), then
 * let the waiting list in, in order, as far as the free seats allow. A pair moves up together and
 * needs two free seats; a single needs one, and moves past a pair at the head that does not fit
 * rather than leave a seat empty while somebody waits. The pair keeps its place and moves up the
 * moment two seats are free. Seats are emptied first and filled once, so a pair that leaves together
 * frees room for a pair that waits. The lock is the caller's.
 */
export async function vacateSeats(tx: Db, ev: Event, seats: readonly Slot[]): Promise<Promotion[]> {
  for (const s of seats) {
    if (s.position > ev.capacity) await tx.delete(slots).where(eq(slots.id, s.id));
    else await tx.update(slots).set(VACANT).where(eq(slots.id, s.id));
  }
  const all = await tx.select().from(slots).where(eq(slots.eventId, ev.id)).orderBy(asc(slots.position));
  const free = all.filter((s) => s.position <= ev.capacity && (s.status === "empty" || s.status === "declined"));
  const waiting = seatUnits(all.filter((s) => s.position > ev.capacity));
  // Once round 1 is drawn the pairs are the field: a pair may still move up and be drawn, a single
  // could never be (nobody pairs after round 1), so a single is not moved in to sit out the night.
  const drawn = waiting.length > 0 && (await tx.select({ id: tournamentRounds.id }).from(tournamentRounds).where(eq(tournamentRounds.eventId, ev.id)).limit(1)).length > 0;
  const promotions: Promotion[] = [];
  for (const unit of waiting) {
    const movers = unit.kind === "pair" ? unit.seats : [unit.seat];
    if (movers.length > free.length || (drawn && unit.kind === "single")) continue;
    for (const w of movers) {
      const to = free.shift()!;
      // The waiting row goes first: its invite code and its player are unique per event.
      await tx.delete(slots).where(eq(slots.id, w.id));
      const [moved] = await tx
        .update(slots)
        .set({ ...VACANT, playerId: w.playerId, status: w.status, kind: w.kind, inviteCode: w.inviteCode, invitedName: w.invitedName, invitedEmail: w.invitedEmail, invitedPhone: w.invitedPhone, invitedAt: w.invitedAt, joinedAt: w.joinedAt ?? new Date(), pairId: w.pairId })
        .where(eq(slots.id, to.id))
        .returning();
      if (!w.playerId) continue;
      await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: w.playerId, verb: "promoted" });
      promotions.push({ slot: moved, playerId: w.playerId });
    }
  }
  return promotions;
}

/**
 * On a fixed-pairs night, the partner this seat's player named who has not claimed the spot yet: a
 * reserved name the player gave (`joinPair`, read from the "invited" line the reservation wrote). It
 * goes when they go, because only they hold its link; left behind it would be a seat nobody can claim
 * that moves up ahead of real people. A partner who is a player, or a name somebody else gave (the
 * organiser's), stays. The lock is the caller's.
 */
async function namedPartnerOf(tx: Db, ev: Event, seat: Slot): Promise<Slot | null> {
  if (!ev.fixedPairs || !seat.playerId) return null;
  const all = await tx.select().from(slots).where(eq(slots.eventId, ev.id));
  const partner = partnerOf(all, seat);
  if (!partner || partner.status !== "invited" || !partner.invitedName) return null;
  const [named] = await tx
    .select({ id: activity.id })
    .from(activity)
    .where(and(eq(activity.eventId, ev.id), eq(activity.verb, "invited"), eq(activity.actorPlayerId, seat.playerId), sql`${activity.meta}->>'name' = ${partner.invitedName}`))
    .limit(1);
  return named ? partner : null;
}

/** For a screen: whether this player's leaving takes their partner's reserved spot with it (`namedPartnerOf`). */
export async function partnerGoesWith(db: Db, ev: Event, seat: Slot): Promise<boolean> {
  return Boolean(await namedPartnerOf(db, ev, seat));
}

/** Empties a seat, and on a fixed-pairs night the unclaimed name its player gave with it; then the waiting list moves up once. */
async function vacateWithNamed(tx: Db, ev: Event, seat: Slot, actorPlayerId: string | null, now: Date): Promise<Promotion | null> {
  const named = await namedPartnerOf(tx, ev, seat);
  if (!named) return vacateAndPromote(tx, ev, seat);
  await tx.insert(activity).values({ eventId: ev.id, actorPlayerId, verb: "removed", meta: { name: named.invitedName, targetPlayerId: null }, createdAt: now });
  const [first, ...also] = await vacateSeats(tx, ev, [seat, named]);
  return first ? { ...first, also } : null;
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
    // The moment and the seat are facts the late pull-out line reads (`src/lib/domain/banter.ts`): an
    // exit from the waitlist opened no spot, so it says so, the way a join to the waitlist does.
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.playerId, verb: "left", meta: wasWaitlisted ? { waitlist: 1 } : null, createdAt: now });
    // A fixed-pairs night: a partner who is still only the name this player gave leaves with them.
    const promotion = await vacateWithNamed(tx, ev, mine, input.playerId, now);
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
    // The removed player's unclaimed partner goes too: nobody else holds its link.
    const promotion = await vacateWithNamed(tx, ev, slot, input.actorPlayerId, now);
    const status = await recomputeStatus(tx, ev);
    // Only somebody who took the place hears "you were removed": a place held for a record that never
    // took it (a past player the organiser picked, a tournament's placeholder) was never theirs.
    const took = slot.status === "joined" || slot.status === "confirmed";
    return { removedPlayerId: took ? slot.playerId : null, removedName, promotion, event: { ...ev, status } };
  });
}

/**
 * "Paste the names from the group": the organiser's names, each a reserved spot in the next free seat,
 * in one transaction under the event's lock, so one request and one line-up change carry the whole
 * list. A full match ends the list; the names reserved come back in order. The names already in the
 * match were left out before this (`planPaste`).
 */
export async function reserveNames(db: Db, input: { eventId: string; actorPlayerId: string | null; names: string[]; now?: Date }): Promise<{ held: Slot[]; event: Event }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    let ev = await lockEvent(tx, input.eventId);
    const held: Slot[] = [];
    for (const raw of input.names) {
      const name = normalizeName(raw);
      if (!name) continue;
      try {
        const done = await reserveLocked(tx, ev, { actorPlayerId: input.actorPlayerId, name, now });
        held.push(done.slot);
        ev = done.event;
      } catch (e) {
        if (e instanceof DomainError && e.code === "full") break;
        throw e;
      }
    }
    return { held, event: ev };
  });
}

/** Creator reserves a roster slot by name; returns the slot with its personal invite code. */
/** At most this many names travel from the americano generator into a new tournament. */
export const SEAT_NAMES_MAX = 24;

/**
 * Seats a list of names in a new event, each in the next free spot, as reserved invites — the same
 * row the organiser's "reserve for someone" makes, so each one keeps a link to pass on.
 *
 * It exists for the americano generator. Somebody types eight names, builds the rotation, taps "run
 * it live", and those eight must not be typed a second time. `skipName` is the organiser's own name:
 * they are seated already, so their name in the list is theirs, not a ninth player.
 *
 * Bounded by the free spots and by SEAT_NAMES_MAX. A name that finds no spot is dropped rather than
 * failing the create, because the tournament itself is what the person asked for. The whole list is
 * one transaction under the event's lock (`reserveNames`, as the organiser's pasted names), where it
 * was one transaction for each name; a pasted booking's players come this way too (`settleNewMatch`).
 */
export async function seatNames(db: Db, input: { eventId: string; actorPlayerId: string | null; names: string[]; skipName?: string | null; now?: Date }): Promise<number> {
  const skip = normalizeName(input.skipName ?? "").toLowerCase();
  let skipped = false;
  const names: string[] = [];
  for (const raw of input.names.slice(0, SEAT_NAMES_MAX)) {
    const name = normalizeName(raw);
    if (!name) continue;
    // The organiser's own name, once. The rest of the list is other people.
    if (!skipped && skip && name.toLowerCase() === skip) {
      skipped = true;
      continue;
    }
    names.push(name);
  }
  if (names.length === 0) return 0;
  // A full event ends the list; anything else (a match already over) holds nobody and fails nothing.
  const done = await reserveNames(db, { eventId: input.eventId, actorPlayerId: input.actorPlayerId, names, now: input.now }).catch(() => null);
  return done?.held.length ?? 0;
}

export async function reserveSlot(
  db: Db,
  /** `playerId`: the past player the organiser picked for the place (`pastPlayerNamed` in `heldRecord.ts`); the place keeps that record, unless a phone is given (`reserveLocked`). */
  input: { eventId: string; actorPlayerId: string | null; name: string; email?: string | null; phone?: string | null; slotId?: string | null; playerId?: string | null; now?: Date },
): Promise<{ slot: Slot; event: Event }> {
  const now = input.now ?? new Date();
  const name = normalizeName(input.name);
  if (!name) throw new DomainError("invalid", "name");
  return db.transaction(async (tx) => reserveLocked(tx, await lockEvent(tx, input.eventId), { ...input, name, now }));
}

/**
 * `reserveSlot`'s write, for a caller that already holds the event lock and has cleaned the name
 * (a tournament's walk-in grows the field and reserves in one transaction: `addWalkIn`).
 */
export async function reserveLocked(
  tx: Db,
  ev: Event,
  input: { actorPlayerId: string | null; name: string; email?: string | null; phone?: string | null; slotId?: string | null; playerId?: string | null; now: Date },
): Promise<{ slot: Slot; event: Event }> {
  const { name, now } = input;
  assertLive(ev, now);
  // A place held for a number is that number's: the WhatsApp JOIN from it takes the place. So it keeps
  // no record, as "Keep Danny's matches" refuses one (`keepRecordFor`); a record there would refuse the
  // number (`held_record`), and the bot would seat it a second time (review of 11 October 2026).
  const playerId = input.playerId && !normalizePhone(input.phone) ? input.playerId : null;
  // One place per record and match (`slots_event_player_idx`): a record already here is refused by
  // name, never by the index's error.
  if (playerId) {
    const [here] = await tx.select({ id: slots.id }).from(slots).where(and(eq(slots.eventId, ev.id), eq(slots.playerId, playerId))).limit(1);
    if (here) throw new DomainError("invalid", "already_in");
  }
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
        playerId,
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
}

export type ConfirmOutcome =
  | { outcome: "confirmed"; slot: Slot; event: Event }
  | { outcome: "already_confirmed"; slot: Slot; event: Event }
  /**
   * Already in by another door. The reserved spot is freed the way a leave frees a seat, so the
   * waiting list may move up (`promotion`); on a fixed-pairs night the pair forms first.
   */
  | { outcome: "already_in"; slot: Slot; event: Event; promotion?: Promotion | null }
  | { outcome: "gone"; event: Event };

export async function confirmInvite(
  db: Db,
  /** `phone`: the number the request came from (the WhatsApp bot), never a number somebody typed. */
  input: { inviteCode: string; playerId: string; email?: string | null; phone?: string | null; now?: Date },
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

    // A place held for a past player's record (the owner, 11 October 2026: "Yes, keep the record") is
    // that record's alone: whoever else opens the link, a WhatsApp number included, is refused, and the
    // record is never folded into them. A tournament's placeholder has no life outside the match, so it
    // still folds into whoever confirms (below). The link signs a browser that knows nobody in as the
    // record, inside the "That's me" limits, before it calls this (`decideHeldLink` in `heldRecord.ts`).
    if (slot.playerId && slot.playerId !== input.playerId && slot.kind === "reserved" && (await hasLifeOutside(tx, slot.playerId, ev.id))) {
      throw new DomainError("forbidden", "held_record");
    }

    // invited or declined → confirm. Another place of this record in the match, never the held place
    // itself: the record it is held for, opening its own link, found that place here and freed it.
    const [elsewhere] = await tx
      .select()
      .from(slots)
      .where(and(eq(slots.eventId, ev.id), eq(slots.playerId, input.playerId), ne(slots.id, slot.id)))
      .limit(1);
    const placeholder = slot.playerId && slot.playerId !== input.playerId ? slot.playerId : null;
    if (elsewhere) {
      // In the match already, on a held place's link: the tap frees that place, so only the person it
      // is held for may make it (`mayUseHeldLink`). A place held for the number that writes (the
      // WhatsApp JOIN) is theirs by that number. Anybody else with the link, the organiser included,
      // used to free it, and the first player waiting took the seat.
      if (!samePhone(slot.invitedPhone, input.phone)) {
        const [who] = await tx.select({ id: players.id, displayName: players.displayName }).from(players).where(eq(players.id, input.playerId)).limit(1);
        if (!who || !(await mayUseHeldLink(tx, ev, slot, who))) throw new DomainError("forbidden");
      }
      if (ev.fixedPairs) {
        // A fixed-pairs night: the partner somebody named was in already, alone. The pair forms where
        // they sit (same side of the list, before round 1, nobody else's partner), and the reserved
        // spot goes: a waiting row is deleted, a seat on the list frees for the waiting list.
        const all = await tx.select().from(slots).where(eq(slots.eventId, ev.id));
        const namer = slot.pairId ? all.find((s) => s.id !== slot.id && s.pairId === slot.pairId && isNamedSeat(s)) : undefined;
        const [drawn] = await tx.select({ id: tournamentRounds.id }).from(tournamentRounds).where(eq(tournamentRounds.eventId, ev.id)).limit(1);
        const sameSide = namer && (namer.position <= ev.capacity) === (elsewhere.position <= ev.capacity);
        let mine = elsewhere;
        if (namer && sameSide && !drawn && !partnerOf(all, elsewhere)) [mine] = await tx.update(slots).set({ pairId: slot.pairId }).where(eq(slots.id, elsewhere.id)).returning();
        const [first, ...also] = await vacateSeats(tx, ev, [slot]);
        if (placeholder) await mergePlayers(tx, input.playerId, [placeholder]);
        const status = await recomputeStatus(tx, ev);
        return { outcome: "already_in", slot: mine, event: { ...ev, status }, promotion: first ? { ...first, also } : null };
      }
      // Already in through the public link: the reserved spot is not a second seat. It goes the way a
      // leave goes (`vacateAndPromote`), so the first player waiting moves up and is told; it used to
      // go empty with the waiting list left where it was.
      const promotion = await vacateAndPromote(tx, ev, slot);
      if (placeholder) await mergePlayers(tx, input.playerId, [placeholder]);
      const status = await recomputeStatus(tx, ev);
      return { outcome: "already_in", slot: elsewhere, event: { ...ev, status }, promotion };
    }

    const done = await confirmLocked(tx, ev, slot, { playerId: input.playerId, email: input.email, now });
    return { outcome: "confirmed", ...done };
  });
}

/**
 * The write that fills a held place: the player takes it, confirmed, at `now`. The personal link
 * (`confirmInvite`) and the name typed on the plain link (`takeHeldByName` in `heldByName.ts`) both
 * end here, so the organiser hears the same "Danny confirmed" either way. The lock is the caller's.
 */
export async function confirmLocked(tx: Db, ev: Event, slot: Slot, input: { playerId: string; email?: string | null; now: Date }): Promise<{ slot: Slot; event: Event }> {
  const email = normalizeEmail(input.email);
  const placeholder = slot.playerId && slot.playerId !== input.playerId ? slot.playerId : null;
  const [confirmed] = await tx
    .update(slots)
    .set({
      playerId: input.playerId,
      status: "confirmed",
      joinedAt: input.now,
      invitedEmail: email ?? slot.invitedEmail,
    })
    .where(eq(slots.id, slot.id))
    .returning();
  if (email) {
    await tx.update(players).set({ email }).where(and(eq(players.id, input.playerId), sql`${players.email} is null`));
  }
  // Round 1 was generated with a placeholder for this name: hand its matches to the real player.
  if (placeholder) await mergePlayers(tx, input.playerId, [placeholder]);
  await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.playerId, verb: "confirmed" });
  const status = await recomputeStatus(tx, ev);
  return { slot: confirmed, event: { ...ev, status } };
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
      // A fixed-pairs night's waiting list also holds partners who claimed their spot or are still a name.
      .where(and(eq(slots.eventId, ev.id), gt(slots.position, ev.capacity), ev.fixedPairs ? inArray(slots.status, ["joined", "confirmed", "invited"]) : eq(slots.status, "joined")))
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
    // A fixed-pairs night's waiting list also holds claimed and reserved partners (`vacateSeats` decides who fits).
    .where(and(gt(slots.position, events.capacity), or(eq(slots.status, "joined"), and(eq(events.fixedPairs, true), inArray(slots.status, ["confirmed", "invited"]))), inArray(events.status, ["open", "full"]), gt(events.startsAt, now)));
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

// ---------------------------------------------------------------------------
// Who has paid. No money passes through Kicksmash: the player says it is sent,
// the organiser says it landed, and the app only remembers which of those happened.
// Deliberately two fields and not one flag — "I paid" and "it arrived" are different
// claims by different people, and collapsing them would let either side write the other's.
// ---------------------------------------------------------------------------

export type SlotPayment = { slotId: string; playerId: string; name: string; claimedAt: Date | null; paidAt: Date | null };

/** Who pays: a place somebody took, never one held for them (a past player picked for it, a placeholder). */
const PAYING = ["joined", "confirmed"] as const;

/** The player says the money is sent. A claim, not a status: it asks the organiser, it does not answer. */
export async function claimSlotPaid(db: Db, input: { eventId: string; playerId: string }, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(slots)
    .set({ paidClaimedAt: now })
    .where(and(eq(slots.eventId, input.eventId), eq(slots.playerId, input.playerId), inArray(slots.status, [...PAYING]), isNull(slots.paidAt)))
    .returning({ id: slots.id });
  return rows.length === 1;
}

/** The organiser says it landed, or takes it back. Nobody else may, on anybody's row. */
export async function setSlotPaid(db: Db, input: { eventId: string; slotId: string; actorPlayerId: string; paid: boolean }, now = new Date()): Promise<boolean> {
  const [ev] = await db.select({ creator: events.creatorPlayerId }).from(events).where(eq(events.id, input.eventId));
  if (!ev) throw new DomainError("not_found");
  if (ev.creator !== input.actorPlayerId) throw new DomainError("forbidden");
  const rows = await db
    .update(slots)
    .set({ paidAt: input.paid ? now : null })
    .where(and(eq(slots.id, input.slotId), eq(slots.eventId, input.eventId), isNotNull(slots.playerId), inArray(slots.status, [...PAYING])))
    .returning({ id: slots.id });
  return rows.length === 1;
}

/** The organiser's row of names, in roster order. Only ever for a match that names a cost. */
export async function paymentsFor(db: Db, eventId: string): Promise<SlotPayment[]> {
  const rows = await db
    .select({ slotId: slots.id, playerId: slots.playerId, name: players.displayName, claimedAt: slots.paidClaimedAt, paidAt: slots.paidAt, position: slots.position })
    .from(slots)
    .innerJoin(players, eq(players.id, slots.playerId))
    .where(and(eq(slots.eventId, eventId), isNotNull(slots.playerId), inArray(slots.status, [...PAYING])))
    .orderBy(asc(slots.position));
  return rows.map((r) => ({ slotId: r.slotId, playerId: r.playerId as string, name: r.name, claimedAt: r.claimedAt, paidAt: r.paidAt }));
}
