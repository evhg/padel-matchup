import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, events, players, slots, type Event } from "@/db/schema";
import { pairStartAdvice } from "@/lib/domain/checkIn";
import { createEvent } from "@/lib/domain/events";
import { placeOf, placesOf, seatUnits } from "@/lib/domain/fixedPairs";
import { joinWithPolicy } from "@/lib/domain/joining";
import { pairTournamentDeltas } from "@/lib/domain/levels";
import { bePartner, joinPair, pairInOrder, pairSingles, splitPair } from "@/lib/domain/pairSeats";
import { getEventByCode } from "@/lib/domain/queries";
import { applyEventLevels } from "@/lib/domain/rating";
import { confirmInvite, declineInvite, joinEvent, leaveEvent, promotedOf, promoteWaitlists, seatNames } from "@/lib/domain/slots";
import { addWalkIn, generateRound, getTournamentState, pairsOfSeats, saveTournamentMatchScore, setTournamentLock, setTournamentSettings } from "@/lib/domain/tournament";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer, DAY } from "./helpers/db";

/**
 * A fixed-pairs night end to end on the database (the owner's decision F, 9 October 2026): pairs sign
 * up together, a single is "Partner needed" until somebody is their partner, a pair leaves as one or
 * one partner leaves and the other waits for a partner, the waiting list moves up by pairs, round 1
 * draws complete pairs only, the table ranks pairs, and the result moves each partner's level.
 *
 * NOW is fixed and the night is two days later, so joining and leaving are open.
 */
const NOW = new Date("2026-10-09T12:00:00Z");
freezeClock(NOW);

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

async function pairsNight(capacity = 8, extra: Partial<Parameters<typeof createEvent>[1]> = {}) {
  const org = await makePlayer(db, "Org", { level: 3 });
  const ev = await createEvent(db, { creatorPlayerId: org.id, type: "tournament", capacity, startsAt: new Date(NOW.getTime() + 2 * DAY), tz: "Asia/Bangkok", whenFull: "waitlist", fixedPairs: true, pointsPerMatch: 21, ...extra });
  return { org, ev };
}

async function seats(ev: Event) {
  const [fresh] = await db.select().from(events).where(eq(events.id, ev.id));
  const rows = await db.select().from(slots).where(eq(slots.eventId, ev.id)).orderBy(asc(slots.position));
  const names = new Map((await db.select({ id: players.id, n: players.displayName }).from(players)).map((p) => [p.id, p.n]));
  const nameOf = (s: (typeof rows)[number]) => (s.playerId ? names.get(s.playerId) : null) ?? s.invitedName ?? "?";
  const label = (list: typeof rows) => seatUnits(list).map((u) => (u.kind === "pair" ? u.seats.map(nameOf).join(" & ") : `${nameOf(u.seat)} · single`));
  return { ev: fresh, rows, listed: label(rows.filter((s) => s.position <= fresh.capacity)), waiting: label(rows.filter((s) => s.position > fresh.capacity)) };
}

