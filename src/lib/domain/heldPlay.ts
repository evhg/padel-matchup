import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, players, slots, type Event, type Slot } from "@/db/schema";
import { createPlayer } from "./players";

/**
 * A held place that played (the owner, 24 November 2026: "put held players in the pairs"). After the
 * start a place held for somebody who never tapped "I'm in" is still the person who stood on the court,
 * so the score's pairs may name it. Saving the pairs makes each such place a seat: confirmed, for the
 * record the place keeps (a past player the organiser picked), or for a new record of the held name,
 * the record a tap on "I'm Danny" makes (`takeHeldPlaceAction`). Then it counts as played everywhere a
 * seat counts: the score's sides, the levels, My matches.
 *
 * Kept apart from `lineupFix.ts` so the score save (`saveMatchScore`) can call it inside its own
 * transaction without the level code; a leaf of the schema and `createPlayer` only.
 */

/** A place held for a name and taken by nobody, inside the capacity: the places the score's pairs may name. */
export const playsHeld = (s: Pick<Slot, "kind" | "status" | "position" | "invitedName" | "playerId">, capacity: number): boolean =>
  s.kind === "reserved" && s.status === "invited" && s.position <= capacity && Boolean(s.invitedName || s.playerId);

/**
 * Every held place of this match becomes a confirmed seat, each with its record. One activity line each,
 * naming who saved the pairs (`meta.played`). The lock is the caller's. Returns the places it seated.
 */
export async function playHeldLocked(tx: Db, ev: Event, actorPlayerId: string | null, now: Date, locale = "en"): Promise<Slot[]> {
  const held = (await tx
    .select()
    .from(slots)
    .where(and(eq(slots.eventId, ev.id), sql`${slots.position} <= ${ev.capacity}`, eq(slots.status, "invited"), eq(slots.kind, "reserved")))
    .orderBy(asc(slots.position))).filter((s) => playsHeld(s, ev.capacity));
  const seated: Slot[] = [];
  for (const s of held) {
    const record = s.playerId ?? (await createPlayer(tx, { displayName: s.invitedName ?? "", locale })).id;
    const [row] = await tx.update(slots).set({ playerId: record, status: "confirmed", joinedAt: now }).where(eq(slots.id, s.id)).returning();
    const [p] = await tx.select({ name: players.displayName }).from(players).where(eq(players.id, record)).limit(1);
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId, verb: "confirmed", meta: { name: p?.name ?? s.invitedName, played: 1 }, createdAt: now });
    seated.push(row);
  }
  return seated;
}
