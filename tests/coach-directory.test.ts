import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { blockTime, bookLesson, busyForCoaches, coachCardFacts, createCoach, nextFree, NO_BUSY, openHour, presetHours, priceFrom, setStudentStatus, studentStatus, updateCoach } from "@/lib/domain/coaching";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";

/**
 * The player's side of the directory: what a card says, and whether a stranger can take an hour.
 * Before this, three coaches read exactly alike (a name, a length, a club) and every one of them
 * ended on "Ask to become a student", so nobody could compare and nobody could book.
 */
describe("the coach directory", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const TZ = "Asia/Bangkok";
  // A Monday 00:00 UTC. Every time below counts from it, never from today (rule 11).
  // The morning template is 07:00–12:00 Bangkok, which is 00:00–05:00 UTC, so at(0) is the first hour.
  const monday = new Date("2026-10-05T00:00:00.000Z");
  const at = (h: number) => new Date(monday.getTime() + h * HOUR);
  // Two hours before the Monday template opens: the Sunday morning window (00:00-05:00 UTC) has
  // already closed, and the coach's default two-hour notice makes at(0) the first bookable hour.
  const before = new Date(monday.getTime() - 2 * HOUR);

  const aCoach = async (name: string, patch: Parameters<typeof updateCoach>[2] = {}) => {
    const p = await makePlayer(db, name);
    const coach = await createCoach(db, { playerId: p.id, displayName: name, tz: TZ, hours: presetHours("mornings") });
    return Object.keys(patch).length ? updateCoach(db, coach.id, patch) : coach;
  };

  it("reads the diary of a whole list in one go, busy and opened hours apart", async () => {
    const one = await aCoach("Nina");
    const two = await aCoach("Omar");
    const three = await aCoach("Pia");
    await blockTime(db, { coachId: one.id, startsAt: at(1), minutes: 60 }, before);
    // 13:00 Bangkok: outside the morning template, so it is an opening and not busy time.
    await openHour(db, two.id, at(6), two.lessonMinutes);
    const map = await busyForCoaches(db, [one.id, two.id, three.id], before, new Date(monday.getTime() + 14 * DAY));

    expect(map.get(one.id)?.busy.map((b) => b.startsAt.toISOString())).toEqual([at(1).toISOString()]);
    expect(map.get(one.id)?.openings).toEqual([]);
    expect(map.get(two.id)?.busy).toEqual([]);
    expect(map.get(two.id)?.openings.map((o) => o.startsAt.toISOString())).toEqual([at(6).toISOString()]);
    // A coach with nothing in the diary is still in the map, so a card never has to guess.
    expect(map.get(three.id)).toEqual({ busy: [], openings: [] });
    expect(await busyForCoaches(db, [], before, at(1))).toEqual(new Map());
  });

  it("says the first free hour, and counts an hour the coach opened outside the week", async () => {
    const coach = await aCoach("Quinn");
    await blockTime(db, { coachId: coach.id, startsAt: at(0), minutes: 60 }, before);
    const map = await busyForCoaches(db, [coach.id], before, new Date(monday.getTime() + 14 * DAY));
    // The 07:00 hour is blocked, so the first free one is 08:00 Bangkok.
    expect(nextFree(coach, map.get(coach.id) ?? NO_BUSY, before)?.toISOString()).toBe(at(1).toISOString());

    // A coach whose whole week is empty has no free hour at all, until they open one date.
    const quiet = await aCoach("Rui", { hours: {} });
    expect(nextFree(quiet, NO_BUSY, before)).toBeNull();
    await openHour(db, quiet.id, at(6), quiet.lessonMinutes);
    const quietMap = await busyForCoaches(db, [quiet.id], before, new Date(monday.getTime() + 14 * DAY));
    expect(nextFree(quiet, quietMap.get(quiet.id) ?? NO_BUSY, before)?.toISOString()).toBe(at(6).toISOString());
  });

  it("quotes the price of a lesson for one, never the price of a lesson for four", () => {
    // priceFour is the price of a lesson shared by four, so it is the biggest number and the least
    // like what one person pays. A card that showed it would say "from 2400" to somebody alone.
    expect(priceFrom({ priceSingle: 1200, priceSecondSingle: 800 })).toBe(800);
    expect(priceFrom({ priceSingle: 1200, priceSecondSingle: null })).toBe(1200);
    expect(priceFrom({ priceSingle: null, priceSecondSingle: null })).toBeNull();
  });

  it("puts on the card what a player chooses between", async () => {
    const coach = await aCoach("Sofia", { priceSingle: 1200, currency: "thb", teachesLevelMin: 2, teachesLevelMax: 4.5, openBooking: true, bio: "Ten years on clay." });
    const facts = coachCardFacts(coach, NO_BUSY, before);
    expect(facts).toMatchObject({ handle: coach.handle, displayName: "Sofia", priceFrom: 1200, currency: "THB", openBooking: true, levels: { min: 2, max: 4.5 } });
    expect(facts.nextFree).toBe(at(0).toISOString());
  });

  it("keeps the taught levels on the scale and the right way round", async () => {
    const coach = await aCoach("Tom", { teachesLevelMin: 4, teachesLevelMax: 2 });
    expect([coach.teachesLevelMin, coach.teachesLevelMax]).toEqual([2, 4]);
    const clamped = await updateCoach(db, coach.id, { teachesLevelMin: -3, teachesLevelMax: 99 });
    expect([clamped.teachesLevelMin, clamped.teachesLevelMax]).toEqual([0, 7]);
    const halved = await updateCoach(db, coach.id, { teachesLevelMin: 2.4, teachesLevelMax: null });
    expect([halved.teachesLevelMin, halved.teachesLevelMax]).toEqual([2.5, null]);
  });
});

