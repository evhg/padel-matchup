import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { canEditMatchDetails, createEvent, updateEvent } from "@/lib/domain/events";
import { getEventByCode } from "@/lib/domain/queries";
import { joinEvent, leaveEvent } from "@/lib/domain/slots";
import en from "../messages/en.json";
import { createTestDb, makePlayer } from "./helpers/db";

/**
 * The owner, 9 October 2026: "any player should be able to change match details". The organiser
 * and every player with a seat may change the time, the length, the place and the note; a visitor,
 * a player who left and a player on the waitlist may not. The notice that goes out afterwards no
 * longer says "the organizer updated the match", because it may have been somebody else.
 */
// A fixed date (rule 11): a Saturday evening in Bangkok, long after any clock this suite runs on.
const SAT = new Date(Date.UTC(2030, 5, 1, 11, 0));
const TZ = "Asia/Bangkok";

describe("who may change a match's details", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  it("the organiser and every seated player; not a visitor, not a player who left, not the waitlist", async () => {
    const org = await makePlayer(db, "Org");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: SAT, tz: TZ, venueName: "Rawai Padel", whenFull: "waitlist" });
    const [bo, cy, di, ed, fa] = await Promise.all(["Bo", "Cy", "Di", "Ed", "Fa"].map((n) => makePlayer(db, n)));
    for (const p of [bo, cy, di, ed]) await joinEvent(db, { eventId: ev.id, playerId: p.id });
    await joinEvent(db, { eventId: ev.id, playerId: fa.id });
    await leaveEvent(db, { eventId: ev.id, playerId: di.id });
    const detail = (await getEventByCode(db, ev.code))!;
    const may = (id: string | null, isCreator = false) => canEditMatchDetails(detail, { isCreator, playerId: id });

    expect(may(org.id, true)).toBe(true);
    expect(may(bo.id)).toBe(true);
    expect(may(cy.id)).toBe(true);
    expect(may(di.id)).toBe(false);
    expect(may(null)).toBe(false);
    expect(may((await makePlayer(db, "Stranger")).id)).toBe(false);
    // Ed and Fa: one of them took Di's seat from the waitlist, the other did not get one.
    const seated = [ed, fa].filter((p) => detail.roster.some((s) => s.playerId === p.id && s.position <= ev.capacity));
    for (const p of [ed, fa]) expect(may(p.id)).toBe(seated.includes(p));
  });

  it("a seated player's change is saved, and the activity names who made it", async () => {
    const org = await makePlayer(db, "Org2");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: SAT, tz: TZ, venueName: "Rawai Padel", whenFull: "waitlist" });
    const bo = await makePlayer(db, "Bo2");
    await joinEvent(db, { eventId: ev.id, playerId: bo.id });
    const res = await updateEvent(db, ev.id, bo.id, { note: "Court 3, bring balls", startsAt: new Date(SAT.getTime() + 3600_000) });
    expect(res.event.note).toBe("Court 3, bring balls");
    expect(res.calendarChanged).toBe(true);
    const detail = (await getEventByCode(db, ev.code))!;
    expect(detail.activity.some((a) => a.verb === "updated" && a.actorPlayerId === bo.id)).toBe(true);
  });

  it("the change notice does not claim the organiser made it", () => {
    expect(en.email.updated.body).not.toMatch(/organi[sz]er/i);
  });
});
