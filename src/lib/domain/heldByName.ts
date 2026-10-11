import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, slots, type Event, type Slot } from "@/db/schema";
import { lineupComplete } from "@/lib/lineup";
import { normalName } from "./dupes";
import { bumpMetric } from "./metrics";
import { LIMITS, takeRate } from "./ratelimit";
import { confirmLocked, liveRefusal, lockEvent } from "./slots";

/**
 * The held place by name (DECIDING rule 34, extended by the owner on 11 October 2026: "Yes, two taps").
 *
 * The organiser holds a place for a name ("Danny"): one reserved row with no record behind it
 * (`reserveNames`, `reserveSlot`). The personal link fills it with one tap. The plain match link, the
 * one the group chat carries, could not: "That's me" works on records, the held row could not be
 * tapped, and a Danny who typed his name and joined made a second Danny on an empty seat while his
 * held place stayed empty. Now the "already in this match" line under a typed name offers "Take
 * Danny's held place", in two taps, inside these limits, each one checked again on the server. The held
 * row itself offers nothing: the owner chose the typed name.
 *
 *   - a reserved place that nobody took: no record on it (a tournament's placeholder is a record),
 *     no email and no phone, because a place held for an address belongs to that address;
 *   - exactly one held place of that name in the match, and no record of that name in a seat or on
 *     the waiting list there ("never one of two of the same name", as rule 34);
 *   - a match that is not cancelled and not over (`liveRefusal`, the same check `confirmInvite` makes);
 *   - never on a fixed-pairs night, where the player who named a partner holds that link (rule 32);
 *   - a browser that knows nobody, or one whose record carries the same name, holds no place in this
 *     match and is not its organiser. A browser that knows another name gets no offer.
 *
 * Each tap counts against the address's daily "That's me" limit, refused taps too; a success is
 * counted as `held_by_name`, with no name in it. The write is `confirmLocked`, the personal link's own,
 * so the organiser hears "Danny confirmed" either way.
 *
 * The offer stands wherever a join could start: the open spot's typed name, the waiting list's typed
 * name on a full match, and, for a browser that knows a record of the name, in place of its one-tap
 * Join. The web's plain join that would seat a second record of the name beside the place is refused
 * (`whoJoins`), because after it no typed name could take the place. The joins through `joinAsPlayer`
 * (Telegram, Discord, LINE, `join_match`) do not ask yet.
 */

/** A place in the match as the rule reads it: the row, and the name of the record on it when there is one. */
export type HeldSeat = Pick<Slot, "id" | "kind" | "status" | "playerId" | "invitedName" | "invitedEmail" | "invitedPhone" | "position"> & { playerName: string | null };

/** The match as the rule reads it. */
export type HeldMatch = Pick<Event, "status" | "startsAt" | "durationMinutes" | "fixedPairs" | "creatorPlayerId">;

/** Whom the browser knows: nobody, or a record and its name. */
export type HeldViewer = { id: string; name: string } | null;

export type HeldRefusal =
  | "cancelled"
  | "past"
  | "fixed_pairs"
  | "nobody"
  | "namesake"
  | "not_held"
  | "placeholder"
  | "email"
  | "phone"
  | "seated_namesake"
  | "organiser"
  | "already_in"
  | "other_name";

export type HeldVerdict = { ok: true; slotId: string; name: string } | { ok: false; reason: HeldRefusal };

const placeOf = (s: Pick<Slot, "status" | "playerId">) => Boolean(s.playerId) && (s.status === "joined" || s.status === "confirmed");

/**
 * May this browser take the place held for `name` in this match? The first limit that refuses, or the
 * place. Pure: the match page asks it for every held row (`heldOffers`) and the tap asks it twice, once
 * before anything is made and once more under the match's lock, so the page offers what the tap does.
 */
