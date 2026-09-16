import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { availableSlots, blockTime, bookLesson, cancelLesson, createCoach, leaveCoach, listStudentCoaches, listStudents, presetHours, requestStudent, setStudentStatus, studentStatus, unblockTime } from "@/lib/domain/coaching";
import { matchStudent } from "@/lib/coach/assistant";
import { studentRefs } from "@/lib/telegram/coach";
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

describe("a player takes a coach off their own list", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const pair = async (name: string) => {
    const coachPlayer = await makePlayer(db, `${name} coach`);
    const student = await makePlayer(db, `${name} student`);
    const coach = await createCoach(db, { playerId: coachPlayer.id, displayName: name, tz: "Asia/Bangkok", hours: presetHours("both") });
    await setStudentStatus(db, coach.id, student.id, "accepted");
    return { coach, student };
  };

  it("takes the coach's door off My matches, and lets them come back", async () => {
    const { coach, student } = await pair("Ana");
    expect((await listStudentCoaches(db, student.id)).map((c) => c.status)).toEqual(["accepted"]);
    await leaveCoach(db, coach.id, student.id);
    // My matches lists only accepted and requested, so the "Book more" door is gone.
    expect((await listStudentCoaches(db, student.id)).map((c) => c.status)).toEqual(["left"]);
    expect(await studentStatus(db, coach.id, student.id)).toBe("left");
    // Leaving is not a door that locks behind them.
    expect(await requestStudent(db, coach.id, student.id)).toBe("requested");
  });

  it("refuses while a lesson is still to come, and allows it once that lesson is gone", async () => {
    const { coach, student } = await pair("Bo");
    const when = new Date(Date.now() + 48 * HOUR);
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: when, byCoach: true });
    // The same rule a coach meets when closing a book: nobody is left holding an appointment nobody watches.
    await expect(leaveCoach(db, coach.id, student.id)).rejects.toMatchObject({ code: "has_lessons" });
    await cancelLesson(db, { lessonId: lesson.id, by: "coach", coach });
    await leaveCoach(db, coach.id, student.id);
    expect(await studentStatus(db, coach.id, student.id)).toBe("left");
  });

  it("leaves the coach's book alone: the student, their lessons and anything owed stay", async () => {
    const { coach, student } = await pair("Cy");
    // A lesson already taken: booked ahead, then the clock moved past it.
    const { lesson: done } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: new Date(Date.now() + HOUR), byCoach: true });
    await leaveCoach(db, coach.id, student.id, new Date(Date.now() + 2 * HOUR));
    // A student who leaves owing money does not take the debt off the coach's screen with them.
    const students = await listStudents(db, coach.id);
    expect(students.map((s) => s.status)).toEqual(["left"]);
    expect(done.id).toBeTruthy();
  });

  it("stops the coach's bot booking over the decision, without inventing a second person of that name", async () => {
    const { coach, student } = await pair("Dee");
    expect((await studentRefs(db, coach.id)).map((r) => r.left)).toEqual([false]);
    await leaveCoach(db, coach.id, student.id);
    const refs = await studentRefs(db, coach.id);
    // The name is still known — so typing it is answered, not turned into a brand-new "Dee".
    expect(refs.map((r) => r.left)).toEqual([true]);
    expect(matchStudent("Dee", refs)).toMatchObject({ kind: "one", student: { id: student.id, left: true } });
  });
});
