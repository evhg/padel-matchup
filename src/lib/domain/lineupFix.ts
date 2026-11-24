import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, players, slots, type Event, type Slot } from "@/db/schema";
import { DomainError } from "./errors";
import { recomputeStatus } from "./events";
import { fixRefusal, fixRights, type FixRights } from "./fixWindow";
import { createPlayer, normalizeName } from "./players";
import { applyEventLevels, revertEventLevels } from "./rating";
import { lockEvent } from "./slots";

/**
 * The writes of the line-up fix (the owner's decision of 24 November 2026, `fixWindow.ts`): from the
 * start of a match to seven days after its end, the organiser and its players put a name in an open
 * place, change who holds a place, and remove a player or a hold; anybody signed in without a seat takes
 * an open place or a player's place for themselves ("I played instead of Bo").
 *
 * Each is one transaction under the match's lock, so two phones changing one line-up at once are served
 * one after the other. Each writes one activity line that names who did it, and returns the player who
 * lost a taken place to somebody else, so the caller tells them who did it (`notifyRemovedBy`).
 *
 * A place changed here is a place played: the person who takes it is confirmed on it at once, a typed
 * name on a new record (as a tap on "I'm Danny" makes one). No waiting list moves up after the start:
 * a place emptied here stays open, because the person waiting did not play. When the match has a score,
 * the pairs stay true to the places: a new person sits on the side of the place they take, and a place
 * that opens loses its side. The levels this match moved are taken back first (`revertEventLevels`), so
 * a player who goes gets back what it moved, and moved again for the line-up as it now is.
 */

export type FixActor = { id: string | null; organiser: boolean; locale?: string };
/** Somebody who lost a place they had taken, to somebody other than themselves: `replaced` when the person took it for themselves. */
export type FixOut = { playerId: string; how: "removed" | "replaced" };
export type FixDone = { event: Event; slot: Slot | null; out: FixOut | null; levels: boolean };

const taken = (s: Pick<Slot, "status">) => s.status === "joined" || s.status === "confirmed";
const open = (s: Pick<Slot, "status">) => s.status === "empty" || s.status === "declined";

/** An emptied place: nobody's, no side, no link. The paid marks go with the person. */
const EMPTY: Partial<typeof slots.$inferInsert> = {
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
  pairId: null,
  paidClaimedAt: null,
  paidAt: null,
};

/**
 * The side a person who takes an open place sits on: the side with one player, when the score's pairs
 * left exactly one side short; else none, as a seat with no pairs has. Pure.
 */
export function sideForOpenPlace(seats: readonly Pick<Slot, "status" | "team" | "position">[], capacity: number): "a" | "b" | null {
  const inside = seats.filter((s) => s.position <= capacity && taken(s));
  const a = inside.filter((s) => s.team === "a").length;
  const b = inside.filter((s) => s.team === "b").length;
  if (a + b === 0) return null;
  if (a < 2 && b === 2) return "a";
  if (b < 2 && a === 2) return "b";
  return null;
}

/**
 * The match locked, the window asked, the actor's right asked. Returns the match, its rows in order of
 * place, and the actor's rights. The levels this match moved are taken back before any change.
 */
async function openFix(tx: Db, eventId: string, actor: FixActor, now: Date, need: keyof FixRights): Promise<{ ev: Event; rows: Slot[] }> {
  const ev = await lockEvent(tx, eventId);
  const why = fixRefusal(ev, now);
  if (why) throw why === "not_a_match" ? new DomainError("invalid", "not_a_match") : new DomainError(why);
  const rows = await tx.select().from(slots).where(eq(slots.eventId, ev.id)).orderBy(asc(slots.position));
  const seated = Boolean(actor.id) && rows.some((s) => s.playerId === actor.id && taken(s) && s.position <= ev.capacity);
  if (!fixRights(ev, now, { signedIn: Boolean(actor.id), organiser: actor.organiser, seated })[need]) throw new DomainError("forbidden");
  await revertEventLevels(tx, ev);
  return { ev, rows };
}

