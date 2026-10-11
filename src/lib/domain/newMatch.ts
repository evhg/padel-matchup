import type { Db } from "@/db";
import type { Event, Player } from "@/db/schema";
import { setCourtBooked } from "./courtBooked";
import { isOver } from "./matchLength";
import { pairInOrder } from "./pairSeats";
import { joinEvent, seatNames } from "./slots";

export type Settled = { joined: boolean; held: number; booked: boolean };

/**
 * What the web's create does once the match exists, in this order: the organiser's own seat, the
 * names they already have held as reserved spots (one transaction under the event's lock,
 * `reserveNames` through `seatNames`), and the court marked booked by the organiser when they booked
 * it before the match existed (a pasted booking, `booked`: "Court booked by me" on the form).
 *
 * None of it is in the event's own transaction, and nothing can come between them: the match's code is
 * new and nobody has its link until the create answers, so no other person can take a spot or mark
 * the court first. A step that fails leaves the match the person asked for, with one thing less on it
 * (the organiser holds the names or taps "I booked it" on the page), and never a second match from a
 * retry. A match logged after it was played is never marked booked: a court is booked before it is
 * played (`setCourtBooked`).
 */
export async function settleNewMatch(
  db: Db,
  input: { event: Event; organiser: Pick<Player, "id" | "displayName">; joinSelf?: boolean; names?: readonly string[]; booked?: boolean; now?: Date },
): Promise<Settled> {
  const now = input.now ?? new Date();
  const eventId = input.event.id;
  let joined = false;
  if (input.joinSelf !== false) {
    // Organisers play too. Skipped quietly when the match was logged after the fact.
    const r = await joinEvent(db, { eventId, playerId: input.organiser.id, now }).catch(() => null);
    joined = r?.outcome === "joined";
  }
  let held = 0;
  if (input.names?.length) {
    held = await seatNames(db, { eventId, actorPlayerId: input.organiser.id, names: [...input.names], skipName: input.organiser.displayName, now });
    // Fixed pairs: the names were typed as pairs, the organiser with the first one.
    if (input.event.fixedPairs) await pairInOrder(db, { eventId }).catch(() => 0);
  }
  let booked = false;
  if (input.booked && !isOver(input.event, now)) {
    // The organiser may mark it (`mayMarkBooked`), seated or not; one update by the event's key.
    booked = await setCourtBooked(db, { event: input.event, roster: [] }, input.organiser.id, true, now).catch(() => false);
  }
  return { joined, held, booked };
}