describe("joining a fixed-pairs night", () => {
  it("joins with a partner's name: two seats, one key, and the partner claims the reserved spot by link", async () => {
    const { org, ev } = await pairsNight();
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    const ana = await makePlayer(db, "Ana");
    const res = await joinPair(db, { eventId: ev.id, playerId: ana.id, partnerName: "Bo" });
    expect(res.outcome).toBe("joined");
    expect(res.partner).toMatchObject({ status: "invited", invitedName: "Bo", kind: "reserved" });
    expect(res.partner!.inviteCode).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(res.partner!.pairId).toBe("slot" in res ? res.slot.pairId : null);
    expect((await seats(ev)).listed).toEqual(["Org · single", "Ana & Bo"]);

    // Bo opens the link and types his name: the seat is his, and the pair holds.
    const bo = await makePlayer(db, "Bo");
    expect((await confirmInvite(db, { inviteCode: res.partner!.inviteCode!, playerId: bo.id })).outcome).toBe("confirmed");
    expect((await seats(ev)).listed).toEqual(["Org · single", "Ana & Bo"]);
    // Nothing more for a pair already in.
    expect((await joinPair(db, { eventId: ev.id, playerId: ana.id, partnerName: "Cy" })).outcome).toBe("already_in");
  });

  it("joins alone as Partner needed, and somebody new is their partner in a free seat", async () => {
    const { ev } = await pairsNight();
    const cy = await makePlayer(db, "Cy");
    // Alone through the policy every door shares, which is a plain join on a fixed-pairs night.
    const detail = (await getEventByCode(db, ev.code))!;
    const alone = await joinWithPolicy(db, detail, cy, null);
    expect(alone.kind === "joined" && alone.result.outcome).toBe("joined");
    const di = await makePlayer(db, "Di");
    const cySeat = (await seats(ev)).rows.find((s) => s.playerId === cy.id)!;
    const paired = await bePartner(db, { eventId: ev.id, playerId: di.id, slotId: cySeat.id });
    expect(paired.joined).toBe(true);
    expect((await seats(ev)).listed).toEqual(["Cy & Di"]);
    // Taken: nobody else can be Cy's partner now, and Di cannot pair twice.
    const eve = await makePlayer(db, "Eve");
    await expect(bePartner(db, { eventId: ev.id, playerId: eve.id, slotId: cySeat.id })).rejects.toMatchObject({ code: "invalid", message: "taken" });
    await joinEvent(db, { eventId: ev.id, playerId: eve.id });
    const eveSeat = (await seats(ev)).rows.find((s) => s.playerId === eve.id)!;
    await expect(bePartner(db, { eventId: ev.id, playerId: di.id, slotId: eveSeat.id })).rejects.toMatchObject({ code: "invalid", message: "already_paired" });
  });

  it("a reserved name is nobody's to be partner of: Be their partner refuses it, so its link stays with whoever gave it", async () => {
    const { ev } = await pairsNight();
    const ana = await makePlayer(db, "Ana");
    const res = await joinPair(db, { eventId: ev.id, playerId: ana.id, partnerName: "Bo" });
    // A player paired with a name leaves Bo a single only if somebody else gave it; here the organiser reserves Cal.
    const { reserveSlot } = await import("@/lib/domain/slots");
    const { slot: cal } = await reserveSlot(db, { eventId: ev.id, actorPlayerId: null, name: "Cal" });
    const eve = await makePlayer(db, "Eve");
    await expect(bePartner(db, { eventId: ev.id, playerId: eve.id, slotId: cal.id })).rejects.toMatchObject({ code: "invalid", message: "taken" });
    await expect(bePartner(db, { eventId: ev.id, playerId: eve.id, slotId: res.partner!.id })).rejects.toMatchObject({ code: "invalid", message: "taken" });
  });

  it("from round 1 the pairs are the field: no Be their partner, no partner named later", async () => {
    const { org, ev } = await pairsNight(8);
    const [ann, ben, cat, dan] = await Promise.all(["Ann", "Ben", "Cat", "Dan"].map((n) => makePlayer(db, n)));
    await joinPair(db, { eventId: ev.id, playerId: ann.id, partnerName: "Amy" });
    await joinPair(db, { eventId: ev.id, playerId: ben.id, partnerName: "Bea" });
    await generateRound(db, { eventId: ev.id, actorPlayerId: org.id });
    // The organiser takes Bea's place out mid-night: Ben is a single now, with a free seat beside him.
    const { removeFromSlot } = await import("@/lib/domain/slots");
    await removeFromSlot(db, { eventId: ev.id, slotId: (await seats(ev)).rows.find((s) => s.invitedName === "Bea")!.id, actorPlayerId: org.id });
    const benSeat = (await seats(ev)).rows.find((s) => s.playerId === ben.id)!;
    await expect(bePartner(db, { eventId: ev.id, playerId: cat.id, slotId: benSeat.id })).rejects.toMatchObject({ message: "pairs_locked" });
    await expect(joinPair(db, { eventId: ev.id, playerId: ben.id, partnerName: "Dan" })).rejects.toMatchObject({ message: "pairs_locked" });
    void dan;
  });

  it("a single already in names a partner later, and two singles pair where they sit", async () => {
    const { org, ev } = await pairsNight();
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    const res = await joinPair(db, { eventId: ev.id, playerId: org.id, partnerName: "Pat" });
    expect(res.outcome).toBe("already_in");
    expect(res.partner?.invitedName).toBe("Pat");
    const fay = await makePlayer(db, "Fay");
    const gus = await makePlayer(db, "Gus");
    await joinEvent(db, { eventId: ev.id, playerId: fay.id });
    await joinEvent(db, { eventId: ev.id, playerId: gus.id });
    const gusSeat = (await seats(ev)).rows.find((s) => s.playerId === gus.id)!;
    const before = (await seats(ev)).rows.filter((s) => s.status === "empty").length;
    const r = await bePartner(db, { eventId: ev.id, playerId: fay.id, slotId: gusSeat.id });
    expect(r.joined).toBe(false);
    // No seat taken: they paired where they sat.
    expect((await seats(ev)).rows.filter((s) => s.status === "empty").length).toBe(before);
    expect((await seats(ev)).listed).toEqual(["Org & Pat", "Fay & Gus"]);
  });

  it("a declined partner leaves a single behind, and is the pair again if they change their mind before anybody else", async () => {
    const { ev } = await pairsNight();
    const ana = await makePlayer(db, "Ana");
    const res = await joinPair(db, { eventId: ev.id, playerId: ana.id, partnerName: "Bo" });
    expect((await declineInvite(db, { inviteCode: res.partner!.inviteCode! })).outcome).toBe("declined");
    expect((await seats(ev)).listed).toEqual(["Ana · single"]);
    // A declined spot is not a name, so Ana reads single; its key stays, so Bo's same link puts the pair back.
    const bo = await makePlayer(db, "Bo");
    expect((await confirmInvite(db, { inviteCode: res.partner!.inviteCode!, playerId: bo.id })).outcome).toBe("confirmed");
    expect((await seats(ev)).listed).toEqual(["Ana & Bo"]);
  });
});

