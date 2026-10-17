import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { activity, events, players, scores, slots, type Event } from "@/db/schema";
import { getEventByCode, getEventDetail, type EventDetail, type SlotWithPlayer } from "@/lib/domain/queries";
import { createTestDb, makePlayer } from "./helpers/db";

/**
 * The match detail in one statement (16 October 2026). Until then `getEventByCode` read the match and
 * `getEventDetail` sent four reads at once (the organiser, the places, the sets, the activity). The
 * reads below are those five, kept here as the reference: the one statement must give the same answer,
 * field by field, on PGlite and on real Postgres (TEST_DATABASE_URL), where the nested rows come back
 * as JSON and every column is decoded again.
 */
async function fiveReadsByCode(db: Db, code: string): Promise<EventDetail | null> {
  const [ev] = await db.select().from(events).where(eq(events.code, code)).limit(1);
  if (!ev) return null;
  return fourReads(db, ev);
}

async function fourReads(db: Db, ev: Event): Promise<EventDetail> {
  const [[creator], slotRows, scoreRows, actRows] = await Promise.all([
    db.select().from(players).where(eq(players.id, ev.creatorPlayerId)),
    db.select({ slot: slots, player: players }).from(slots).leftJoin(players, eq(players.id, slots.playerId)).where(eq(slots.eventId, ev.id)).orderBy(asc(slots.position)),
    db.select().from(scores).where(eq(scores.eventId, ev.id)).orderBy(asc(scores.setNumber)),
    db.select({ activity, actor: players }).from(activity).leftJoin(players, eq(players.id, activity.actorPlayerId)).where(eq(activity.eventId, ev.id)).orderBy(desc(activity.createdAt)).limit(50),
  ]);
  const all: SlotWithPlayer[] = slotRows.map((r) => ({ ...r.slot, player: r.player }));
  return {
    event: ev,
    creator,
    roster: all.filter((s) => s.position <= ev.capacity),
    waitlist: all.filter((s) => s.position > ev.capacity),
    scores: scoreRows,
    activity: actRows.map((r) => ({ ...r.activity, actor: r.actor })),
  };
}

/** The same database through a second handle that counts the statements it sends. */
async function counting(db: Db): Promise<{ db: Db; sent: () => number }> {
  let n = 0;
  const logger = { logQuery: () => void n++ };
  const client = (db as unknown as { $client: unknown }).$client;
  const { drizzle } = process.env.TEST_DATABASE_URL ? await import("drizzle-orm/postgres-js") : await import("drizzle-orm/pglite");
  const counted = (drizzle as unknown as (c: unknown, o: object) => Db)(client, { schema, logger });
  return { db: counted, sent: () => n };
}