/** The place asked for, inside the capacity. */
function placeOf(ev: Event, rows: readonly Slot[], slotId: string): Slot {
  const s = rows.find((r) => r.id === slotId);
  if (!s || s.position > ev.capacity) throw new DomainError("not_found");
  return s;
}

/** The name a place shows: its player's, else the name it is held for. */
async function nameOn(tx: Db, s: Pick<Slot, "playerId" | "invitedName">): Promise<string> {
  if (!s.playerId) return s.invitedName ?? "";
  const [p] = await tx.select({ n: players.displayName }).from(players).where(eq(players.id, s.playerId)).limit(1);
  return p?.n ?? s.invitedName ?? "";
}

/**
 * The record's other row in this match goes before it takes a place (one row per record and match):
 * a waiting place is deleted, a held or declined place empties. A seat it took is refused.
 */
async function clearOtherRow(tx: Db, ev: Event, rows: readonly Slot[], playerId: string, keep: string): Promise<void> {
  const other = rows.find((r) => r.playerId === playerId && r.id !== keep);
  if (!other) return;
  if (other.position <= ev.capacity && taken(other)) throw new DomainError("already_in");
  if (other.position > ev.capacity) await tx.delete(slots).where(eq(slots.id, other.id));
  else await tx.update(slots).set(EMPTY).where(eq(slots.id, other.id));
}

/** Seats a record on a place, confirmed now. A place somebody held or sat on keeps its side; an open place takes the short side. */
async function seat(tx: Db, ev: Event, rows: readonly Slot[], place: Slot, playerId: string, now: Date): Promise<Slot> {
  const team = open(place) ? sideForOpenPlace(rows, ev.capacity) : place.team;
  const [row] = await tx
    .update(slots)
    .set({ ...EMPTY, playerId, status: "confirmed", joinedAt: now, team })
    .where(eq(slots.id, place.id))
    .returning();
  return row;
}

async function finish(tx: Db, ev: Event, slot: Slot | null, out: FixOut | null): Promise<FixDone> {
  const status = await recomputeStatus(tx, ev);
  return { event: { ...ev, status }, slot, out, levels: ev.scoreLockedByCreator };
}

/**
 * After the transaction: the levels moved for the line-up as it now is, when the organiser confirmed the
 * score. A line-up that a change made complete moves them for the first time; one it left short moves nobody.
 */
async function settle(db: Db, done: FixDone, now: Date): Promise<FixDone> {
  if (done.levels) await applyEventLevels(db, done.event.id, now).catch(() => undefined);
  return done;
}

/**
 * Puts a person on a place: an open place (`invited`, "Cy was added by Ana"), or a place somebody held or
 * sat on, which changes who it is ("Ana changed Bo to Cy"). The person is a record the caller found (a
 * past player picked by name, `recordId`), or a new record of the typed name. A player who had taken
 * the place, and is not the actor, is the one to tell.
 */
export async function putOnPlace(db: Db, input: { eventId: string; slotId: string; actor: FixActor; name: string; recordId?: string | null; now?: Date }): Promise<FixDone> {
  const now = input.now ?? new Date();
  const typed = normalizeName(input.name);
  if (!typed && !input.recordId) throw new DomainError("invalid", "name");
  const done = await db.transaction(async (tx) => {
    const { ev, rows } = await openFix(tx, input.eventId, input.actor, now, "edit");
    const place = placeOf(ev, rows, input.slotId);
    const before = open(place) ? null : await nameOn(tx, place);
    const lost = taken(place) && place.playerId ? place.playerId : null;
    let record = input.recordId ?? null;
    if (record && record === place.playerId) throw new DomainError("invalid", "already_in");
    if (record) await clearOtherRow(tx, ev, rows, record, place.id);
    else record = (await createPlayer(tx, { displayName: typed, locale: input.actor.locale ?? "en" })).id;
    const row = await seat(tx, ev, rows, place, record, now);
    const name = await nameOn(tx, row);
    await tx.insert(activity).values(
      before === null
        ? { eventId: ev.id, actorPlayerId: input.actor.id, verb: "invited", meta: { name }, createdAt: now }
        : { eventId: ev.id, actorPlayerId: input.actor.id, verb: "removed", meta: { name: before, targetPlayerId: lost, to: name }, createdAt: now },
    );
    return finish(tx, ev, row, lost && lost !== input.actor.id ? { playerId: lost, how: "removed" } : null);
  });
  return settle(db, done, now);
}