describe("leaving and the waiting list", () => {
  it("one partner leaves and the other needs a partner; a pair leaves together; the waiting list moves up by pairs", async () => {
    // Four seats: Ana & Bo, Cy & Di. Waiting: Hal & Ivy (a pair), then Jo alone.
    const { ev } = await pairsNight(4);
    const [ana, cy, di, hal, jo] = await Promise.all(["Ana", "Cy", "Di", "Hal", "Jo"].map((n) => makePlayer(db, n)));
    const ab = await joinPair(db, { eventId: ev.id, playerId: ana.id, partnerName: "Bo" });
    await joinPair(db, { eventId: ev.id, playerId: cy.id, partnerName: "Di" });
    // Di claims Cy's reserved spot signed in.
    const diInvite = (await seats(ev)).rows.find((s) => s.invitedName === "Di")!;
    await confirmInvite(db, { inviteCode: diInvite.inviteCode!, playerId: di.id });
    expect((await joinPair(db, { eventId: ev.id, playerId: hal.id, partnerName: "Ivy" })).outcome).toBe("waitlisted");
    expect((await joinEvent(db, { eventId: ev.id, playerId: jo.id })).outcome).toBe("waitlisted");
    expect(await seats(ev)).toMatchObject({ listed: ["Ana & Bo", "Cy & Di"], waiting: ["Hal & Ivy", "Jo · single"] });

    // Di leaves alone: Cy needs a partner. One seat is free; the pair at the head needs two, so Jo moves up past it.
    const left = await leaveEvent(db, { eventId: ev.id, playerId: di.id });
    expect(left.promotion?.playerId).toBe(jo.id);
    expect(await seats(ev)).toMatchObject({ listed: ["Ana & Bo", "Cy · single", "Jo · single"], waiting: ["Hal & Ivy"] });

    // Ana leaves while Bo is still only the name she gave: his spot goes with her, two seats free, and the waiting pair moves up together.
    const out = await leaveEvent(db, { eventId: ev.id, playerId: ana.id });
    expect(out.promotion?.playerId).toBe(hal.id);
    // Ivy is a reserved name, so nobody is told for her (nothing is sent to a placeholder), and her link moves with her.
    expect(out.promotion?.also ?? []).toEqual([]);
    const after = await seats(ev);
    // Hal & Ivy sit where Ana & Bo sat.
    expect(after).toMatchObject({ listed: ["Hal & Ivy", "Cy · single", "Jo · single"], waiting: [] });
    expect(after.rows.find((s) => s.invitedName === "Ivy")?.inviteCode).toBeTruthy();
    expect(ab.partner?.inviteCode).toBeTruthy();
    expect(after.rows.some((s) => s.inviteCode === ab.partner!.inviteCode)).toBe(false);
  });

  it("a seat a partner left is a stranger's when it is taken again, never the old partner's", async () => {
    const { ev } = await pairsNight(4);
    const [ana, bo, eve] = await Promise.all(["Ana", "Bo", "Eve"].map((n) => makePlayer(db, n)));
    await joinEvent(db, { eventId: ev.id, playerId: ana.id });
    await bePartner(db, { eventId: ev.id, playerId: bo.id, slotId: (await seats(ev)).rows.find((s) => s.playerId === ana.id)!.id });
    const boSeat = (await seats(ev)).rows.find((s) => s.playerId === bo.id)!;
    await leaveEvent(db, { eventId: ev.id, playerId: bo.id });
    // Eve joins alone and takes the first free seat, the one Bo left: she is a single, and so is Ana.
    const res = await joinEvent(db, { eventId: ev.id, playerId: eve.id });
    expect(res.outcome === "joined" && res.slot.id).toBe(boSeat.id);
    expect((await seats(ev)).listed).toEqual(["Ana · single", "Eve · single"]);
  });

  it("a waiting pair with a reserved partner is ticked in as a pair on the night", async () => {
    const { org, ev } = await pairsNight(4);
    const [a, b, c] = await Promise.all(["A1", "B1", "C1"].map((n) => makePlayer(db, n)));
    await joinPair(db, { eventId: ev.id, playerId: a.id, partnerName: "A2" });
    await joinPair(db, { eventId: ev.id, playerId: b.id, partnerName: "B2" });
    await joinPair(db, { eventId: ev.id, playerId: c.id, partnerName: "C2" });
    const all = (await seats(ev)).rows;
    const listed = all.filter((s) => s.position <= 4).map((s) => s.id);
    const waiting = all.filter((s) => s.position > 4).map((s) => s.id);
    expect(waiting).toHaveLength(2);
    const r1 = await generateRound(db, { eventId: ev.id, actorPlayerId: org.id, checkIn: { away: [], waitingIn: waiting, count: listed.length + 2 } });
    expect(r1.resting).toHaveLength(2);
    expect((await seats(ev)).listed).toEqual(["A1 & A2", "B1 & B2", "C1 & C2"]);
  });

  it("the hourly sweep fills by the same rule: a waiting pair waits for two free seats", async () => {
    const { ev } = await pairsNight(4);
    const [a, b, c, d] = await Promise.all(["A1", "B1", "C1", "D1"].map((n) => makePlayer(db, n)));
    await joinPair(db, { eventId: ev.id, playerId: a.id, partnerName: "A2" });
    await joinPair(db, { eventId: ev.id, playerId: b.id, partnerName: "B2" });
    await joinPair(db, { eventId: ev.id, playerId: c.id, partnerName: "C2" });
    await joinEvent(db, { eventId: ev.id, playerId: d.id });
    // A1's partner declines: one free seat, the pair at the head waits, D1 alone moves up.
    await declineInvite(db, { inviteCode: (await seats(ev)).rows.find((s) => s.invitedName === "A2")!.inviteCode! });
    // D1 takes the seat A2 left, beside A1.
    expect(await seats(ev)).toMatchObject({ listed: ["A1 · single", "D1 · single", "B1 & B2"], waiting: ["C1 & C2"] });
    expect(await promoteWaitlists(db, NOW)).toEqual([]);
    expect((await seats(ev)).waiting).toEqual(["C1 & C2"]);
  });
});

