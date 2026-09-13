import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { availableSlots, blockTime, bookLesson, createCoach, presetHours, setStudentStatus, unblockTime } from "@/lib/domain/coaching";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";

/**
 * Blocking an hour is what connecting Google Calendar was standing in for, and unlike that it can be
 * done on a phone. These are the rules that make it safe to hand a coach.
 */
describe("the coach takes an hour back", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const TZ = "Asia/Bangkok";
  // A Monday 07:00 in Bangkok, as UTC. Every time below is computed from it, never from today.
  const monday07 = new Date("2026-09-14T00:00:00.000Z");
  const at = (hoursFrom07: number) => new Date(monday07.getTime() + hoursFrom07 * HOUR);

  const aCoach = async (name: string) => {
    const p = await makePlayer(db, name);
    return createCoach(db, { playerId: p.id, displayName: name, tz: TZ, hours: presetHours("both") });
  };

  it("takes the blocked hour out of what students are offered, and gives it back when undone", async () => {
    const coach = await aCoach("Olga");
    const from = monday07;
    const to = new Date(monday07.getTime() + DAY);
    const before = await availableSlots(db, coach, from, to, at(-1));
    expect(before.some((d) => d.getTime() === at(2).getTime())).toBe(true);

    const block = await blockTime(db, { coachId: coach.id, startsAt: at(2), minutes: 60 }, at(-1));
    const during = await availableSlots(db, coach, from, to, at(-1));
    expect(during.some((d) => d.getTime() === at(2).getTime())).toBe(false);
    // The hours either side are untouched: a block is an hour, not a day.
    expect(during.some((d) => d.getTime() === at(3).getTime())).toBe(true);

    expect(await unblockTime(db, coach.id, block.id)).toBe(true);
    const after = await availableSlots(db, coach, from, to, at(-1));
    expect(after.some((d) => d.getTime() === at(2).getTime())).toBe(true);
  });

  it("refuses to bury a lesson a student has booked", async () => {
    const coach = await aCoach("Nok");
    const student = await makePlayer(db, "Ivan");
    await setStudentStatus(db, coach.id, student.id, "accepted");
    await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: at(2), byCoach: false }, at(-1));
    // Cancelling that lesson is a different act, with a notice attached. Quietly covering it would
    // leave the student turning up for a lesson the coach thinks is gone.
    await expect(blockTime(db, { coachId: coach.id, startsAt: at(2), minutes: 60 }, at(-1))).rejects.toThrow(/slot_taken/);
  });

  it("refuses an hour that has already gone, and will not undo someone else's block", async () => {
    const coach = await aCoach("Ana");
    const other = await aCoach("Bea");
    await expect(blockTime(db, { coachId: coach.id, startsAt: at(2), minutes: 60 }, at(5))).rejects.toThrow(/past/);
    const mine = await blockTime(db, { coachId: coach.id, startsAt: at(2), minutes: 60 }, at(-1));
    expect(await unblockTime(db, other.id, mine.id)).toBe(false);
    expect(await unblockTime(db, coach.id, mine.id)).toBe(true);
  });
});
