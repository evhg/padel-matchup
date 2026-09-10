import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { claimClub, decideClub } from "@/lib/domain/clubs";
import { createCoach, presetHours } from "@/lib/domain/coaching";
import { addClubSlot, autoCreateClubEvents, cleanSlotInput } from "@/lib/domain/clubWeek";
import { eq } from "drizzle-orm";
import { events, groupMembers, players } from "@/db/schema";
import { createEvent, updateEvent } from "@/lib/domain/events";
import { createGroup } from "@/lib/domain/groups";
import { admission, isLevelVerified } from "@/lib/domain/levels";
import { setPlayerLevel } from "@/lib/domain/rating";
import { createJoinRequest, getJoinRequests } from "@/lib/domain/requests";
import { joinEvent } from "@/lib/domain/slots";
import { admitConfirmed, askLevelCheck, confirmLevel, decideLevelCheck, isVerifierFor, listLevelChecks, myLevelChecks, verifiersFor, withdrawLevelCheck } from "@/lib/domain/verify";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

/** Tuesday 8 September 2026, 16:00 in Phuket. */
const NOW = new Date("2026-09-08T09:00:00Z");

describe("verified levels", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  it("admission: the confirmed number itself must fit; a self-declaration next to an old tick does not", () => {
    const gold = { levelMin: 3.5, levelMax: 4.5, levelVerifiedOnly: true };
    expect(admission(gold, { level: 3.5, levelVerifiedLevel: 3.5 })).toBe("ok");
    // Confirmed at 3.0, typed 3.5 by hand: within the tolerance, still ticked, but 3.0 was never inside 3.5–4.5.
    expect(admission(gold, { level: 3.5, levelVerifiedLevel: 3.0 })).toBe("unverified");
    expect(admission(gold, { level: 4.0, levelVerifiedLevel: 4.25 })).toBe("ok");
  });

  it("admission: open events admit everyone, ranged events admit levels inside, verified-only events admit confirmed levels inside", () => {
    const open = { levelMin: null, levelMax: null, levelVerifiedOnly: false };
    const gold = { levelMin: 3, levelMax: 4.5, levelVerifiedOnly: false };
    const strict = { levelMin: 3, levelMax: 4.5, levelVerifiedOnly: true };
    expect(admission(open, { level: null })).toBe("ok");
    expect(admission(open, null)).toBe("ok");
    expect(admission(gold, { level: null })).toBe("unknown");
    expect(admission(gold, { level: 2 })).toBe("below");
    expect(admission(gold, { level: 5 })).toBe("above");
    expect(admission(gold, { level: 3.5 })).toBe("ok");
    expect(admission(strict, { level: 3.5 })).toBe("unverified");
    expect(admission(strict, { level: 3.5, levelVerifiedLevel: 3.5 })).toBe("ok");
    expect(admission(strict, { level: 3.5, levelVerifiedLevel: 3.1 })).toBe("ok");
    // Drifted a full step since the tick: the tick no longer holds.
    expect(admission(strict, { level: 3.5, levelVerifiedLevel: 2.5 })).toBe("unverified");
    expect(admission(strict, { level: 5, levelVerifiedLevel: 5 })).toBe("above");
    // Without a range the flag means nothing.
    expect(admission({ levelMin: null, levelMax: null, levelVerifiedOnly: true }, { level: null })).toBe("ok");
  });

  it("the flag needs a range on create and update, and copies onto the matches a club programme makes", async () => {
    const org = await makePlayer(db, "Org", { level: 4 });
    const base = { creatorPlayerId: org.id, type: "match" as const, startsAt: new Date(NOW.getTime() + DAY), tz: "Asia/Bangkok", whenFull: "waitlist" as const };
    const loose = await createEvent(db, { ...base, levelVerifiedOnly: true });
    expect(loose.levelVerifiedOnly).toBe(false);
    const strict = await createEvent(db, { ...base, levelMin: 3, levelMax: 4.5, levelVerifiedOnly: true });
    expect(strict.levelVerifiedOnly).toBe(true);
    // Dropping the range drops the flag; a range set again needs the flag again; the flag alone can be switched off.
    expect((await updateEvent(db, strict.id, org.id, { levelMin: null, levelMax: null })).event.levelVerifiedOnly).toBe(false);
    expect((await updateEvent(db, strict.id, org.id, { levelMin: 3, levelMax: 4.5 })).event.levelVerifiedOnly).toBe(false);
    expect((await updateEvent(db, strict.id, org.id, { levelVerifiedOnly: true })).event.levelVerifiedOnly).toBe(true);
    expect((await updateEvent(db, strict.id, org.id, { levelVerifiedOnly: false })).event.levelVerifiedOnly).toBe(false);
    expect((await updateEvent(db, loose.id, org.id, { levelVerifiedOnly: true })).event.levelVerifiedOnly).toBe(false);

    expect(cleanSlotInput({ dow: 4, time: "19:00", levelMin: 3, levelMax: 4.5, verifiedOnly: true }).verifiedOnly).toBe(true);
    expect(cleanSlotInput({ dow: 4, time: "19:00", verifiedOnly: true }).verifiedOnly).toBe(false);
    const nok = await makePlayer(db, "Nok");
    const club = await claimClub(db, { name: "Strict Padel Club", playerId: nok.id, tz: "Asia/Bangkok" });
    await decideClub(db, club.slug, true, NOW);
    await addClubSlot(db, club.slug, { dow: 4, time: "19:00", type: "tournament", format: "americano", capacity: 8, levelMin: 3, levelMax: 4.5, verifiedOnly: true, title: "Gold night" });
    const made = (await autoCreateClubEvents(db, NOW)).created.filter((c) => c.club.slug === club.slug);
    expect(made).toHaveLength(1);
    expect(made[0].event.levelVerifiedOnly).toBe(true);
  });

  it("a player asks a coach at the club or the club; the confirmation ticks the level and seats them where they asked", async () => {
    const nok = await makePlayer(db, "Nok2", { level: 4 });
    const club = await claimClub(db, { name: "Coast Padel", playerId: nok.id, tz: "Asia/Bangkok" });
    await decideClub(db, club.slug, true, NOW);
    const coachPlayer = await makePlayer(db, "Coach Ana", { level: 5 });
    const coach = await createCoach(db, { playerId: coachPlayer.id, displayName: "Ana", clubNames: "Coast Padel", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Bangkok" });
    const org = await makePlayer(db, "Org2", { level: 4 });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "tournament", capacity: 8, startsAt: new Date(NOW.getTime() + 2 * DAY), tz: "Asia/Bangkok", venueName: "Coast Padel", whenFull: "waitlist", levelMin: 3, levelMax: 4.5, levelVerifiedOnly: true });

    // Who can confirm here: the coach who named the club, then the live claimed club.
    const verifiers = await verifiersFor(db, ev);
    expect(verifiers.map((v) => v.kind)).toEqual(["coach", "club"]);
    expect(verifiers[0].kind === "coach" && verifiers[0].id).toBe(coach.id);
    // A match somewhere else has nobody to ask.
    const elsewhere = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 2 * DAY), tz: "Asia/Bangkok", venueName: "Unknown Courts", whenFull: "waitlist", levelMin: 3, levelMax: 4.5, levelVerifiedOnly: true });
    expect(await verifiersFor(db, elsewhere)).toEqual([]);

    const mia = await makePlayer(db, "Mia", { level: 3.5 });
    expect(admission(ev, mia)).toBe("unverified");
    await createJoinRequest(db, { eventId: ev.id, playerId: mia.id, level: 3.5, now: NOW });

    // Only the event's verifiers can be asked from it.
    expect(isVerifierFor(verifiers, { coachId: coach.id })).toBe(true);
    expect(isVerifierFor(verifiers, { clubSlug: club.slug })).toBe(true);
    expect(isVerifierFor(verifiers, { coachId: mia.id })).toBe(false);
    expect(isVerifierFor(verifiers, { clubSlug: "elsewhere" })).toBe(false);
    // One open ask per pair (the second tap finds the first, and nobody is notified twice); the coach cannot ask themself; no level, nothing to confirm.
    const first = await askLevelCheck(db, { playerId: mia.id, target: { coachId: coach.id }, eventId: ev.id, now: NOW });
    const ask = first.check;
    expect(first.created).toBe(true);
    expect(ask.level).toBe(3.5);
    expect(ask.eventId).toBe(ev.id);
    const again = await askLevelCheck(db, { playerId: mia.id, target: { coachId: coach.id }, now: NOW });
    expect(again.check.id).toBe(ask.id);
    expect(again.created).toBe(false);
    await expect(askLevelCheck(db, { playerId: coachPlayer.id, target: { coachId: coach.id } })).rejects.toThrow(/self/);
    await expect(askLevelCheck(db, { playerId: nok.id, target: { clubSlug: club.slug } })).rejects.toThrow(/self/);
    const noLevel = await makePlayer(db, "NoLevel");
    await expect(askLevelCheck(db, { playerId: noLevel.id, target: { coachId: coach.id } })).rejects.toThrow(/level_required/);
    await expect(askLevelCheck(db, { playerId: mia.id, target: { clubSlug: "nowhere" } })).rejects.toThrow(/not_found/);
    expect((await listLevelChecks(db, { coachId: coach.id })).map((c) => c.player.displayName)).toEqual(["Mia"]);
    expect((await myLevelChecks(db, mia.id)).map((c) => c.id)).toEqual([ask.id]);

    // Only the coach who was asked can answer.
    await expect(decideLevelCheck(db, { id: ask.id, target: { clubSlug: club.slug }, approve: true, byPlayerId: nok.id })).rejects.toThrow(/not_found/);
    // The coach confirms at 3.25: their number becomes the level, with the tick and its source.
    const { check, player } = await decideLevelCheck(db, { id: ask.id, target: { coachId: coach.id }, approve: true, level: 3.25, byPlayerId: coachPlayer.id, now: NOW });
    expect(check.status).toBe("confirmed");
    expect(check.decidedLevel).toBe(3.25);
    expect(player.level).toBe(3.25);
    expect(player.levelSource).toBe("confirmed");
    expect(player.levelVerifiedSource).toBe("coach");
    expect(player.levelVerifiedBy).toBe(coachPlayer.id);
    expect(isLevelVerified(player)).toBe(true);
    expect(admission(ev, player)).toBe("ok");
    await expect(decideLevelCheck(db, { id: ask.id, target: { coachId: coach.id }, approve: true, byPlayerId: coachPlayer.id })).rejects.toThrow(/not_pending/);
    expect(await listLevelChecks(db, { coachId: coach.id })).toEqual([]);

    // Seated where she asked, as if the organizer had tapped, and in the match's group like any join; nothing left to admit afterwards.
    const crew = await createGroup(db, { name: "Gold crew", creatorPlayerId: org.id, tz: "Asia/Bangkok" });
    await db.update(events).set({ groupId: crew.id }).where(eq(events.id, ev.id));
    const admitted = await admitConfirmed(db, player, coachPlayer.id, NOW);
    expect(admitted.map((a) => a.event.id)).toEqual([ev.id]);
    expect(admitted[0].join.outcome).toBe("joined");
    expect((await getJoinRequests(db, ev.id)).find((r) => r.playerId === mia.id)?.status).toBe("approved");
    expect((await db.select().from(groupMembers).where(eq(groupMembers.groupId, crew.id))).some((m) => m.playerId === mia.id)).toBe(true);
    expect(await admitConfirmed(db, player, coachPlayer.id, NOW)).toEqual([]);
    // A number she types herself, far from the confirmed one, is a new claim: the tick goes; a quarter step keeps it.
    const playerRow = async (id: string) => (await db.select().from(players).where(eq(players.id, id)))[0];
    await setPlayerLevel(db, mia.id, 3.5);
    expect(isLevelVerified(await playerRow(mia.id))).toBe(true);
    await setPlayerLevel(db, mia.id, 4.5);
    const reclaimed = await playerRow(mia.id);
    expect(reclaimed.levelVerifiedLevel).toBeNull();
    expect(reclaimed.levelVerifiedSource).toBeNull();
    expect(admission(ev, reclaimed)).toBe("unverified");

    // The club declines someone; they may ask again; an ask can be withdrawn once.
    const leo = await makePlayer(db, "Leo", { level: 3 });
    const { check: a2 } = await askLevelCheck(db, { playerId: leo.id, target: { clubSlug: club.slug }, now: NOW });
    expect((await listLevelChecks(db, { clubSlug: club.slug })).map((c) => c.id)).toEqual([a2.id]);
    const declined = await decideLevelCheck(db, { id: a2.id, target: { clubSlug: club.slug }, approve: false, byPlayerId: nok.id, now: NOW });
    expect(declined.check.status).toBe("declined");
    expect(declined.player.level).toBe(3);
    expect(isLevelVerified(declined.player)).toBe(false);
    const { check: a3 } = await askLevelCheck(db, { playerId: leo.id, target: { clubSlug: club.slug }, now: NOW });
    expect(a3.id).not.toBe(a2.id);
    expect(await withdrawLevelCheck(db, a3.id, leo.id, NOW)).toBe(true);
    expect(await withdrawLevelCheck(db, a3.id, leo.id, NOW)).toBe(false);

    // A confirmed level that no longer fits, or a full match, is not seated: the organizer's list keeps the ask.
    const small = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 3 * DAY), tz: "Asia/Bangkok", venueName: "Coast Padel", whenFull: "closed", levelMin: 3, levelMax: 4.5, levelVerifiedOnly: true });
    for (const n of ["A", "B", "C", "D"]) await joinEvent(db, { eventId: small.id, playerId: (await makePlayer(db, n)).id });
    await createJoinRequest(db, { eventId: small.id, playerId: leo.id, level: 3, now: NOW });
    const leoConfirmed = await confirmLevel(db, { playerId: leo.id, byPlayerId: nok.id, source: "club", now: NOW });
    expect(leoConfirmed.levelVerifiedSource).toBe("club");
    expect(leoConfirmed.levelSource).toBe(leo.levelSource);
    expect(await admitConfirmed(db, leoConfirmed, nok.id, NOW)).toEqual([]);
    expect((await getJoinRequests(db, small.id)).find((r) => r.playerId === leo.id)?.status).toBe("pending");
    await expect(confirmLevel(db, { playerId: noLevel.id, byPlayerId: nok.id, source: "club" })).rejects.toThrow(/level_required/);
  });

  it("the organizer's own confirmation counts the same way", async () => {
    const org = await makePlayer(db, "Org3", { level: 4 });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + DAY), tz: "Asia/Bangkok", whenFull: "waitlist", levelMin: 3, levelMax: 4.5, levelVerifiedOnly: true });
    const sam = await makePlayer(db, "Sam", { level: 4 });
    expect(admission(ev, sam)).toBe("unverified");
    const confirmed = await confirmLevel(db, { playerId: sam.id, byPlayerId: org.id, source: "organizer", now: NOW });
    expect(admission(ev, confirmed)).toBe("ok");
    expect(confirmed.level).toBe(4);
    expect(confirmed.levelVerifiedSource).toBe("organizer");
  });
});
