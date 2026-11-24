import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { activity, events, notices, players, slots, type Player } from "@/db/schema";
import { fixReplaceAction, fixRemoveAction } from "@/actions/lineupFix";
import { createEvent } from "@/lib/domain/events";
import { fixRefusal, fixRights, fixUntil, NO_FIX } from "@/lib/domain/fixWindow";
import { putOnPlace, removeFromPlace, replaceOnPlace, sideForOpenPlace, takeOpenPlace } from "@/lib/domain/lineupFix";
import { saveMatchScore } from "@/lib/domain/scores";
import { joinEvent, reserveNames } from "@/lib/domain/slots";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";

/**
 * The owner's decision of 24 November 2026: from the start of a match to seven days after its end, the
 * organiser and the match's players put names in open places, change who holds a place and remove
 * places; anybody signed in takes an open place or a player's place for themselves; the player who
 * loses a place hears who did it; every change is an activity line that names who did it; held places
 * play when the pairs name them; a scored match keeps its pairs and its levels true. Tournaments keep
 * today's rules.
 */
const NOW = new Date("2026-11-24T09:00:00Z");
freezeClock(NOW);
const TZ = "Asia/Bangkok";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const match = { type: "match" as const, status: "full" as const, startsAt: new Date(NOW.getTime() - 3 * HOUR), durationMinutes: 90 };
const end = new Date(match.startsAt.getTime() + 90 * 60_000);

describe("the window", () => {
  it("opens at the start of a match and closes seven days after its end; never for a tournament or a match called off", () => {
    expect(fixUntil(match).getTime()).toBe(end.getTime() + 7 * DAY);
    expect(fixRefusal(match, NOW)).toBeNull();
    expect(fixRefusal(match, new Date(match.startsAt.getTime() - 1))).toBe("not_started");
    expect(fixRefusal(match, match.startsAt)).toBeNull();
    expect(fixRefusal(match, new Date(end.getTime() + 7 * DAY))).toBeNull();
    expect(fixRefusal(match, new Date(end.getTime() + 7 * DAY + 1))).toBe("past");
    expect(fixRefusal({ ...match, type: "tournament" }, NOW)).toBe("not_a_match");
    expect(fixRefusal({ ...match, status: "cancelled" }, NOW)).toBe("cancelled");
    // The sweep's "past" is no refusal: the window is the clock's.
    expect(fixRefusal({ ...match, status: "past" }, NOW)).toBeNull();
  });

  it("lets the organiser and the players change the line-up, and anybody signed in without a seat take a place", () => {
    const who = (signedIn: boolean, organiser: boolean, seated: boolean) => fixRights(match, NOW, { signedIn, organiser, seated });
    expect(who(true, false, true)).toEqual({ edit: true, take: false, replace: false });
    expect(who(true, true, true)).toEqual({ edit: true, take: false, replace: false });
    expect(who(true, true, false)).toEqual({ edit: true, take: true, replace: true });
    // A manage link with nobody signed in edits, and takes nothing: there is nobody to seat.
    expect(who(false, true, false)).toEqual({ edit: true, take: false, replace: false });
    expect(who(true, false, false)).toEqual({ edit: false, take: true, replace: true });
    expect(who(false, false, false)).toEqual(NO_FIX);
    expect(fixRights({ ...match, type: "tournament" }, NOW, { signedIn: true, organiser: true, seated: true })).toEqual(NO_FIX);
  });

  it("gives a person who takes an open place the side that is one short, and no side when there are no pairs", () => {
    const seat = (team: "a" | "b" | null, status = "joined", position = 1) => ({ team, status: status as "joined", position });
    expect(sideForOpenPlace([seat("a"), seat("a"), seat("b"), seat(null, "empty")], 4)).toBe("b");
    expect(sideForOpenPlace([seat("b"), seat("a"), seat("b"), seat(null, "empty")], 4)).toBe("a");
    expect(sideForOpenPlace([seat(null), seat(null), seat(null, "empty")], 4)).toBeNull();
    expect(sideForOpenPlace([seat("a"), seat("b"), seat(null, "empty"), seat(null, "empty")], 4)).toBeNull();
  });
});