/** Empties a place: a player's, or a hold. The waiting list does not move up: the person waiting did not play. */
export async function removeFromPlace(db: Db, input: { eventId: string; slotId: string; actor: FixActor; now?: Date }): Promise<FixDone> {
  const now = input.now ?? new Date();
  const done = await db.transaction(async (tx) => {
    const { ev, rows } = await openFix(tx, input.eventId, input.actor, now, "edit");
    const place = placeOf(ev, rows, input.slotId);
    if (open(place)) return finish(tx, ev, null, null);
    const name = await nameOn(tx, place);
    const lost = taken(place) && place.playerId ? place.playerId : null;
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: input.actor.id, verb: "removed", meta: { name, targetPlayerId: lost }, createdAt: now });
    const [row] = await tx.update(slots).set(EMPTY).where(eq(slots.id, place.id)).returning();
    return finish(tx, ev, row, lost && lost !== input.actor.id ? { playerId: lost, how: "removed" } : null);
  });
  return settle(db, done, now);
}

/**
 * The actor takes an open place for themselves ("Cy joined"): the place asked for, else the first open
 * one. A place held for the actor's own record is theirs first. Their waiting place goes.
 */
export async function takeOpenPlace(db: Db, input: { eventId: string; actor: FixActor; slotId?: string | null; now?: Date }): Promise<FixDone> {
  const now = input.now ?? new Date();
  const me = input.actor.id;
  if (!me) throw new DomainError("forbidden");
  const done = await db.transaction(async (tx) => {
    const { ev, rows } = await openFix(tx, input.eventId, input.actor, now, "take");
    const inside = rows.filter((r) => r.position <= ev.capacity);
    const mine = inside.find((r) => r.playerId === me && r.status === "invited");
    const place = mine ?? (input.slotId ? inside.find((r) => r.id === input.slotId && open(r)) : inside.find(open));
    if (!place) throw input.slotId ? new DomainError("invalid", "slot_taken") : new DomainError("full");
    await clearOtherRow(tx, ev, rows, me, place.id);
    const row = await seat(tx, ev, rows, place, me, now);
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: me, verb: "joined", createdAt: now });
    return finish(tx, ev, row, null);
  });
  return settle(db, done, now);
}

/**
 * "I played instead of Bo": the actor takes a player's place, or a held place, for themselves, on its
 * side of the pairs ("Cy took Bo's place"). Bo, who had taken it, is the one to tell.
 */
export async function replaceOnPlace(db: Db, input: { eventId: string; slotId: string; actor: FixActor; now?: Date }): Promise<FixDone> {
  const now = input.now ?? new Date();
  const me = input.actor.id;
  if (!me) throw new DomainError("forbidden");
  const done = await db.transaction(async (tx) => {
    const { ev, rows } = await openFix(tx, input.eventId, input.actor, now, "replace");
    const place = placeOf(ev, rows, input.slotId);
    if (open(place)) throw new DomainError("invalid", "slot_taken");
    const name = await nameOn(tx, place);
    const lost = taken(place) && place.playerId ? place.playerId : null;
    await clearOtherRow(tx, ev, rows, me, place.id);
    const row = await seat(tx, ev, rows, place, me, now);
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: me, verb: "removed", meta: { name, targetPlayerId: lost, replace: 1 }, createdAt: now });
    return finish(tx, ev, row, lost ? { playerId: lost, how: "replaced" } : null);
  });
  return settle(db, done, now);
}