let db: Db;
let close: () => Promise<void>;
let ev: Event;
const T0 = Date.UTC(2026, 9, 1, 10, 0, 0, 0);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  // Columns whose JSON form differs from their plain form: a real, a bigint, two jsonb, timestamps.
  const org = await makePlayer(db, "Org", { level: 3.3, telegramId: 9_007_199_254, email: "org@example.com", noticeKinds: { spots: false }, levelLog: [{ at: "2026-09-01T10:00:00.000Z", from: 3, to: 3.3, code: "OLD1", type: "match" }] });
  const ana = await makePlayer(db, "Ana", { level: 2.5 });
  const bo = await makePlayer(db, "Bo");
  const cy = await makePlayer(db, "Cy", { level: 4 });
  const dee = await makePlayer(db, "Dee");
  [ev] = await db
    .insert(events)
    .values({ code: "DTL1", type: "match", startsAt: new Date(T0 + 2 * 86_400_000), tz: "Asia/Bangkok", venueName: "Warehaus", capacity: 4, creatorPlayerId: org.id, manageCode: "mngDTL1xxx", note: "bring balls", courtNames: ["A", "B"] })
    .returning();
  // Six places on a match of four: the line-up is positions 1 to 4, the waiting list 5 and 6. They go
  // in shuffled (6, 2, 5, 1, 4, 3), and place 1 is filled afterwards, as a join fills an empty place,
  // so the table holds them out of position order. Places written in position order come back in that
  // order with no ORDER BY at all, and the test could not see the order go (review, 15 October 2026).
  await db.insert(slots).values([
    { eventId: ev.id, position: 6, playerId: cy.id, status: "joined", joinedAt: new Date(T0 + 4000) },
    { eventId: ev.id, position: 2, playerId: null, status: "invited", kind: "reserved", invitedName: "Danny", inviteCode: "dny001", invitedAt: new Date(T0 + 1000) },
    { eventId: ev.id, position: 5, playerId: bo.id, status: "joined", joinedAt: new Date(T0 + 3000) },
    { eventId: ev.id, position: 1, playerId: null, status: "empty" },
    { eventId: ev.id, position: 4, playerId: null, status: "empty" },
    { eventId: ev.id, position: 3, playerId: ana.id, status: "confirmed", kind: "reserved", invitedName: "Ana", inviteCode: "ana001", team: "a", joinedAt: new Date(T0 + 2000) },
  ]);
  await db
    .update(slots)
    .set({ playerId: org.id, status: "joined", joinedAt: new Date(T0) })
    .where(and(eq(slots.eventId, ev.id), eq(slots.position, 1)));
  // `updated_at` is the database's own now(), with microseconds the JSON form carries too.
  await db.insert(scores).values([
    { eventId: ev.id, setNumber: 2, sideA: 4, sideB: 6, enteredByPlayerId: org.id },
    { eventId: ev.id, setNumber: 1, sideA: 6, sideB: 3, enteredByPlayerId: null },
  ]);
  // Sixty lines, each a minute apart (two lines with one timestamp may come back in either order), so
  // the limit of 50 leaves the ten oldest out. Some have no actor, some carry meta.
  const verbs = ["created", "joined", "left", "invited", "score_entered"] as const;
  await db.insert(activity).values(
    Array.from({ length: 60 }, (_, i) => ({
      eventId: ev.id,
      actorPlayerId: i % 7 === 0 ? null : [org.id, ana.id, bo.id, dee.id][i % 4],
      verb: verbs[i % verbs.length],
      meta: i % 3 === 0 ? { name: `n${i}`, n: i } : null,
      createdAt: new Date(T0 + (i + 1) * 60_000),
    })),
  );
});
afterAll(async () => close());

describe("the match detail in one statement", () => {
  it("gives what the five reads gave, by code", async () => {
    const one = await getEventByCode(db, "DTL1");
    expect(one).toEqual(await fiveReadsByCode(db, "DTL1"));
    // Not a match of two empty answers: the fixture reaches every part.
    expect(one!.roster.map((s) => s.position)).toEqual([1, 2, 3, 4]);
    expect(one!.waitlist.map((s) => s.player?.displayName)).toEqual(["Bo", "Cy"]);
    expect(one!.scores.map((s) => s.setNumber)).toEqual([1, 2]);
    expect(one!.activity).toHaveLength(50);
    expect(one!.activity[0].createdAt.getTime()).toBe(T0 + 60 * 60_000);
    expect(one!.activity.filter((a) => a.actor === null).length).toBeGreaterThan(0);
    expect(one!.creator.telegramId).toBe(9_007_199_254);
    expect(one!.event.courtNames).toEqual(["A", "B"]);
  });

  it("gives what the four reads gave for a match the caller holds, and keeps that match as passed", async () => {
    const held = { ...ev, title: "as the caller read it" };
    const one = await getEventDetail(db, held);
    expect(one).toEqual(await fourReads(db, held));
    expect(one.event).toBe(held);
  });

  it("is one statement each, where it was five", async () => {
    const c = await counting(db);
    const detail = await getEventByCode(c.db, "DTL1");
    expect(detail?.roster).toHaveLength(4);
    expect(c.sent()).toBe(1);
    await getEventDetail(c.db, ev);
    expect(c.sent()).toBe(2);
    const old = await counting(db);
    await fiveReadsByCode(old.db, "DTL1");
    expect(old.sent()).toBe(5);
  });

  it("answers null for a code nobody made", async () => {
    expect(await getEventByCode(db, "ZZZ9")).toBeNull();
  });
});
