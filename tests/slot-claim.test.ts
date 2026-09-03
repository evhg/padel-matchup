import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, slots } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { joinEvent, leaveEvent, removeFromSlot, reserveSlot } from "@/lib/domain/slots";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const future = () => new Date(Date.now() + 24 * HOUR);

describe("slot claiming", () => {
  it("resolves 12 simultaneous taps on a 4-slot match into exactly 4 joins + waitlist", async () => {
    const creator = await makePlayer(db, "Creator");
    const ev = await createEvent(db, {
      creatorPlayerId: creator.id,
      type: "match",
      startsAt: future(),
      tz: "Europe/Madrid",
      venueName: "Court 1",
      whenFull: "waitlist",
    });
    const people = await Promise.all(Array.from({ length: 12 }, (_, i) => makePlayer(db, `P${i}`)));
    const results = await Promise.all(people.map((p) => joinEvent(db, { eventId: ev.id, playerId: p.id })));

    const joined = results.filter((r) => r.outcome === "joined");
    const waitlisted = results.filter((r) => r.outcome === "waitlisted");
    expect(joined).toHaveLength(4);
    expect(waitlisted).toHaveLength(8);

    const roster = await db.select().from(slots).where(eq(slots.eventId, ev.id));
    const rosterSlots = roster.filter((s) => s.position <= 4);
    expect(rosterSlots.every((s) => s.status === "joined" && s.playerId)).toBe(true);
    expect(new Set(rosterSlots.map((s) => s.playerId)).size).toBe(4);
    // Waitlist positions are unique and strictly after the roster.
    const wl = roster.filter((s) => s.position > 4).map((s) => s.position).sort((a, b) => a - b);
    expect(wl).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);

    const [fresh] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(fresh.status).toBe("full");
  });

  it("hard-closed events reject the loser with 'full' and never overbook", async () => {
    const creator = await makePlayer(db, "Creator2");
    const ev = await createEvent(db, {
      creatorPlayerId: creator.id,
      type: "match",
      startsAt: future(),
      tz: "UTC",
      venueName: "Court 2",
      whenFull: "closed",
    });
    const people = await Promise.all(Array.from({ length: 10 }, (_, i) => makePlayer(db, `Q${i}`)));
    const results = await Promise.all(people.map((p) => joinEvent(db, { eventId: ev.id, playerId: p.id })));
    expect(results.filter((r) => r.outcome === "joined")).toHaveLength(4);
    expect(results.filter((r) => r.outcome === "full")).toHaveLength(6);
    const rows = await db.select().from(slots).where(eq(slots.eventId, ev.id));
    expect(rows).toHaveLength(4);
  });

  it("is idempotent for the same player tapping twice", async () => {
    const creator = await makePlayer(db, "Creator3");
    const ev = await createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: future(), tz: "UTC", venueName: "X", whenFull: "waitlist" });
    const p = await makePlayer(db, "Double");
    const [a, b] = await Promise.all([joinEvent(db, { eventId: ev.id, playerId: p.id }), joinEvent(db, { eventId: ev.id, playerId: p.id })]);
    expect([a.outcome, b.outcome].sort()).toEqual(["already_in", "joined"]);
    const mine = await db.select().from(slots).where(and(eq(slots.eventId, ev.id), eq(slots.playerId, p.id)));
    expect(mine).toHaveLength(1);
  });

  it("auto-promotes the first waitlisted player when someone leaves", async () => {
    const creator = await makePlayer(db, "Creator4");
    const ev = await createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: future(), tz: "UTC", venueName: "X", whenFull: "waitlist" });
    const people = [];
    for (let i = 0; i < 6; i++) people.push(await makePlayer(db, `W${i}`));
    for (const p of people) await joinEvent(db, { eventId: ev.id, playerId: p.id });

    const res = await leaveEvent(db, { eventId: ev.id, playerId: people[1].id });
    expect(res.left).toBe(true);
    expect(res.promotion?.playerId).toBe(people[4].id);
    expect(res.promotion?.slot.position).toBe(2);

    const rows = await db.select().from(slots).where(eq(slots.eventId, ev.id));
    expect(rows.filter((s) => s.position <= 4).map((s) => s.playerId).sort()).toEqual([people[0].id, people[4].id, people[2].id, people[3].id].sort());
    expect(rows.filter((s) => s.position > 4).map((s) => s.playerId)).toEqual([people[5].id]);
    expect(res.event.status).toBe("full");

    // Leaving from the waitlist just removes the entry.
    const res2 = await leaveEvent(db, { eventId: ev.id, playerId: people[5].id });
    expect(res2.wasWaitlisted).toBe(true);
    expect(res2.promotion).toBeNull();
  });

  it("reserved slots are not claimable by walk-ins; creator can remove anyone", async () => {
    const creator = await makePlayer(db, "Creator5");
    const ev = await createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: future(), tz: "UTC", venueName: "X", whenFull: "closed" });
    await reserveSlot(db, { eventId: ev.id, actorPlayerId: creator.id, name: "Ana" });
    await reserveSlot(db, { eventId: ev.id, actorPlayerId: creator.id, name: "Ben" });
    await reserveSlot(db, { eventId: ev.id, actorPlayerId: creator.id, name: "Cy" });
    const p1 = await makePlayer(db, "Walk1");
    const p2 = await makePlayer(db, "Walk2");
    const r1 = await joinEvent(db, { eventId: ev.id, playerId: p1.id });
    const r2 = await joinEvent(db, { eventId: ev.id, playerId: p2.id });
    expect(r1.outcome).toBe("joined");
    expect(r2.outcome).toBe("full");
    await expect(reserveSlot(db, { eventId: ev.id, actorPlayerId: creator.id, name: "Dee" })).rejects.toMatchObject({ code: "full" });

    const rows = await db.select().from(slots).where(eq(slots.eventId, ev.id));
    const ana = rows.find((s) => s.invitedName === "Ana")!;
    const removed = await removeFromSlot(db, { eventId: ev.id, slotId: ana.id, actorPlayerId: creator.id });
    expect(removed.removedName).toBe("Ana");
    expect(removed.event.status).toBe("open");
    const r3 = await joinEvent(db, { eventId: ev.id, playerId: p2.id });
    expect(r3.outcome).toBe("joined");
  });

  it("refuses joins on cancelled or finished events", async () => {
    const creator = await makePlayer(db, "Creator6");
    const ev = await createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: new Date(Date.now() - 5 * HOUR), tz: "UTC", venueName: "X", whenFull: "waitlist" });
    const p = await makePlayer(db, "Late");
    await expect(joinEvent(db, { eventId: ev.id, playerId: p.id })).rejects.toMatchObject({ code: "past" });
  });
});
