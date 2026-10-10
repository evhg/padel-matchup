import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { events } from "@/db/schema";
import { DomainError } from "./errors";
import { isSeated } from "./events";
import type { EventDetail } from "./queries";

/**
 * "I booked it": the court is booked, and who said so. The owner's choice of 10 October 2026: "Book"
 * opens the club's own app, where a player books and pays; Kicksmash then marks the match as booked.
 * One tap by a player in the match (a seat, or the organiser) records who and when; any of them can
 * take it back. Nothing else is kept: no amount, no payment, no reference (DECIDING rule 34). A change
 * of day, hour, length or club clears it (`updateEvent`), because that booking was for another court.
 */

type Who = Pick<EventDetail, "event" | "roster">;

/** May this person mark the court booked, or take the mark back? The organiser, or a player holding a seat. Pure. */
export function mayMarkBooked(detail: Who, playerId: string | null | undefined): boolean {
  return Boolean(playerId) && (detail.event.creatorPlayerId === playerId || isSeated(detail, playerId));
}

/**
 * The mark as every screen and card shows it: when, and the booker's first name, read from the people
 * the page already has (the organiser, the roster, the waiting list). A booker who has since left, or
 * whose row is gone, leaves the mark without a name. Null when the court is not marked booked. Pure.
 */
export function courtBookedBy(detail: Pick<EventDetail, "event" | "roster" | "waitlist" | "creator">): { at: Date; name: string | null } | null {
  const ev = detail.event;
  if (!ev.courtBookedAt) return null;
  const by = ev.courtBookedBy;
  const full = !by ? null : detail.creator.id === by ? detail.creator.displayName : ([...detail.roster, ...detail.waitlist].find((s) => s.playerId === by)?.player?.displayName ?? null);
  const name = full?.trim().split(/\s+/)[0]?.slice(0, 24) || null;
  return { at: ev.courtBookedAt, name };
}

/**
 * Marks the court booked by this person, or takes the mark back. Refuses anybody who is not the
 * organiser or in a seat, and a cancelled match. Returns whether anything changed: a second "booked"
 * keeps the first booker, and an undo of nothing is nothing.
 */
export async function setCourtBooked(db: Db, detail: Who, playerId: string, booked: boolean, now = new Date()): Promise<boolean> {
  if (detail.event.status === "cancelled") throw new DomainError("cancelled");
  if (!mayMarkBooked(detail, playerId)) throw new DomainError("forbidden");
  const rows = booked
    ? await db.update(events).set({ courtBookedAt: now, courtBookedBy: playerId }).where(and(eq(events.id, detail.event.id), isNull(events.courtBookedAt))).returning({ id: events.id })
    : await db.update(events).set({ courtBookedAt: null, courtBookedBy: null }).where(and(eq(events.id, detail.event.id), isNotNull(events.courtBookedAt))).returning({ id: events.id });
  return rows.length === 1;
}
