import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { canEditMatchDetails, createEvent, mayMoveStart, updateEvent } from "@/lib/domain/events";
import { editErrorKey, startToSend } from "@/lib/editMatchForm";
import { utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";
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

  it("a seated player on a started match keeps its start, a note-only edit saves, and a refused move says why", async () => {
    // 18:00:30 in Bangkok, with seconds, as an API caller may set it; twenty minutes in.
    const start = new Date(Date.UTC(2030, 5, 1, 11, 0, 30));
    const live = new Date(start.getTime() + 20 * 60_000);
    const org = await makePlayer(db, "Org3");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: start, tz: TZ, venueName: "Rawai Padel", whenFull: "waitlist" });
    const bo = await makePlayer(db, "Bo3");
    await joinEvent(db, { eventId: ev.id, playerId: bo.id, now: new Date(start.getTime() - 3600_000) });
    // The page locks the day, the time and the zone for Bo, by the rule updateEvent holds.
    expect(mayMoveStart(ev, { playerId: bo.id, asOrganiser: false }, live)).toBe(false);
    expect(mayMoveStart(ev, { playerId: null, asOrganiser: true }, live)).toBe(true);
    // The form shows 18:00 and Bo changes only the note: what the action gets, and what it makes of it.
    const shown = { ...utcToZonedParts(ev.startsAt, TZ), tz: TZ };
    const sent = startToSend(shown, shown);
    const startsAt = sent.date && sent.time ? zonedTimeToUtc(sent.date, sent.time, sent.tz ?? TZ) : undefined;
    const saved = await updateEvent(db, ev.id, bo.id, { note: "Court 2", startsAt }, live);
    expect(saved.event.note).toBe("Court 2");
    expect(saved.event.startsAt.toISOString()).toBe(start.toISOString());
    expect(saved.calendarChanged).toBe(false);
    // A real change sends all three, and a change of zone alone carries the day and the time with it.
    expect(startToSend({ ...shown, time: "19:00" }, shown)).toEqual({ date: shown.date, time: "19:00", tz: TZ });
    expect(startToSend({ ...shown, tz: "Europe/Madrid" }, shown)).toEqual({ date: shown.date, time: shown.time, tz: "Europe/Madrid" });
    // A move Bo still sends is refused, and the form says why instead of "check what you entered".
    await expect(updateEvent(db, ev.id, bo.id, { startsAt: zonedTimeToUtc(shown.date, "19:00", TZ) }, live)).rejects.toMatchObject({ code: "forbidden", message: "startsAt" });
    expect(editErrorKey({ error: "forbidden", detail: "startsAt" })).toBe("event.startLocked");
    expect(editErrorKey({ error: "invalid", detail: "startsAt" })).toBe("errors.invalid");
    expect(editErrorKey({ error: "forbidden" })).toBe("errors.invalid");
    expect(en.event.startLocked).toBe("Only the organiser moves the start once the match has started.");
  });

  it("the change notice does not claim the organiser made it", () => {
    expect(en.email.updated.body).not.toMatch(/organi[sz]er/i);
  });
});