/** A match that started three hours ago and lasted 90 minutes: Ana organised and played, Bo joined, a place held for "Cy", one open. */
async function played(tag: string, o: { type?: "match" | "tournament"; startsAt?: Date } = {}) {
  const [ana, bo] = [await makePlayer(db, `Ana ${tag}`, { level: 3 }), await makePlayer(db, `Bo ${tag}`, { level: 3 })];
  const startsAt = o.startsAt ?? match.startsAt;
  const ev = await createEvent(db, { creatorPlayerId: ana.id, type: o.type ?? "match", startsAt, durationMinutes: o.type === "tournament" ? 120 : 90, tz: TZ, whenFull: "closed", capacity: 4 });
  const early = new Date(startsAt.getTime() - DAY);
  await joinEvent(db, { eventId: ev.id, playerId: ana.id, now: early });
  await joinEvent(db, { eventId: ev.id, playerId: bo.id, now: early });
  await reserveNames(db, { eventId: ev.id, actorPlayerId: ana.id, names: [`Cy ${tag}`], now: early });
  return { ana, bo, ev };
}
const seatsOf = (eventId: string) => db.select().from(slots).where(eq(slots.eventId, eventId)).orderBy(asc(slots.position));
const linesOf = (eventId: string) => db.select().from(activity).where(eq(activity.eventId, eventId)).orderBy(asc(activity.createdAt));
const nameOf = async (id: string | null) => (id ? ((await db.select().from(players).where(eq(players.id, id)))[0]?.displayName ?? null) : null);
const as = (p: Player | null, organiser = false) => ({ id: p?.id ?? null, organiser });

