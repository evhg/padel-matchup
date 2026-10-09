import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, events, slots } from "@/db/schema";
import { presentSpots, startAdvice } from "@/lib/domain/checkIn";
import { createEvent } from "@/lib/domain/events";
import { joinEvent, reserveSlot } from "@/lib/domain/slots";
import { addWalkIn, generateRound, loadRounds } from "@/lib/domain/tournament";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

/**
 * "Who is here?" before round 1 of a social tournament (October 2026): every name ticked by
 * default, the waiting list unticked, walk-ins added as reserved names, and round 1 drawing only
 * the ticked. The rule is pure (`src/lib/domain/checkIn.ts`); the write is `generateRound` with a
 * check-in, which takes the unticked out in the same transaction as the draw.
 *
 * The night starts an hour before NOW, so it is running and not over (120 minutes by default).
 */
const NOW = new Date("2026-10-09T12:00:00Z");
freezeClock(NOW);

describe("the check-in, pure", () => {
  const names = { listed: ["a", "b", "c", "d", "e"], waiting: ["w1", "w2"] };

  it("draws the list in order, minus the unticked, then the ticked waiting list in order", () => {
    expect(presentSpots(names, { away: new Set(), waitingIn: new Set() })).toEqual(["a", "b", "c", "d", "e"]);
    expect(presentSpots(names, { away: new Set(["b", "e"]), waitingIn: new Set(["w2"]) })).toEqual(["a", "c", "d", "w2"]);
    // A name the screen never saw takes its default: a new listed name plays, a new waiting name does not.
    expect(presentSpots({ listed: [...names.listed, "walk-in"], waiting: [...names.waiting, "w3"] }, { away: new Set(["a"]), waitingIn: new Set() })).toEqual(["b", "c", "d", "e", "walk-in"]);
  });

  it("starts americano and mexicano at four or more, and says how many more below four", () => {
    expect(startAdvice("americano", 3)).toEqual({ kind: "need_4", count: 3, more: 1 });
    expect(startAdvice("mexicano", 0)).toEqual({ kind: "need_4", count: 0, more: 4 });
    for (const n of [4, 5, 7, 10, 13]) {
      expect(startAdvice("americano", n)).toEqual({ kind: "ready", count: n });
      expect(startAdvice("mexicano", n)).toEqual({ kind: "ready", count: n });
    }
  });

  it("tells king how many to tick or add, or untick, to reach a four", () => {
    expect(startAdvice("king", 8)).toEqual({ kind: "ready", count: 8 });
    expect(startAdvice("king", 2)).toEqual({ kind: "need_4", count: 2, more: 2 });
    expect(startAdvice("king", 5)).toEqual({ kind: "fours", count: 5, up: 3, down: 1 });
    expect(startAdvice("king", 7)).toEqual({ kind: "fours", count: 7, up: 1, down: 3 });
    expect(startAdvice("king", 10)).toEqual({ kind: "fours", count: 10, up: 2, down: 2 });
    // Unticking `down` always leaves a field king can start.
    for (let n = 5; n <= 30; n++) {
      const a = startAdvice("king", n);
      if (a.kind === "fours") {
        expect((n - a.down) % 4).toBe(0);
        expect(n - a.down).toBeGreaterThanOrEqual(4);
        expect((n + a.up) % 4).toBe(0);
      }
    }
  });
});