export function heldVerdict(m: HeldMatch, seats: readonly HeldSeat[], name: string, viewer: HeldViewer, now: Date): HeldVerdict {
  const live = liveRefusal(m, now);
  if (live) return { ok: false, reason: live };
  if (m.fixedPairs) return { ok: false, reason: "fixed_pairs" };
  const key = normalName(name);
  if (key.length < 2) return { ok: false, reason: "nobody" };
  const held = seats.filter((s) => s.status === "invited" && normalName(s.invitedName) === key);
  if (held.length === 0) return { ok: false, reason: "nobody" };
  if (held.length > 1) return { ok: false, reason: "namesake" };
  const [place] = held;
  if (place.kind !== "reserved") return { ok: false, reason: "not_held" };
  if (place.playerId) return { ok: false, reason: "placeholder" };
  if (place.invitedEmail) return { ok: false, reason: "email" };
  if (place.invitedPhone) return { ok: false, reason: "phone" };
  if (seats.some((s) => s.id !== place.id && placeOf(s) && normalName(s.playerName) === key)) return { ok: false, reason: "seated_namesake" };
  if (viewer) {
    if (viewer.id === m.creatorPlayerId) return { ok: false, reason: "organiser" };
    if (seats.some((s) => s.playerId === viewer.id)) return { ok: false, reason: "already_in" };
    if (normalName(viewer.name) !== key) return { ok: false, reason: "other_name" };
  }
  return { ok: true, slotId: place.id, name: place.invitedName ?? name.trim() };
}

export type HeldOffer = { slotId: string; name: string };

/** Every held place on this line-up the browser may take: the names the open spot's typed name may take. Pure, over the rows the page already read. */
export function heldOffers(m: HeldMatch, seats: readonly HeldSeat[], viewer: HeldViewer, now: Date): HeldOffer[] {
  return seats.flatMap((s) => {
    if (s.status !== "invited" || !s.invitedName) return [];
    const v = heldVerdict(m, seats, s.invitedName, viewer, now);
    return v.ok && v.slotId === s.id ? [{ slotId: s.id, name: v.name }] : [];
  });
}

/**
 * The held place a plain join would leave behind for good: the place this browser may take by name
 * (`heldVerdict`), for a join that would add a record of that name beside it. A browser that knows
 * nobody asks with the name it typed; a browser that knows a record asks with that record's name. Such
 * a join would seat a second record of the name, and the place could then never be taken by name
 * ("seated_namesake"). So the web's join refuses it (`name_held`), and the page offers the place
 * instead: under the typed name, on a full match's waiting list too, and before a known browser's Join.
 * The held name as the organiser typed it, or null. Pure, over the rows the join read already.
 */
export function heldNameFor(m: HeldMatch, seats: readonly HeldSeat[], viewer: HeldViewer, typed: string | null | undefined, now: Date): string | null {
  const v = heldVerdict(m, seats, viewer ? viewer.name : (typed ?? ""), viewer, now);
  return v.ok ? v.name : null;
}

/** A place as a join reads it: the row and the record on it, as `getEventDetail` gives them. */
type JoinSeat = Omit<HeldSeat, "playerName"> & { player: { displayName: string } | null };

/**
 * Who a plain join on the web seats, decided before anything is made or seated: the browser's own
 * record, else a new record from the typed name (`make`, called only then). A join that would put a
 * second record of a held place's name beside it, in a seat or on the waiting list (`heldNameFor`),
 * gets `{ held }` and no record: `joinAction` refuses it with `name_held`. The places are the line-up
 * and the waiting list the join read already, so there is no read here.
 */
export async function whoJoins<P extends { id: string; displayName: string }>(
  detail: { event: HeldMatch; roster: readonly JoinSeat[]; waitlist: readonly JoinSeat[] },
  known: P | null,
  typed: string | null | undefined,
  now: Date,
  make: () => Promise<P>,
): Promise<{ held: string } | { player: P }> {
  const seats = [...detail.roster, ...detail.waitlist].map((s) => ({ ...s, playerName: s.player?.displayName ?? null }));
  const held = heldNameFor(detail.event, seats, known ? { id: known.id, name: known.displayName } : null, typed, now);
  if (held) return { held };
  return { player: known ?? (await make()) };
}

/**
 * The places of one match with the name of the record on each: one read down
 * `slots_event_position_idx`, as long as the match and its waiting list (rule 12).
 */