/**
 * "Anyone can book": the booking is the joining. The coach still decides who stays — a paused
 * student is paused for a reason, and off is still the default for everybody.
 */
describe("booking without asking first", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const TZ = "Asia/Bangkok";
  const monday = new Date("2026-10-05T00:00:00.000Z");
  const at = (h: number) => new Date(monday.getTime() + h * HOUR);
  const before = new Date(monday.getTime() - DAY);

  const aCoach = async (name: string, openBooking: boolean) => {
    const p = await makePlayer(db, name);
    const coach = await createCoach(db, { playerId: p.id, displayName: name, tz: TZ, hours: presetHours("mornings") });
    return updateCoach(db, coach.id, { openBooking });
  };

  it("puts a stranger on the list the moment they take an hour", async () => {
    const coach = await aCoach("Ula", true);
    const anna = await makePlayer(db, "Anna");
    expect(await studentStatus(db, coach.id, anna.id)).toBe("none");
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(1), byCoach: false, source: "web" }, before);
    expect(lesson.startsAt.toISOString()).toBe(at(1).toISOString());
    expect(await studentStatus(db, coach.id, anna.id)).toBe("accepted");
  });

  it("still refuses a stranger when the coach did not open the door", async () => {
    const coach = await aCoach("Vik", false);
    const bo = await makePlayer(db, "Bo");
    await expect(bookLesson(db, { coach, studentPlayerId: bo.id, startsAt: at(1), byCoach: false, source: "web" }, before)).rejects.toMatchObject({ code: "not_student" });
    expect(await studentStatus(db, coach.id, bo.id)).toBe("none");
  });

  it("refuses a paused student, because the coach paused them on purpose", async () => {
    const coach = await aCoach("Wen", true);
    const cai = await makePlayer(db, "Cai");
    await setStudentStatus(db, coach.id, cai.id, "paused");
    await expect(bookLesson(db, { coach, studentPlayerId: cai.id, startsAt: at(1), byCoach: false, source: "web" }, before)).rejects.toMatchObject({ code: "not_student" });
    expect(await studentStatus(db, coach.id, cai.id)).toBe("paused");
  });

  it("leaves no student behind when the booking itself is refused", async () => {
    const coach = await aCoach("Xan", true);
    const dee = await makePlayer(db, "Dee");
    const eve = await makePlayer(db, "Eve");
    await bookLesson(db, { coach, studentPlayerId: dee.id, startsAt: at(2), byCoach: false, source: "web" }, before);
    // The hour is gone, and an hour outside the week was never on offer.
    await expect(bookLesson(db, { coach, studentPlayerId: eve.id, startsAt: at(2), byCoach: false, source: "web" }, before)).rejects.toMatchObject({ code: "slot_taken" });
    await expect(bookLesson(db, { coach, studentPlayerId: eve.id, startsAt: at(9), byCoach: false, source: "web" }, before)).rejects.toMatchObject({ code: "outside_hours" });
    expect(await studentStatus(db, coach.id, eve.id)).toBe("none");
  });

  it("lets somebody who walked away come back by booking again", async () => {
    const coach = await aCoach("Yara", true);
    const fin = await makePlayer(db, "Fin");
    await setStudentStatus(db, coach.id, fin.id, "left");
    await bookLesson(db, { coach, studentPlayerId: fin.id, startsAt: at(3), byCoach: false, source: "web" }, before);
    expect(await studentStatus(db, coach.id, fin.id)).toBe("accepted");
  });
});