describe("changing the line-up of a played match", () => {
  it("lets a player put a name in the open place, on a new record, confirmed, with a line that names who did it", async () => {
    const { ana, bo, ev } = await played("put");
    const open = (await seatsOf(ev.id))[3];
    const done = await putOnPlace(db, { eventId: ev.id, slotId: open.id, actor: as(bo), name: "Di put" });
    expect(done.out).toBeNull();
    const seat = (await seatsOf(ev.id))[3];
    expect(seat).toMatchObject({ status: "confirmed", team: null });
    expect(await nameOf(seat.playerId)).toBe("Di put");
    const [line] = (await linesOf(ev.id)).filter((l) => l.actorPlayerId === bo.id && l.verb === "invited");
    expect(line).toMatchObject({ verb: "invited", actorPlayerId: bo.id, meta: { name: "Di put" } });
    // The organiser's own past player, picked: the place keeps that record and makes none.
    const known = await makePlayer(db, "Known put");
    const count = (await db.select({ id: players.id }).from(players)).length;
    await removeFromPlace(db, { eventId: ev.id, slotId: seat.id, actor: as(ana, true) });
    await putOnPlace(db, { eventId: ev.id, slotId: seat.id, actor: as(ana, true), name: "Known put", recordId: known.id });
    expect((await seatsOf(ev.id))[3].playerId).toBe(known.id);
    expect((await db.select({ id: players.id }).from(players)).length).toBe(count);
  });

  it("changes a held name to another person, and a player to another person, and tells the player who lost the place", async () => {
    const { ana, bo, ev } = await played("change");
    const [, boSeat, held] = await seatsOf(ev.id);
    const heldDone = await putOnPlace(db, { eventId: ev.id, slotId: held.id, actor: as(ana, true), name: "Cyrus change" });
    // A place held by name was nobody's: nobody to tell.
    expect(heldDone.out).toBeNull();
    const boDone = await putOnPlace(db, { eventId: ev.id, slotId: boSeat.id, actor: as(ana, true), name: "Jordi change" });
    expect(boDone.out).toEqual({ playerId: bo.id, how: "removed" });
    const seats = await seatsOf(ev.id);
    expect([await nameOf(seats[1].playerId), await nameOf(seats[2].playerId)]).toEqual(["Jordi change", "Cyrus change"]);
    expect(seats.slice(0, 3).map((s) => s.status)).toEqual(["joined", "confirmed", "confirmed"]);
    const lines = (await linesOf(ev.id)).filter((l) => l.verb === "removed");
    expect(lines.map((l) => [l.actorPlayerId, l.meta])).toEqual([
      [ana.id, { name: "Cy change", targetPlayerId: null, to: "Cyrus change" }],
      [ana.id, { name: `Bo change`, targetPlayerId: bo.id, to: "Jordi change" }],
    ]);
  });

  it("removes a player or a hold, leaves the place open, and tells a player taken out by somebody else", async () => {
    const { ana, bo, ev } = await played("remove");
    const [, boSeat, held] = await seatsOf(ev.id);
    expect((await removeFromPlace(db, { eventId: ev.id, slotId: held.id, actor: as(bo) })).out).toBeNull();
    expect((await removeFromPlace(db, { eventId: ev.id, slotId: boSeat.id, actor: as(ana, true) })).out).toEqual({ playerId: bo.id, how: "removed" });
    const seats = await seatsOf(ev.id);
    expect(seats.map((s) => s.status)).toEqual(["joined", "empty", "empty", "empty"]);
    expect((await db.select().from(events).where(eq(events.id, ev.id)))[0].status).toBe("open");
    // Ana taking herself out tells nobody.
    expect((await removeFromPlace(db, { eventId: ev.id, slotId: seats[0].id, actor: as(ana, true) })).out).toBeNull();
  });

  it("lets anybody signed in take the open place, and take a player's place ('I played instead')", async () => {
    const { bo, ev } = await played("take");
    const [dana, jordi] = [await makePlayer(db, "Dana take"), await makePlayer(db, "Jordi take")];
    await takeOpenPlace(db, { eventId: ev.id, actor: as(dana) });
    await expect(takeOpenPlace(db, { eventId: ev.id, actor: as(jordi) })).rejects.toMatchObject({ code: "full" });
    const boSeat = (await seatsOf(ev.id))[1];
    const done = await replaceOnPlace(db, { eventId: ev.id, slotId: boSeat.id, actor: as(jordi) });
    expect(done.out).toEqual({ playerId: bo.id, how: "replaced" });
    const seats = await seatsOf(ev.id);
    expect([seats[1].playerId, seats[3].playerId]).toEqual([jordi.id, dana.id]);
    expect([seats[1].status, seats[3].status]).toEqual(["confirmed", "confirmed"]);
    const lines = (await linesOf(ev.id)).filter((l) => l.actorPlayerId === dana.id || l.actorPlayerId === jordi.id);
    expect(lines.map((l) => [l.verb, l.actorPlayerId, l.meta])).toEqual([
      ["joined", dana.id, null],
      ["removed", jordi.id, { name: `Bo take`, targetPlayerId: bo.id, replace: 1 }],
    ]);
    // Seated now, Jordi changes the line-up as a player, and takes no second place.
    await expect(replaceOnPlace(db, { eventId: ev.id, slotId: seats[3].id, actor: as(jordi) })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a stranger's edit, a change before the start, after the seven days, and on a tournament", async () => {
    const { ev } = await played("refuse");
    const stranger = await makePlayer(db, "Stranger refuse");
    const open = (await seatsOf(ev.id))[3];
    await expect(putOnPlace(db, { eventId: ev.id, slotId: open.id, actor: as(stranger), name: "X" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(removeFromPlace(db, { eventId: ev.id, slotId: open.id, actor: as(null) })).rejects.toMatchObject({ code: "forbidden" });
    await expect(putOnPlace(db, { eventId: ev.id, slotId: open.id, actor: as(stranger, true), name: "X", now: new Date(end.getTime() + 8 * DAY) })).rejects.toMatchObject({ code: "past" });
    const soon = await played("soon", { startsAt: new Date(NOW.getTime() + DAY) });
    await expect(takeOpenPlace(db, { eventId: soon.ev.id, actor: as(stranger) })).rejects.toMatchObject({ code: "not_started" });
    const night = await played("night", { type: "tournament" });
    await expect(takeOpenPlace(db, { eventId: night.ev.id, actor: as(stranger) })).rejects.toMatchObject({ code: "invalid", message: "not_a_match" });
    expect((await seatsOf(ev.id))[3].status).toBe("empty");
  });
});

describe("the score's pairs and the levels", () => {
  it("seats every held place the pairs name: a held name on a new record, a held record on its own", async () => {
    const { ana, bo, ev } = await played("pairs");
    const di = await makePlayer(db, "Di pairs", { level: 3 });
    const early = new Date(ev.startsAt.getTime() - DAY);
    await reserveNames(db, { eventId: ev.id, actorPlayerId: ana.id, names: [{ name: "Di pairs", playerId: di.id }], now: early });
    const [anaSeat, , cySeat, diSeat] = await seatsOf(ev.id);
    expect([cySeat.status, diSeat.status, diSeat.playerId]).toEqual(["invited", "invited", di.id]);
    await saveMatchScore(db, { eventId: ev.id, playerId: ana.id, isCreator: true, sets: [{ setNumber: 1, sideA: 6, sideB: 3 }], teamASeats: [anaSeat.id, cySeat.id], now: NOW });
    const seats = await seatsOf(ev.id);
    expect(seats.map((s) => [s.status, s.team])).toEqual([["joined", "a"], ["joined", "b"], ["confirmed", "a"], ["confirmed", "b"]]);
    expect(await nameOf(seats[2].playerId)).toBe("Cy pairs");
    expect(seats[3].playerId).toBe(di.id);
    const played_ = (await linesOf(ev.id)).filter((l) => l.verb === "confirmed");
    expect(played_.map((l) => [l.actorPlayerId, l.meta])).toEqual([
      [ana.id, { name: "Cy pairs", played: 1 }],
      [ana.id, { name: "Di pairs", played: 1 }],
    ]);
    expect(bo.id).toBeTruthy();
  });

  it("leaves held places held after the seven days, and on a save with no pairs", async () => {
    const late = await played("late", { startsAt: new Date(NOW.getTime() - 9 * DAY) });
    const [a, , cy] = await seatsOf(late.ev.id);
    await saveMatchScore(db, { eventId: late.ev.id, playerId: late.ana.id, isCreator: true, sets: [{ setNumber: 1, sideA: 6, sideB: 3 }], teamASeats: [a.id, cy.id], now: NOW });
    expect((await seatsOf(late.ev.id))[2].status).toBe("invited");
    const plain = await played("plain");
    await saveMatchScore(db, { eventId: plain.ev.id, playerId: plain.ana.id, isCreator: true, sets: [{ setNumber: 1, sideA: 6, sideB: 3 }], now: NOW });
    expect((await seatsOf(plain.ev.id))[2].status).toBe("invited");
  });

  it("keeps the pairs and the levels true when a player is replaced after the organiser's score", async () => {
    const { ana, bo, ev } = await played("levels");
    const [di, jordi] = [await makePlayer(db, "Di levels", { level: 3 }), await makePlayer(db, "Jordi levels", { level: 3 })];
    const [anaSeat, , cySeat, open] = await seatsOf(ev.id);
    await putOnPlace(db, { eventId: ev.id, slotId: open.id, actor: as(ana, true), name: "Di levels", recordId: di.id });
    await saveMatchScore(db, { eventId: ev.id, playerId: ana.id, isCreator: true, sets: [{ setNumber: 1, sideA: 6, sideB: 1 }, { setNumber: 2, sideA: 6, sideB: 1 }], teamASeats: [anaSeat.id, cySeat.id], now: NOW });
    const { settleEventLevels } = await import("@/lib/domain/rating");
    await settleEventLevels(db, ev.id, NOW);
    const level = async (id: string) => (await db.select().from(players).where(eq(players.id, id)))[0].level;
    expect(await level(bo.id)).toBeLessThan(3);
    // Jordi played instead of Bo: Bo gets back what the match moved, and Jordi, on Bo's side, loses it.
    await replaceOnPlace(db, { eventId: ev.id, slotId: (await seatsOf(ev.id))[1].id, actor: as(jordi) });
    expect(await level(bo.id)).toBe(3);
    expect(await level(jordi.id)).toBeLessThan(3);
    const seats = await seatsOf(ev.id);
    expect(seats.map((s) => s.team)).toEqual(["a", "b", "a", "b"]);
    // Taken out, Di leaves a side one short: nobody's level moves until the place is filled again, on Di's side.
    await removeFromPlace(db, { eventId: ev.id, slotId: seats[3].id, actor: as(ana, true) });
    expect(await level(di.id)).toBe(3);
    expect(await level(jordi.id)).toBe(3);
    await putOnPlace(db, { eventId: ev.id, slotId: seats[3].id, actor: as(ana, true), name: "Dana levels" });
    const after = await seatsOf(ev.id);
    expect(after[3].team).toBe("b");
    expect(await level(jordi.id)).toBeLessThan(3);
  });
});

describe("the actions", () => {
  // An action reads the app's own database (`getDb`), so this part writes there.
  beforeAll(async () => {
    db = await getDb();
  });
  const jar = (p: Player) => ({ [PLAYER_COOKIE]: sealPlayerId(p.id) });

  it("tell the player who lost the place who took it, in the inbox, and nobody for a hold", async () => {
    const { ana, bo, ev } = await played("tell");
    const jordi = await makePlayer(db, "Jordi tell");
    const [, boSeat, held] = await seatsOf(ev.id);
    expect((await asAction(jar(jordi), () => fixReplaceAction(ev.code, boSeat.id))).result).toEqual({ ok: true, data: null });
    expect((await asAction(jar(ana), () => fixRemoveAction(ev.code, held.id))).result).toEqual({ ok: true, data: null });
    const told = await db.select().from(notices).where(and(eq(notices.eventId, ev.id)));
    expect(told.map((n) => [n.playerId, n.key, n.params?.name])).toEqual([[bo.id, "noticeItem.replacedBy", "Jordi tell"]]);
    // A stranger's edit is refused at the door.
    expect((await asAction(jar(bo), () => fixRemoveAction(ev.code, boSeat.id))).result).toMatchObject({ ok: false, error: "forbidden" });
  });
});