export async function heldSeatsOf(db: Db, eventId: string): Promise<HeldSeat[]> {
  const rows = await db
    .select({ seat: slots, name: players.displayName })
    .from(slots)
    .leftJoin(players, eq(players.id, slots.playerId))
    .where(eq(slots.eventId, eventId))
    .orderBy(asc(slots.position));
  return rows.map((r) => ({ ...r.seat, playerName: r.name }));
}

/** A tap the rule let through, before anything is made: the match, the place and its name as the organiser typed it. */
export type HeldDecision = { ok: true; eventId: string; code: string; slotId: string; name: string };
export type HeldFailure = { ok: false; reason: HeldRefusal | "too_many" | "not_found" };

/**
 * The tap's first half. Takes the address's rate first, the same daily bucket as "That's me", so a
 * refused tap costs an attempt too and names cannot be tried one after another; then reads the match
 * and decides. Makes nothing: the caller makes a record only after a yes.
 */
export async function decideHeldByName(db: Db, input: { code: string; name: string; viewer: HeldViewer; rateKey: string; now?: Date }): Promise<HeldDecision | HeldFailure> {
  const now = input.now ?? new Date();
  if (!(await takeRate(db, "thatsme", input.rateKey, LIMITS.thatsMePerIpPerDay, "day", now))) return { ok: false, reason: "too_many" };
  const [ev] = await db.select().from(events).where(eq(events.code, input.code)).limit(1);
  if (!ev) return { ok: false, reason: "not_found" };
  const v = heldVerdict(ev, await heldSeatsOf(db, ev.id), input.name, input.viewer, now);
  if (!v.ok) {
    await bumpMetric(db, "held_by_name_refused").catch(() => undefined);
    return v;
  }
  return { ok: true, eventId: ev.id, code: ev.code, slotId: v.slotId, name: v.name };
}

export type HeldTaken = { ok: true; slot: Slot; event: Event; wasComplete: boolean };

/**
 * The tap's second half, for the record that takes the place (the browser's own, or the one just made
 * from the held name). Under the match's lock it reads the places again and asks the rule again as
 * that record, so a place filled, a name seated or an address added in the meantime closes the door,
 * and a place of another match is never one of these places. Then the personal link's own write
 * (`confirmLocked`). The caller counts `held_by_name` and tells the match (`afterConfirm`).
 */
export async function takeHeldByName(db: Db, d: HeldDecision, taker: { id: string; name: string }, now = new Date()): Promise<HeldTaken | HeldFailure> {
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, d.eventId);
    const seats = await heldSeatsOf(tx, ev.id);
    const v = heldVerdict(ev, seats, d.name, taker, now);
    if (!v.ok) return v;
    if (v.slotId !== d.slotId) return { ok: false, reason: "nobody" };
    const [slot] = await tx.select().from(slots).where(and(eq(slots.id, v.slotId), eq(slots.eventId, ev.id))).limit(1);
    if (!slot) return { ok: false, reason: "nobody" };
    const wasComplete = lineupComplete(seats, ev.capacity);
    const done = await confirmLocked(tx, ev, slot, { playerId: taker.id, now });
    return { ok: true, ...done, wasComplete };
  });
}

/** The state of a personal link's place as its page reads it. */
export type InviteState = "invited" | "declined" | "confirmed_mine" | "gone" | "cancelled";

/** What a personal link's page shows. */
export type InviteView = "actions" | "declined" | "held_for" | "open_again" | "confirmed" | "already_in" | "gone" | "cancelled";

/**
 * What a personal link's page shows. `inMatch`: the viewer's record holds a place in this match
 * already. `theirs`: `mayUseHeldLink` in `slots.ts` said yes for that record, the server's own rule.
 * A viewer in the match on a place that is not theirs never gets "I'm in", which would only free the
 * place: a held place says whose it is ("held_for"), and a declined one says that it is open
 * ("open_again"), as the line-up does. Pure.
 */
export function inviteView(state: InviteState, inMatch: boolean, theirs: boolean): InviteView {
  if (state === "cancelled") return "cancelled";
  if (state === "confirmed_mine") return "confirmed";
  if (state === "gone") return inMatch ? "already_in" : "gone";
  const other = inMatch && !theirs;
  if (state === "invited") return other ? "held_for" : "actions";
  return other ? "open_again" : "declined";
}