describe("the waiting list, the invitation and the capacity, by pairs", () => {
  it("after round 1 a freed seat takes a waiting pair, never a single who could not be drawn", async () => {
    const { org, ev } = await pairsNight(4);
    const [ann, ben, wes, ida] = await Promise.all(["Ann", "Ben", "Wes", "Ida"].map((n) => makePlayer(db, n)));
    await joinPair(db, { eventId: ev.id, playerId: ann.id, partnerName: "Amy" });
    await joinPair(db, { eventId: ev.id, playerId: ben.id, partnerName: "Bea" });
    await joinEvent(db, { eventId: ev.id, playerId: wes.id });
    await generateRound(db, { eventId: ev.id, actorPlayerId: org.id });
    const { removeFromSlot } = await import("@/lib/domain/slots");
    // Bea goes mid-night: one seat frees, and Wes, alone, waits on.
    const r = await removeFromSlot(db, { eventId: ev.id, slotId: (await seats(ev)).rows.find((s) => s.invitedName === "Bea")!.id, actorPlayerId: org.id });
    expect(r.promotion).toBeNull();
    expect((await seats(ev)).waiting).toEqual(["Wes · single"]);
    // A pair that waits moves up when two seats are free.
    await joinPair(db, { eventId: ev.id, playerId: ida.id, partnerName: "Ivo" });
    await removeFromSlot(db, { eventId: ev.id, slotId: (await seats(ev)).rows.find((s) => s.playerId === ben.id)!.id, actorPlayerId: org.id });
    expect((await seats(ev)).listed).toContain("Ida & Ivo");
  });

  it("a declined spot is handed to a partner who waits as a claimed name, and the sweep finds such a night", async () => {
    const { org, ev } = await pairsNight(4);
    const [a, b, c, ben, bo] = await Promise.all(["A3", "B3", "C3", "Ben", "Bo"].map((n) => makePlayer(db, n)));
    for (const p of [a, b, c]) await joinEvent(db, { eventId: ev.id, playerId: p.id });
    const { reserveSlot } = await import("@/lib/domain/slots");
    const { slot: rex } = await reserveSlot(db, { eventId: ev.id, actorPlayerId: org.id, name: "Rex" });
    const res = await joinPair(db, { eventId: ev.id, playerId: ben.id, partnerName: "Bo" });
    await confirmInvite(db, { inviteCode: res.partner!.inviteCode!, playerId: bo.id });
    // Ben leaves; Bo is a player and stays, waiting alone.
    await leaveEvent(db, { eventId: ev.id, playerId: ben.id });
    expect((await seats(ev)).waiting).toEqual(["Bo · single"]);
    const declined = await declineInvite(db, { inviteCode: rex.inviteCode! });
    expect(declined.outcome === "declined" && declined.promotion?.playerId).toBe(bo.id);
    expect((await seats(ev)).waiting).toEqual([]);
    // The hourly sweep reads the same waiting list: a hole on the list with a claimed partner waiting is filled.
    const cy = await makePlayer(db, "Cy");
    const more = await joinPair(db, { eventId: ev.id, playerId: cy.id, partnerName: "Cyn" });
    await confirmInvite(db, { inviteCode: more.partner!.inviteCode!, playerId: (await makePlayer(db, "Cyn")).id });
    await leaveEvent(db, { eventId: ev.id, playerId: cy.id });
    await db.update(slots).set({ status: "empty", playerId: null }).where(eq(slots.id, (await seats(ev)).rows.find((s) => s.playerId === a.id)!.id));
    const swept = await promoteWaitlists(db, NOW);
    expect(swept.map((p) => p.slot.eventId)).toContain(ev.id);
    expect((await seats(ev)).waiting).toEqual([]);
  });

  it("the partner somebody named was in already: opening the link pairs them where they sit", async () => {
    const { ev } = await pairsNight(8);
    const [ana, bo] = await Promise.all(["Ana", "Bo"].map((n) => makePlayer(db, n)));
    await joinEvent(db, { eventId: ev.id, playerId: ana.id });
    await joinEvent(db, { eventId: ev.id, playerId: bo.id });
    const res = await joinPair(db, { eventId: ev.id, playerId: ana.id, partnerName: "Bo" });
    expect((await confirmInvite(db, { inviteCode: res.partner!.inviteCode!, playerId: bo.id })).outcome).toBe("already_in");
    const after = await seats(ev);
    expect(after.listed).toEqual(["Ana & Bo"]);
    expect(after.rows.filter((s) => s.status !== "empty")).toHaveLength(2);
  });

  it("a waiting reserved spot taken by somebody already in is deleted, not left empty on the waiting list", async () => {
    const { ev } = await pairsNight(4);
    const people = await Promise.all(["A4", "B4", "C4", "Ana", "Ben"].map((n) => makePlayer(db, n)));
    for (const p of people.slice(0, 4)) await joinEvent(db, { eventId: ev.id, playerId: p.id });
    const res = await joinPair(db, { eventId: ev.id, playerId: people[4].id, partnerName: "Ana" });
    expect(res.outcome).toBe("waitlisted");
    await confirmInvite(db, { inviteCode: res.partner!.inviteCode!, playerId: people[3].id });
    const detail = (await getEventByCode(db, ev.code))!;
    expect(detail.waitlist.map((s) => s.status)).toEqual(["joined"]);
  });

  it("a night that grows moves the waiting list up by pairs, and never splits a pair across the line", async () => {
    const { org, ev } = await pairsNight(4);
    const people = await Promise.all(["A6", "B6", "C6", "D6", "E6", "F6", "H6"].map((n) => makePlayer(db, n)));
    for (const p of people.slice(0, 5)) await joinEvent(db, { eventId: ev.id, playerId: p.id });
    await joinPair(db, { eventId: ev.id, playerId: people[5].id, partnerName: "Fo" });
    await joinPair(db, { eventId: ev.id, playerId: people[6].id, partnerName: "Ho" });
    const { updateEvent } = await import("@/lib/domain/events");
    const res = await updateEvent(db, ev.id, org.id, { capacity: 8 });
    expect(res.promotedPlayerIds).toEqual([people[4].id, people[5].id]);
    const after = await seats(ev);
    expect(after.listed.slice(-2)).toEqual(["E6 · single", "F6 & Fo"]);
    expect(after.waiting).toEqual(["H6 & Ho"]);
  });

  it("fixed pairs cannot be switched off while a partner waits as a name or a claimed spot", async () => {
    const { org, ev } = await pairsNight(4);
    const people = await Promise.all(["A7", "B7", "C7", "D7", "F7"].map((n) => makePlayer(db, n)));
    for (const p of people.slice(0, 4)) await joinEvent(db, { eventId: ev.id, playerId: p.id });
    await joinPair(db, { eventId: ev.id, playerId: people[4].id, partnerName: "Fo7" });
    await expect(setTournamentSettings(db, { eventId: ev.id, actorPlayerId: org.id, fixedPairs: false })).rejects.toMatchObject({ message: "pairs_waiting" });
  });

  it("a player in alone who names a partner with no free seat is told they are still in, alone", async () => {
    const { ev } = await pairsNight(4);
    const people = await Promise.all(["A8", "B8", "C8", "D8"].map((n) => makePlayer(db, n)));
    for (const p of people) await joinEvent(db, { eventId: ev.id, playerId: p.id });
    const res = await joinPair(db, { eventId: ev.id, playerId: people[0].id, partnerName: "Zed" });
    expect(res).toMatchObject({ outcome: "already_in", partner: null, noSeatForPartner: true });
    const { joinMatch, NO_SIDE_EFFECTS } = await import("@/lib/api/operations");
    const { getOrCreatePersonalToken } = await import("@/lib/domain/identity");
    const answer = await joinMatch(db, { code: ev.code, token: await getOrCreatePersonalToken(db, people[1].id), partner: "Yan" }, NO_SIDE_EFFECTS);
    expect(answer.outcome).toBe("already_in");
    expect(answer.next).toContain("still in, alone");
  });

  it("the invitation names the player who named them, not the organiser", async () => {
    const { ev } = await pairsNight(8);
    const ana = await makePlayer(db, "Ana");
    const res = await joinPair(db, { eventId: ev.id, playerId: ana.id, partnerName: "Bo" });
    const { namedByOf } = await import("@/lib/domain/pairSeats");
    expect(await namedByOf(db, res.partner!)).toBe("Ana");
    const { reserveSlot } = await import("@/lib/domain/slots");
    const { slot } = await reserveSlot(db, { eventId: ev.id, actorPlayerId: null, name: "Cal" });
    expect(await namedByOf(db, slot)).toBeNull();
  });
});

