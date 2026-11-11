import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { createEventAction } from "@/actions/events";
import { activity, events, slots } from "@/db/schema";
import { courtBookedBy } from "@/lib/domain/courtBooked";
import { createEvent } from "@/lib/domain/events";
import { settleNewMatch } from "@/lib/domain/newMatch";
import { getEventByCode } from "@/lib/domain/queries";
import { namesToSeat, roomForNames } from "@/lib/domain/slots";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";

/**
 * What the web's create does once the match exists (`settleNewMatch`, which `createEventAction`
 * calls): the organiser's seat, the names held as reserved spots in one transaction, and "Court
 * booked by me" from a pasted booking. NOW is Sunday 11 October 2026, 13:00 in Phuket; the match is
 * Monday 12 October at 18:00 there (11:00 UTC), 90 minutes.
 */
const NOW = new Date("2026-10-11T06:00:00Z");
freezeClock(NOW);
const MONDAY_18 = new Date("2026-10-12T11:00:00Z");

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const newMatch = async (organiser: { id: string }, startsAt = MONDAY_18) =>
  createEvent(db, { creatorPlayerId: organiser.id, type: "match", startsAt, durationMinutes: 90, tz: "Asia/Bangkok", venueName: "WAREHAUS.club", court: "3", cost: "600 THB", whenFull: "waitlist" });

const roster = (eventId: string) => db.select().from(slots).where(eq(slots.eventId, eventId)).orderBy(asc(slots.position));

describe("a new match from a pasted booking", () => {
  it("seats the organiser, holds Danny and Alberto, and marks the court booked by the organiser", async () => {
    const cath = await makePlayer(db, "Cath");
    const ev = await newMatch(cath);
    const settled = await settleNewMatch(db, { event: ev, organiser: cath, names: ["Danny", "Alberto"], booked: true, now: NOW });
    expect(settled).toEqual({ joined: true, held: 2, booked: true });

    const rows = await roster(ev.id);
    expect(rows.slice(0, 4).map((s) => [s.status, s.playerId ? "player" : s.invitedName])).toEqual([
      ["joined", "player"],
      ["invited", "Danny"],
      ["invited", "Alberto"],
      ["empty", null],
    ]);
    const [row] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(row.courtBookedBy).toBe(cath.id);
    expect(row.courtBookedAt?.toISOString()).toBe(NOW.toISOString());
    // The length, the court and the price the form passed are the event's, as on any create.
    expect([row.durationMinutes, row.court, row.cost, row.publicListing]).toEqual([90, "3", "600 THB", false]);
    // The page, the cards and the API read the mark as "Court booked ✓ (by Cath)".
    const detail = (await getEventByCode(db, ev.code))!;
    expect(courtBookedBy(detail)).toEqual({ at: NOW, name: "Cath" });
  });

  it("leaves the court unmarked when the organiser unticks 'Court booked by me', and holds the names all the same", async () => {
    const ana = await makePlayer(db, "Ana");
    const ev = await newMatch(ana);
    expect(await settleNewMatch(db, { event: ev, organiser: ana, names: ["Danny"], booked: false, now: NOW })).toEqual({ joined: true, held: 1, booked: false });
    const [row] = await db.select().from(events).where(eq(events.id, ev.id));
    expect([row.courtBookedAt, row.courtBookedBy]).toEqual([null, null]);
  });

  it("passes over the organiser's own name once, and stops at the last free spot", async () => {
    const bo = await makePlayer(db, "Bo Lee");
    const ev = await newMatch(bo);
    const settled = await settleNewMatch(db, { event: ev, organiser: bo, names: ["Bo Lee", "Cy", "Di", "Ed", "Fi"], booked: true, now: NOW });
    expect(settled).toEqual({ joined: true, held: 3, booked: true });
    const held = (await roster(ev.id)).filter((s) => s.status === "invited").map((s) => s.invitedName);
    expect(held).toEqual(["Cy", "Di", "Ed"]);
    // One "invited" line for each name held, written under the one lock.
    const lines = await db.select().from(activity).where(eq(activity.eventId, ev.id));
    expect(lines.filter((a) => a.verb === "invited")).toHaveLength(3);
    const [row] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(row.status).toBe("full");
  });

  it("never marks booked a match logged after it was played, and still makes it", async () => {
    const cy = await makePlayer(db, "Cy");
    const ev = await newMatch(cy, new Date(NOW.getTime() - DAY));
    const settled = await settleNewMatch(db, { event: ev, organiser: cy, names: ["Danny"], booked: true, now: NOW });
    expect(settled).toEqual({ joined: false, held: 0, booked: false });
    const [row] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(row.courtBookedAt).toBeNull();
  });

  it("a match that began an hour ago can still be marked: it is not over until its 90 minutes run out", async () => {
    const di = await makePlayer(db, "Di");
    const ev = await newMatch(di, new Date(NOW.getTime() - HOUR));
    expect((await settleNewMatch(db, { event: ev, organiser: di, booked: true, now: NOW })).booked).toBe(true);
  });

  it("an organiser who does not play still marks the court they booked", async () => {
    const ed = await makePlayer(db, "Ed");
    const ev = await newMatch(ed);
    expect(await settleNewMatch(db, { event: ev, organiser: ed, joinSelf: false, booked: true, now: NOW })).toEqual({ joined: false, held: 0, booked: true });
  });
});

// ------------------------------------------------------------------ more names than places (button audit, 9 November 2026, F4)

describe("\"Players you already have\" longer than the room", () => {
  it("the room is the match's places less the organiser's own, and the organiser's name in the list is not a place", () => {
    expect(roomForNames(4, true)).toBe(3);
    expect(roomForNames(4, false)).toBe(4);
    expect(namesToSeat(["Cath", " Bo ", "", "Cy", "Di"], "cath")).toEqual(["Bo", "Cy", "Di"]);
  });

  describe("the create form, called as the browser calls it", () => {
    let app: Db;
    beforeAll(async () => {
      app = await getDb();
    });
    let n = 0;
    const day = new Date(NOW.getTime() + 2 * DAY).toISOString().slice(0, 10);
    const create = async (who: { id: string }, names: string[]) =>
      (await asAction({ [PLAYER_COOKIE]: sealPlayerId(who.id) }, () => createEventAction({ type: "match", date: day, time: "18:00", tz: "Asia/Bangkok", whenFull: "waitlist", venueName: "Warehaus", names }).catch((e: unknown) => e))).result;
    const made = async (who: { id: string }) => app.select({ id: events.id }).from(events).where(eq(events.creatorPlayerId, who.id));

    it("four other names in a match of four: refused with the three that fit, and no match is made", async () => {
      const cath = await makePlayer(app, `Cath ${++n}`);
      expect(await create(cath, ["Bo", "Cy", "Di", "Ed"])).toEqual({ ok: false, error: "full", detail: "3" });
      expect(await made(cath)).toHaveLength(0);
    });

    it("three other names, or four with the organiser's own: the match is made and holds all three", async () => {
      const cath = await makePlayer(app, `Cath ${++n}`);
      const answer = (await create(cath, [cath.displayName, "Bo", "Cy", "Di"])) as { digest?: string };
      expect(String(answer.digest ?? "")).toMatch(/\/share/);
      const [ev] = await made(cath);
      expect(await app.select().from(slots).where(and(eq(slots.eventId, ev.id), eq(slots.kind, "reserved")))).toHaveLength(3);
    });
  });
});
