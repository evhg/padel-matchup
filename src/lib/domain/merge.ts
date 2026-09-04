import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, events, players, scores, slots, tournamentMatches, tournamentRounds, venues } from "@/db/schema";
import { DomainError } from "./errors";

/**
 * Folds identities `from` into `into`: events, slots (duplicates in the same
 * event are freed), scores, activity, tournament matches/rounds/standings and
 * venues move over; the sources are deleted. Crypto-free on purpose so slot
 * code (reachable from client bundles) can import it.
 */
export async function mergePlayers(db: Db, into: string, from: string[]): Promise<void> {
  const sources = [...new Set(from)].filter((id) => id !== into);
  if (sources.length === 0) return;
  await db.transaction(async (tx) => {
    const [target] = await tx.select().from(players).where(eq(players.id, into));
    if (!target) throw new DomainError("not_found");
    const srcRows = await tx.select().from(players).where(inArray(players.id, sources));

    await tx.update(events).set({ creatorPlayerId: into }).where(inArray(events.creatorPlayerId, sources));

    const mine = await tx.select({ eventId: slots.eventId }).from(slots).where(eq(slots.playerId, into));
    const mineEvents = new Set(mine.map((m) => m.eventId));
    const theirs = await tx.select().from(slots).where(inArray(slots.playerId, sources));
    for (const s of theirs) {
      if (mineEvents.has(s.eventId)) {
        const [ev] = await tx.select({ capacity: events.capacity }).from(events).where(eq(events.id, s.eventId));
        if (ev && s.position > ev.capacity) await tx.delete(slots).where(eq(slots.id, s.id));
        else
          await tx
            .update(slots)
            .set({ playerId: null, status: "empty", kind: "open", inviteCode: null, invitedName: null, invitedEmail: null, invitedPhone: null, invitedAt: null, lastRemindedAt: null, joinedAt: null, team: null })
            .where(eq(slots.id, s.id));
      } else {
        await tx.update(slots).set({ playerId: into }).where(eq(slots.id, s.id));
        mineEvents.add(s.eventId);
      }
    }

    await tx.update(scores).set({ enteredByPlayerId: into }).where(inArray(scores.enteredByPlayerId, sources));
    await tx.update(activity).set({ actorPlayerId: into }).where(inArray(activity.actorPlayerId, sources));
    for (const col of [tournamentMatches.a1, tournamentMatches.a2, tournamentMatches.b1, tournamentMatches.b2] as const) {
      await tx.update(tournamentMatches).set({ [col.name === "a1" ? "a1" : col.name === "a2" ? "a2" : col.name === "b1" ? "b1" : "b2"]: into } as never).where(inArray(col, sources));
    }
    await tx.update(tournamentMatches).set({ enteredByPlayerId: into }).where(inArray(tournamentMatches.enteredByPlayerId, sources));

    const rounds = await tx.select({ id: tournamentRounds.id, resting: tournamentRounds.resting }).from(tournamentRounds);
    for (const r of rounds) {
      if (r.resting.some((id) => sources.includes(id))) {
        await tx.update(tournamentRounds).set({ resting: [...new Set(r.resting.map((id) => (sources.includes(id) ? into : id)))] }).where(eq(tournamentRounds.id, r.id));
      }
    }
    const withStandings = await tx.select({ id: events.id, standings: events.standings }).from(events).where(sql`${events.standings} is not null`);
    for (const e of withStandings) {
      if (e.standings?.some((id) => sources.includes(id))) {
        await tx.update(events).set({ standings: [...new Set(e.standings.map((id) => (sources.includes(id) ? into : id)))] }).where(eq(events.id, e.id));
      }
    }

    const myVenues = await tx.select({ name: venues.name }).from(venues).where(eq(venues.creatorPlayerId, into));
    const names = new Set(myVenues.map((v) => v.name));
    const theirVenues = await tx.select().from(venues).where(inArray(venues.creatorPlayerId, sources));
    for (const v of theirVenues) {
      if (names.has(v.name)) await tx.delete(venues).where(eq(venues.id, v.id));
      else {
        await tx.update(venues).set({ creatorPlayerId: into }).where(eq(venues.id, v.id));
        names.add(v.name);
      }
    }

    const patch: Partial<typeof players.$inferInsert> = {};
    if (!target.email) patch.email = srcRows.find((s) => s.email)?.email ?? null;
    if (!target.phone) patch.phone = srcRows.find((s) => s.phone)?.phone ?? null;
    if (Object.keys(patch).length) await tx.update(players).set(patch).where(eq(players.id, into));

    await tx.delete(players).where(inArray(players.id, sources));
  });
}