describe("the organiser's tools and round 1", () => {
  it("pairs two singles, splits a pair, adds a walk-in pair by two seats, and keeps the field even", async () => {
    const { org, ev } = await pairsNight(4);
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    const kim = await makePlayer(db, "Kim");
    await joinEvent(db, { eventId: ev.id, playerId: kim.id });
    const rows = (await seats(ev)).rows;
    const [o, k] = [rows.find((s) => s.playerId === org.id)!, rows.find((s) => s.playerId === kim.id)!];
    await pairSingles(db, { eventId: ev.id, slotIds: [o.id, k.id], actorPlayerId: org.id });
    expect((await seats(ev)).listed).toEqual(["Org & Kim"]);
    await expect(pairSingles(db, { eventId: ev.id, slotIds: [o.id, k.id], actorPlayerId: org.id })).rejects.toMatchObject({ message: "taken" });
    await splitPair(db, { eventId: ev.id, slotId: k.id, actorPlayerId: org.id });
    expect((await seats(ev)).listed).toEqual(["Org · single", "Kim · single"]);
    await pairSingles(db, { eventId: ev.id, slotIds: [k.id, o.id], actorPlayerId: org.id });
    // The two free seats take a pair that walked in; a second pair grows the night by two, never one.
    await addWalkIn(db, { eventId: ev.id, actorPlayerId: org.id, name: "Lu", partnerName: "Max" });
    const grown = await addWalkIn(db, { eventId: ev.id, actorPlayerId: org.id, name: "Ned", partnerName: "Ola" });
    expect(grown.grew).toBe(true);
    const after = await seats(ev);
    expect(after.ev.capacity).toBe(6);
    expect(after.listed).toEqual(["Org & Kim", "Lu & Max", "Ned & Ola"]);
    // A walk-in alone on a full night grows it by two: one seat beside them stays for their partner.
    const alone = await addWalkIn(db, { eventId: ev.id, actorPlayerId: org.id, name: "Pia" });
    expect(alone.grew).toBe(true);
    expect((await seats(ev)).ev.capacity).toBe(8);
  });

  it("round 1 refuses a ticked single and one pair, draws three pairs on one court with one pair resting, and locks the pairs", async () => {
    const { org, ev } = await pairsNight(8);
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    const people = await Promise.all(["Ann", "Ben", "Cat", "Dan", "Eli"].map((n) => makePlayer(db, n)));
    await joinPair(db, { eventId: ev.id, playerId: org.id, partnerName: "Zed" });
    await joinPair(db, { eventId: ev.id, playerId: people[0].id, partnerName: "Amy" });
    await joinEvent(db, { eventId: ev.id, playerId: people[1].id });
    await joinEvent(db, { eventId: ev.id, playerId: people[2].id });
    // Ben and Cat alone: Start is held while either is ticked.
    await expect(generateRound(db, { eventId: ev.id, actorPlayerId: org.id })).rejects.toMatchObject({ code: "invalid", message: "partner_needed" });
    const listed = (await seats(ev)).rows.filter((s) => s.status !== "empty");
    const ben = listed.find((s) => s.playerId === people[1].id)!;
    const cat = listed.find((s) => s.playerId === people[2].id)!;
    // The check-in's rule, pure: Ben and Cat ticked hold Start; unticked, two pairs start.
    const names = listed.map((s) => ({ id: s.id, pairId: s.pairId }));
    expect(pairStartAdvice(names, names.map((n) => n.id))).toEqual({ kind: "partner_needed", count: 2, singles: 2 });
    expect(pairStartAdvice(names, names.filter((n) => n.id !== ben.id && n.id !== cat.id).map((n) => n.id))).toEqual({ kind: "ready", count: 2 });
    // One pair alone cannot start; an absent partner leaves the other one single, and nothing is written.
    const zed = listed.find((s) => s.invitedName === "Zed")!;
    const amyPair = listed.filter((s) => s.playerId === people[0].id || s.invitedName === "Amy").map((s) => s.id);
    await expect(generateRound(db, { eventId: ev.id, actorPlayerId: org.id, checkIn: { away: [ben.id, cat.id, ...amyPair], waitingIn: [], count: 2 } })).rejects.toMatchObject({ message: "need_2_pairs" });
    await expect(generateRound(db, { eventId: ev.id, actorPlayerId: org.id, checkIn: { away: [ben.id, cat.id, zed.id], waitingIn: [], count: 3 } })).rejects.toMatchObject({ message: "partner_needed" });
    expect((await seats(ev)).listed).toEqual(["Org & Zed", "Ann & Amy", "Ben · single", "Cat · single"]);

    // Ben and Cat pair up: three pairs. One court, one pair resting.
    await pairSingles(db, { eventId: ev.id, slotIds: [ben.id, cat.id], actorPlayerId: org.id });
    await setTournamentSettings(db, { eventId: ev.id, actorPlayerId: org.id, fixedPairs: true });
    const r1 = await generateRound(db, { eventId: ev.id, actorPlayerId: org.id });
    expect(r1.matches).toHaveLength(1);
    expect(r1.resting).toHaveLength(2);
    const after = await seats(ev);
    expect(after.ev.capacity).toBe(6);
    // Partners side by side on the field, the reserved names held by placeholders that fold into whoever claims them.
    expect(after.listed).toEqual(["Org & Zed", "Ann & Amy", "Ben & Cat"]);
    expect(after.rows.every((s) => s.playerId)).toBe(true);
    // From round 1 the pairs are the field.
    await expect(splitPair(db, { eventId: ev.id, slotId: ben.id, actorPlayerId: org.id })).rejects.toMatchObject({ message: "pairs_locked" });
    await expect(setTournamentSettings(db, { eventId: ev.id, actorPlayerId: org.id, fixedPairs: false })).rejects.toMatchObject({ message: "pairs_locked" });
  });

  it("names typed on the create form pair in order, the organiser with the first", async () => {
    const { org, ev } = await pairsNight(8);
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    await seatNames(db, { eventId: ev.id, actorPlayerId: org.id, names: ["Ria", "Sol", "Tom", "Uma", "Val"] });
    expect(await pairInOrder(db, { eventId: ev.id })).toBe(3);
    expect((await seats(ev)).listed).toEqual(["Org & Ria", "Sol & Tom", "Uma & Val"]);
  });
});