describe("round 1 with a check-in", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  /** A night for `capacity` with the organiser and `joined` players on the list; joins past the capacity wait. */
  async function night(capacity: number, joined: number, format: "americano" | "king" = "americano") {
    const org = await makePlayer(db, "Org");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "tournament", capacity, startsAt: new Date(NOW.getTime() - HOUR), tz: "Asia/Bangkok", venueName: null, whenFull: "waitlist", format });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    const people = [];
    for (let i = 1; i <= joined; i++) {
      const p = await makePlayer(db, `P${i}`);
      await joinEvent(db, { eventId: ev.id, playerId: p.id });
      people.push(p);
    }
    const all = await db.select().from(slots).where(eq(slots.eventId, ev.id)).orderBy(asc(slots.position));
    const spotOf = (playerId: string) => all.find((s) => s.playerId === playerId)!.id;
    return { org, ev, people, spotOf };
  }
  const drawn = (r: { matches: { a1: string; a2: string; b1: string; b2: string }[]; resting: string[] }) => new Set([...r.matches.flatMap((m) => [m.a1, m.a2, m.b1, m.b2]), ...r.resting]);

  it("draws only the ticked and the walk-in, records each name left out, and shrinks the field to them", async () => {
    const { org, ev, people, spotOf } = await night(8, 5);
    // P5 walked in late: the organiser adds them as a reserved name, as "Open spot" does.
    const { slot: walkIn } = await reserveSlot(db, { eventId: ev.id, actorPlayerId: org.id, name: "Wes" });
    const away = [spotOf(people[1].id), spotOf(people[3].id)];
    // Org, P1, P3, P5 and Wes: five.
    const r1 = await generateRound(db, { eventId: ev.id, actorPlayerId: org.id, checkIn: { away, waitingIn: [], count: 5 } });

    expect(r1.absent.map((a) => a.name).sort()).toEqual(["P2", "P4"]);
    expect(r1.absent.map((a) => a.playerId).sort()).toEqual([people[1].id, people[3].id].sort());
    const ids = drawn(r1);
    expect(ids.size).toBe(5);
    for (const p of [org, people[0], people[2], people[4]]) expect(ids.has(p.id)).toBe(true);
    for (const p of [people[1], people[3]]) expect(ids.has(p.id)).toBe(false);
    const [wes] = await db.select().from(slots).where(eq(slots.id, walkIn.id));
    expect(ids.has(wes.playerId!)).toBe(true);

    const [after] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(after.capacity).toBe(5);
    const left = await db.select().from(slots).where(eq(slots.eventId, ev.id));
    expect(left.map((s) => s.playerId)).not.toContain(people[1].id);
    expect(left.map((s) => s.playerId)).not.toContain(people[3].id);
    // The same row "Remove player" writes, one per name, so the feed says who was taken out.
    const removed = await db.select().from(activity).where(and(eq(activity.eventId, ev.id), eq(activity.verb, "removed")));
    expect(removed.map((a) => (a.meta as { name: string }).name).sort()).toEqual(["P2", "P4"]);
  });

  it("plays a ticked waiting-list name, and leaves the rest of the waiting list waiting", async () => {
    // Four seats, six joins after the organiser: P4 to P6 wait, in that order.
    const { org, ev, people, spotOf } = await night(4, 6);
    const p5 = spotOf(people[4].id);
    const r1 = await generateRound(db, { eventId: ev.id, actorPlayerId: org.id, checkIn: { away: [], waitingIn: [p5], count: 5 } });
    expect(r1.absent).toEqual([]);
    const ids = drawn(r1);
    expect(ids.size).toBe(5);
    expect(ids.has(people[4].id)).toBe(true);
    expect(ids.has(people[3].id)).toBe(false);
    expect(ids.has(people[5].id)).toBe(false);

    const [after] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(after.capacity).toBe(5);
    const rows = await db.select().from(slots).where(eq(slots.eventId, ev.id)).orderBy(asc(slots.position));
    // P4 and P6 are still on the waiting list, behind the field, in their order.
    expect(rows.filter((s) => s.position > 5).map((s) => s.playerId)).toEqual([people[3].id, people[5].id]);
  });

  it("refuses a check-in the list has moved under, and writes nothing", async () => {
    const { org, ev, people, spotOf } = await night(8, 5);
    // A count the screen did not show: somebody joined after it opened.
    await expect(generateRound(db, { eventId: ev.id, actorPlayerId: org.id, checkIn: { away: [spotOf(people[0].id)], waitingIn: [], count: 6 } })).rejects.toMatchObject({ code: "invalid", message: "roster_changed" });
    // A spot that is not on the list.
    await expect(generateRound(db, { eventId: ev.id, actorPlayerId: org.id, checkIn: { away: ["00000000-0000-0000-0000-000000000000"], waitingIn: [], count: 6 } })).rejects.toMatchObject({ code: "invalid", message: "roster_changed" });
    // A listed spot passed as a waiting one.
    await expect(generateRound(db, { eventId: ev.id, actorPlayerId: org.id, checkIn: { away: [], waitingIn: [spotOf(people[0].id)], count: 7 } })).rejects.toMatchObject({ code: "invalid", message: "roster_changed" });
    expect(await loadRounds(db, ev.id)).toEqual([]);
    expect(await db.select().from(activity).where(and(eq(activity.eventId, ev.id), eq(activity.verb, "removed")))).toEqual([]);
    const [same] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(same.capacity).toBe(8);
  });

  it("keeps king in fours: a check-in of seven is refused and takes nobody out", async () => {
    const { org, ev, people, spotOf } = await night(8, 7, "king");
    await expect(generateRound(db, { eventId: ev.id, actorPlayerId: org.id, checkIn: { away: [spotOf(people[6].id)], waitingIn: [], count: 7 } })).rejects.toMatchObject({ code: "invalid", message: "multiple_of_4" });
    expect(await db.select().from(activity).where(and(eq(activity.eventId, ev.id), eq(activity.verb, "removed")))).toEqual([]);
    const r1 = await generateRound(db, { eventId: ev.id, actorPlayerId: org.id, checkIn: { away: [], waitingIn: [], count: 8 } });
    expect(drawn(r1).size).toBe(8);
  });

  it("adds a walk-in to a full night by one spot, and moves nobody up from the waiting list", async () => {
    // Eight seats, the organiser and seven on the list; P8 to P12 wait, in that order.
    const { org, ev, people } = await night(8, 12);
    const waiting = people.slice(7).map((p) => p.id);
    const { slot, grew } = await addWalkIn(db, { eventId: ev.id, actorPlayerId: org.id, name: "Wes" });
    expect(grew).toBe(true);
    expect(slot.position).toBe(9);
    expect(slot.invitedName).toBe("Wes");

    const [after] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(after.capacity).toBe(9);
    const rows = await db.select().from(slots).where(eq(slots.eventId, ev.id)).orderBy(asc(slots.position));
    // No spot is left open for the hourly cron to fill from the waiting list or to offer to strangers.
    expect(rows.filter((s) => s.position <= 9 && s.status === "empty")).toEqual([]);
    // The five still wait, behind the field, in their order, and nobody was moved up.
    expect(rows.filter((s) => s.position > 9).map((s) => [s.position, s.playerId, s.status])).toEqual(waiting.map((id, i) => [10 + i, id, "joined"]));
    expect(await db.select().from(activity).where(and(eq(activity.eventId, ev.id), eq(activity.verb, "promoted")))).toEqual([]);

    // A second walk-in grows it again; the check-in's defaults then draw the list and both walk-ins.
    await addWalkIn(db, { eventId: ev.id, actorPlayerId: org.id, name: "Zoe" });
    const r1 = await generateRound(db, { eventId: ev.id, actorPlayerId: org.id, checkIn: { away: [], waitingIn: [], count: 10 } });
    const ids = drawn(r1);
    expect(ids.size).toBe(10);
    for (const id of waiting) expect(ids.has(id)).toBe(false);
  });

  it("puts a walk-in on an open spot without growing the night, and refuses one once round 1 is drawn", async () => {
    const { org, ev } = await night(8, 5);
    const { slot, grew } = await addWalkIn(db, { eventId: ev.id, actorPlayerId: org.id, name: "Wes" });
    expect(grew).toBe(false);
    expect(slot.position).toBe(7);
    const [same] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(same.capacity).toBe(8);

    await generateRound(db, { eventId: ev.id, actorPlayerId: org.id, checkIn: { away: [], waitingIn: [], count: 7 } });
    await expect(addWalkIn(db, { eventId: ev.id, actorPlayerId: org.id, name: "Zoe" })).rejects.toMatchObject({ code: "invalid", message: "roster_changed" });
  });
});