describe("a night played", () => {
  it("rests one pair a round in turn, ranks the pairs, and moves each partner's level by the pair's result", async () => {
    const { org, ev } = await pairsNight(8);
    const [p1, p2, p3, p4, p5] = await Promise.all([
      makePlayer(db, "Top1", { level: 3 }),
      makePlayer(db, "Mid1", { level: 3 }),
      makePlayer(db, "Mid2", { level: 3 }),
      makePlayer(db, "Low1", { level: 3 }),
      makePlayer(db, "Low2", { level: 3 }),
    ]);
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    await bePartner(db, { eventId: ev.id, playerId: p1.id, slotId: (await seats(ev)).rows.find((s) => s.playerId === org.id)!.id });
    await joinEvent(db, { eventId: ev.id, playerId: p2.id });
    await bePartner(db, { eventId: ev.id, playerId: p3.id, slotId: (await seats(ev)).rows.find((s) => s.playerId === p2.id)!.id });
    await joinEvent(db, { eventId: ev.id, playerId: p4.id });
    await bePartner(db, { eventId: ev.id, playerId: p5.id, slotId: (await seats(ev)).rows.find((s) => s.playerId === p4.id)!.id });
    const top = [org.id, p1.id].sort().join("|");
    const low = [p4.id, p5.id].sort().join("|");

    // Three rounds: the round robin of three pairs, each pair resting once. The top pair wins both its
    // matches, the low pair loses both, the middle pair splits.
    const rested = new Map<string, number>();
    for (let n = 1; n <= 3; n++) {
      const r = await generateRound(db, { eventId: ev.id, actorPlayerId: org.id });
      const restKey = [...r.resting].sort().join("|");
      rested.set(restKey, (rested.get(restKey) ?? 0) + 1);
      const m = r.matches[0];
      const a = [m.a1, m.a2].sort().join("|");
      const b = [m.b1, m.b2].sort().join("|");
      const aScore = a === top || b === low ? 21 : 10;
      await saveTournamentMatchScore(db, { eventId: ev.id, matchId: m.id, sideA: aScore, sideB: aScore === 21 ? 10 : 21, playerId: org.id, isCreator: true });
    }
    expect([...rested.values()]).toEqual([1, 1, 1]);

    const [fresh] = await db.select().from(events).where(eq(events.id, ev.id));
    const named = await db.select().from(slots).where(eq(slots.eventId, ev.id));
    const state = await getTournamentState(db, fresh, named.map((s) => s.playerId!), pairsOfSeats(named));
    expect(state.pairStandings!.map((r) => r.key)).toEqual([top, [p2.id, p3.id].sort().join("|"), low]);
    expect(state.pairStandings!.map((r) => [r.played, r.wins])).toEqual([[2, 2], [2, 1], [2, 0]]);
    expect(state.rotationLength).toBe(3);
    // Both partners carry their pair's rank, for the snapshot, the card and the API.
    expect(state.standings.filter((r) => r.rank === 1).map((r) => r.playerId).sort()).toEqual([org.id, p1.id].sort());

    await setTournamentLock(db, { eventId: ev.id, locked: true, actorPlayerId: org.id });
    const { applied, changes } = await applyEventLevels(db, ev.id);
    expect(applied).toBe(true);
    const delta = new Map(changes.map((c) => [c.playerId, Math.round((c.to - c.from) * 100) / 100]));
    // The winning pair moves up together, the last pair down together, by the same step each.
    expect(delta.get(org.id)).toBeGreaterThan(0);
    expect(delta.get(org.id)).toBe(delta.get(p1.id));
    expect(delta.get(p4.id)).toBeLessThan(0);
    expect(delta.get(p4.id)).toBe(delta.get(p5.id));
    // The same numbers the pure rule gives: a pair of 3.0s, first of three among 3.0s, gains 0.06.
    expect(delta.get(org.id)).toBe(0.06);
    const log = await db.select({ log: players.levelLog }).from(players).where(eq(players.id, p1.id));
    expect(log[0].log?.at(-1)).toMatchObject({ code: ev.code, type: "tournament" });

    // The snapshot holds partners side by side: both winners are first, of three places, on My matches,
    // and the chat's result names the podium as pairs.
    const [done] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(placesOf(done)).toHaveLength(3);
    expect([placeOf(done, org.id), placeOf(done, p1.id), placeOf(done, p3.id), placeOf(done, p5.id)]).toEqual([1, 1, 2, 3]);
    const { getPlayerEvents } = await import("@/lib/domain/queries");
    expect((await getPlayerEvents(db, p1.id, new Date(NOW.getTime() + 10 * DAY))).past.find((m) => m.event.id === ev.id)?.placement).toBe(1);
    const { resultSummary } = await import("@/lib/channels/cards");
    const podium = resultSummary((await getEventByCode(db, ev.code))!, "en", "https://kicksma.sh")?.podium ?? "";
    expect(podium).toMatch(/1\. (Org & Top1|Top1 & Org) {2}2\. (Mid1 & Mid2|Mid2 & Mid1) {2}3\. (Low1 & Low2|Low2 & Low1)/);
  });

  it("the club and city ranking gives both partners of a pair the pair's place", async () => {
    const { org, ev } = await pairsNight(8, { venueName: "Pair Club" });
    const people = await Promise.all(["Ra", "Sa", "Ta", "Ua", "Va"].map((n) => makePlayer(db, n, { rankingOptIn: true })));
    await db.update(players).set({ rankingOptIn: true }).where(eq(players.id, org.id));
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    const seatOf = async (id: string) => (await seats(ev)).rows.find((s) => s.playerId === id)!.id;
    await bePartner(db, { eventId: ev.id, playerId: people[0].id, slotId: await seatOf(org.id) });
    await joinEvent(db, { eventId: ev.id, playerId: people[1].id });
    await bePartner(db, { eventId: ev.id, playerId: people[2].id, slotId: await seatOf(people[1].id) });
    await joinEvent(db, { eventId: ev.id, playerId: people[3].id });
    await bePartner(db, { eventId: ev.id, playerId: people[4].id, slotId: await seatOf(people[3].id) });
    const top = [org.id, people[0].id].sort().join("|");
    for (let n = 1; n <= 3; n++) {
      const r = await generateRound(db, { eventId: ev.id, actorPlayerId: org.id });
      const m = r.matches[0];
      const a = [m.a1, m.a2].sort().join("|");
      await saveTournamentMatchScore(db, { eventId: ev.id, matchId: m.id, sideA: a === top ? 21 : 10, sideB: a === top ? 10 : 21, playerId: org.id, isCreator: true });
    }
    await setTournamentLock(db, { eventId: ev.id, locked: true, actorPlayerId: org.id });
    const { getRanking } = await import("@/lib/domain/ranking");
    const [done] = await db.select().from(events).where(eq(events.id, ev.id));
    const { rows } = await getRanking(db, { venueSlug: done.venueSlug! }, new Date(NOW.getTime() + 3 * DAY));
    const of = (id: string) => rows.find((r) => r.playerId === id)!;
    // The winning pair: both first, three points and a win each.
    expect([of(org.id), of(people[0].id)].map((r) => [r.points, r.wins, r.podiums])).toEqual([
      [3, 1, 1],
      [3, 1, 1],
    ]);
    // Every pair's partners carry the same row.
    for (const [x, y] of [
      [people[1], people[2]],
      [people[3], people[4]],
    ])
      expect([of(x.id).points, of(x.id).losses]).toEqual([of(y.id).points, of(y.id).losses]);
    expect(rows.map((r) => r.points).sort()).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it("the pure rule: each pair rated as a side, its partners moved together, an unrated partner left alone", () => {
    const d = pairTournamentDeltas([
      { ids: ["a", "b"], levels: [3, null], rank: 1 },
      { ids: ["c", "d"], levels: [3, 3], rank: 2 },
      { ids: ["e", "f"], levels: [3, 3], rank: 3 },
    ]);
    // The winners are rated by Ana's 3.0 alone; she moves, her unrated partner does not.
    expect(d.get("a")).toBe(0.06);
    expect(d.has("b")).toBe(false);
    // The middle pair scores what it was expected to: no move.
    expect(d.has("c")).toBe(false);
    expect(d.get("e")).toBe(-0.06);
    expect(d.get("f")).toBe(-0.06);
  });
});

describe("leaving, and who leaves with whom", () => {
  it("a name the leaver gave goes with them, recorded as the leaver's exit and the name's removal", async () => {
    const { ev } = await pairsNight(4);
    const yan = await makePlayer(db, "Yan");
    await joinPair(db, { eventId: ev.id, playerId: yan.id, partnerName: "Yul" });
    await leaveEvent(db, { eventId: ev.id, playerId: yan.id });
    const verbs = (await db.select({ v: activity.verb }).from(activity).where(and(eq(activity.eventId, ev.id)))).map((r) => r.v);
    expect(verbs).toEqual(expect.arrayContaining(["left", "removed"]));
    expect((await seats(ev)).listed).toEqual([]);
  });

  it("nobody takes out a partner who is a player: a stranger who paired with the organiser leaves alone", async () => {
    const { org, ev } = await pairsNight(4);
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    const eve = await makePlayer(db, "Eve");
    await bePartner(db, { eventId: ev.id, playerId: eve.id, slotId: (await seats(ev)).rows.find((s) => s.playerId === org.id)!.id });
    expect((await seats(ev)).listed).toEqual(["Org & Eve"]);
    await leaveEvent(db, { eventId: ev.id, playerId: eve.id });
    // The organiser keeps their seat in their own tournament, as Partner needed.
    expect((await seats(ev)).listed).toEqual(["Org · single"]);
  });

  it("a name somebody else gave stays: the organiser's reserved name paired with a player is not the player's to take", async () => {
    const { org, ev } = await pairsNight(4);
    const kim = await makePlayer(db, "Kim");
    await joinEvent(db, { eventId: ev.id, playerId: kim.id });
    const { reserveSlot } = await import("@/lib/domain/slots");
    const { slot: zed } = await reserveSlot(db, { eventId: ev.id, actorPlayerId: org.id, name: "Zed" });
    await pairSingles(db, { eventId: ev.id, slotIds: [(await seats(ev)).rows.find((s) => s.playerId === kim.id)!.id, zed.id], actorPlayerId: org.id });
    await leaveEvent(db, { eventId: ev.id, playerId: kim.id });
    expect((await seats(ev)).listed).toEqual(["Zed · single"]);
  });

  it("leaving alone takes the unclaimed name along, so the waiting list moves up past nobody's seat", async () => {
    // The reviewer's case: four seats full, F joins with "Ghost" and waits, W waits behind them.
    const { ev } = await pairsNight(4);
    const [a, b, c, d, f, w] = await Promise.all(["A1", "B1", "C1", "D1", "F1", "W1"].map((n) => makePlayer(db, n)));
    for (const p of [a, b, c, d]) await joinEvent(db, { eventId: ev.id, playerId: p.id });
    expect((await joinPair(db, { eventId: ev.id, playerId: f.id, partnerName: "Ghost" })).outcome).toBe("waitlisted");
    await joinEvent(db, { eventId: ev.id, playerId: w.id });
    await leaveEvent(db, { eventId: ev.id, playerId: f.id });
    expect((await seats(ev)).waiting).toEqual(["W1 · single"]);
    const left = await leaveEvent(db, { eventId: ev.id, playerId: a.id });
    expect(left.promotion?.playerId).toBe(w.id);
    expect((await seats(ev)).rows.some((s) => s.invitedName === "Ghost")).toBe(false);
  });

  it("the organiser who removes a player removes the name that player gave", async () => {
    const { org, ev } = await pairsNight(4);
    const ana = await makePlayer(db, "Ana");
    await joinPair(db, { eventId: ev.id, playerId: ana.id, partnerName: "Bo" });
    const { removeFromSlot } = await import("@/lib/domain/slots");
    await removeFromSlot(db, { eventId: ev.id, slotId: (await seats(ev)).rows.find((s) => s.playerId === ana.id)!.id, actorPlayerId: org.id });
    expect((await seats(ev)).listed).toEqual([]);
  });

  it("everybody a pair's leaving moves up is told: two singles, two calendar invitations", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pairs-mail-"));
    process.env.RESEND_API_KEY = "re_test_only";
    process.env.EMAIL_SINK_FILE = path.join(dir, "mail.jsonl");
    try {
      const { ev } = await pairsNight(4);
      const [a, c, x, y] = await Promise.all(["Aa", "Cc", "Xx", "Yy"].map((n) => makePlayer(db, n, { email: `${n.toLowerCase()}@example.com` })));
      await joinPair(db, { eventId: ev.id, playerId: a.id, partnerName: "Ao" });
      await joinPair(db, { eventId: ev.id, playerId: c.id, partnerName: "Co" });
      await joinEvent(db, { eventId: ev.id, playerId: x.id });
      await joinEvent(db, { eventId: ev.id, playerId: y.id });
      const res = await leaveEvent(db, { eventId: ev.id, playerId: a.id });
      expect(promotedOf(res.promotion).map((p) => p.playerId)).toEqual([x.id, y.id]);
      const { notifyPromotion } = await import("@/lib/notify");
      await notifyPromotion(db, res.event, res.promotion);
      const to = readFileSync(process.env.EMAIL_SINK_FILE, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l).to as string);
      expect(to).toEqual(expect.arrayContaining(["xx@example.com", "yy@example.com"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the API, the MCP and the cards", () => {
  it("create_match keeps fixed pairs, join_match takes a partner, and the match lists pairs", async () => {
    const { createMatch, joinMatch, NO_SIDE_EFFECTS } = await import("@/lib/api/operations");
    const created = await createMatch(db, { type: "tournament", capacity: 8, fixedPairs: true, startsAt: "2026-10-12T19:00", tz: "Asia/Bangkok", organizer: { name: "Ola" } }, NO_SIDE_EFFECTS);
    expect(created.match).toMatchObject({ fixedPairs: true, pairs: [{ names: ["Ola"], partnerNeeded: true }] });
    const code = created.match.code;
    const joined = await joinMatch(db, { code, name: "Ana", partner: "Bo" }, NO_SIDE_EFFECTS);
    expect(joined.outcome).toBe("joined");
    expect(joined.partner?.name).toBe("Bo");
    expect(joined.partner?.inviteUrl).toMatch(new RegExp(`/${code}/i/[A-Za-z0-9]{6}$`));
    expect(joined.next).toContain("partner.inviteUrl");
    expect(joined.match.pairs).toEqual([
      { names: ["Ola"], partnerNeeded: true },
      { names: ["Ana", "Bo"], partnerNeeded: false },
    ]);
    // Alone: listed as needing a partner, and told how a partner comes.
    const alone = await joinMatch(db, { code, name: "Cy" }, NO_SIDE_EFFECTS);
    expect(alone.partner).toBeNull();
    expect(alone.next).toContain("needing a partner");
    // A partner on a night of rotating partners is refused, not dropped.
    const rotating = await createMatch(db, { type: "tournament", capacity: 8, startsAt: "2026-10-12T19:00", tz: "Asia/Bangkok", organizer: { name: "Pia" } }, NO_SIDE_EFFECTS);
    expect(rotating.match).toMatchObject({ fixedPairs: false, pairs: null });
    await expect(joinMatch(db, { code: rotating.match.code, name: "Dee", partner: "Eli" }, NO_SIDE_EFFECTS)).rejects.toMatchObject({ status: 422 });
  });

  it("the Telegram, Discord and LINE cards list a pair on one line and a single as needing a partner", async () => {
    const { renderCard } = await import("@/lib/telegram/card");
    const { renderDiscordCard } = await import("@/lib/discord/card");
    const { renderLineCard } = await import("@/lib/line/card");
    const { org, ev } = await pairsNight(8);
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    const ana = await makePlayer(db, "Ana", { level: 3.5 });
    await joinPair(db, { eventId: ev.id, playerId: ana.id, partnerName: "Bo" });
    const detail = (await getEventByCode(db, ev.code))!;
    const tg = renderCard(detail, "https://kicksma.sh", "en", NOW).text;
    expect(tg).toContain("1. Org <i>3.0</i> · org · partner needed");
    expect(tg).toContain("2. Ana <i>3.5</i> &amp; Bo <i>(reserved)</i>");
    expect(tg).toContain("3. —");
    // Telegram's HTML refuses a bare ampersand, so the pair's own is written as an entity there.
    expect(renderCard(detail, "https://kicksma.sh", "ru", NOW).text).toContain("ищет пару");
    const dc = renderDiscordCard(detail, "https://kicksma.sh", "es").embeds[0].fields?.[0].value ?? "";
    expect(dc).toContain("2. Ana *3.5* & Bo *(reservado)*");
    expect(dc).toContain("busca pareja");
    const line = JSON.stringify(renderLineCard(detail, "https://kicksma.sh", "en").messages);
    expect(line).toContain("2. Ana 3.5 & Bo (reserved)");
  });
});
