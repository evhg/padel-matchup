import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { lessonPackages } from "@/db/schema";
import { availableSlots, blockTime, bookLesson, createCoach, createPackage, moveLesson, packageLine, presetHours, setStudentStatus } from "@/lib/domain/coaching";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";

/**
 * "Can we do Friday instead?" is the most common message a coach gets, and the product's answer used
 * to be: cancel, lose the session, and hope the slot is still there. These are the rules that replace it.
 */
describe("moving a lesson", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const TZ = "Asia/Bangkok";
  // A Monday 07:00 in Bangkok, as UTC. Every time is computed from it, never from today (rule 11).
  const monday07 = new Date("2026-09-14T00:00:00.000Z");
  // at(h) in Bangkok, with the "both" preset open 07:00-12:00 and 15:00-20:00:
  //   at(0)=07:00 ✓  at(2)=09:00 ✓  at(4)=11:00 ✓  at(5)=12:00 ✗ gap  at(8)=15:00 ✓  at(12)=19:00 ✓
  const at = (h: number) => new Date(monday07.getTime() + h * HOUR);
  // "Now" for the cases that should succeed: a day ahead of the lesson, so it is outside the cutoff.
  const DAY_BEFORE = at(-24);

  const setup = async (name: string) => {
    const cp = await makePlayer(db, `${name} coach`);
    const coach = await createCoach(db, { playerId: cp.id, displayName: name, tz: TZ, hours: presetHours("both") });
    const student = await makePlayer(db, `${name} student`);
    await setStudentStatus(db, coach.id, student.id, "accepted");
    return { coach, student };
  };

  it("leaves the package exactly where it was: a move is not a cancellation and a repurchase", async () => {
    const { coach, student } = await setup("Olga");
    const pkg = await createPackage(db, { coachId: coach.id, studentPlayerId: student.id, size: 10 });
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: at(2), byCoach: false }, DAY_BEFORE);
    const [afterBooking] = await db.select().from(lessonPackages).where(eq(lessonPackages.id, pkg.id));
    expect(packageLine(afterBooking, DAY_BEFORE).left).toBe(9);

    const moved = await moveLesson(db, { lessonId: lesson.id, coach, startsAt: at(4), by: "student", actorPlayerId: student.id }, DAY_BEFORE);
    expect(moved.to.startsAt.getTime()).toBe(at(4).getTime());
    expect(moved.to.id).toBe(lesson.id);
    const [afterMove] = await db.select().from(lessonPackages).where(eq(lessonPackages.id, pkg.id));
    // Nine before, nine after. No refund, no second draw, no free pass spent.
    expect(packageLine(afterMove, DAY_BEFORE).left).toBe(9);
    expect(afterMove.latePassesUsed).toBe(0);
  });

  it("frees the old hour and takes the new one, with no moment where it holds neither", async () => {
    const { coach, student } = await setup("Nok");
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: at(2), byCoach: false }, DAY_BEFORE);
    const before = await availableSlots(db, coach, monday07, new Date(monday07.getTime() + DAY), DAY_BEFORE);
    expect(before.some((d) => d.getTime() === at(2).getTime())).toBe(false);

    await moveLesson(db, { lessonId: lesson.id, coach, startsAt: at(4), by: "student", actorPlayerId: student.id }, DAY_BEFORE);
    const after = await availableSlots(db, coach, monday07, new Date(monday07.getTime() + DAY), DAY_BEFORE);
    expect(after.some((d) => d.getTime() === at(2).getTime())).toBe(true);
    expect(after.some((d) => d.getTime() === at(4).getTime())).toBe(false);
  });

  it("refuses an hour that is already taken, and leaves the lesson where it was", async () => {
    const { coach, student } = await setup("Ana");
    const other = await makePlayer(db, "Someone else");
    await setStudentStatus(db, coach.id, other.id, "accepted");
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: at(2), byCoach: false }, DAY_BEFORE);
    await bookLesson(db, { coach, studentPlayerId: other.id, startsAt: at(4), byCoach: false }, DAY_BEFORE);

    await expect(moveLesson(db, { lessonId: lesson.id, coach, startsAt: at(4), by: "student", actorPlayerId: student.id }, DAY_BEFORE)).rejects.toThrow(/slot_taken/);
    // An hour the coach blocked for themselves is just as taken.
    await blockTime(db, { coachId: coach.id, startsAt: at(8), minutes: 60 }, DAY_BEFORE);
    await expect(moveLesson(db, { lessonId: lesson.id, coach, startsAt: at(8), by: "student", actorPlayerId: student.id }, DAY_BEFORE)).rejects.toThrow(/slot_taken/);
  });

  it("stops a student moving once the lesson is inside the cutoff, which is what makes the late rule mean anything", async () => {
    const { coach, student } = await setup("Bea");
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: at(2), byCoach: false }, DAY_BEFORE);
    // One hour before, with a twelve-hour cutoff: moving it to next week would dodge the policy
    // entirely, because next week's lesson could then be cancelled for free.
    await expect(moveLesson(db, { lessonId: lesson.id, coach, startsAt: at(24 * 7), by: "student", actorPlayerId: student.id }, at(1))).rejects.toThrow(/too_late/);
    // The coach may still move it: it is their time, and they are the one telling the student.
    const moved = await moveLesson(db, { lessonId: lesson.id, coach, startsAt: at(24 * 7), by: "coach" }, at(1));
    expect(moved.to.startsAt.getTime()).toBe(at(24 * 7).getTime());
  });

  it("holds a student to the coach's hours and notice, and to their own lessons", async () => {
    const { coach, student } = await setup("Cara");
    const stranger = await makePlayer(db, "Stranger");
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: at(2), byCoach: false }, DAY_BEFORE);
    // 02:00 Bangkok is outside every preset hour.
    await expect(moveLesson(db, { lessonId: lesson.id, coach, startsAt: at(19), by: "student", actorPlayerId: student.id }, DAY_BEFORE)).rejects.toThrow(/outside_hours/);
    // Notice is about the new hour: a lesson far enough out, moved to one hour from now.
    const { lesson: far } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: at(32), byCoach: false }, DAY_BEFORE);
    await expect(moveLesson(db, { lessonId: far.id, coach, startsAt: at(1), by: "student", actorPlayerId: student.id }, at(0))).rejects.toThrow(/too_soon/);
    await expect(moveLesson(db, { lessonId: lesson.id, coach, startsAt: at(4), by: "student", actorPlayerId: stranger.id }, DAY_BEFORE)).rejects.toThrow(/forbidden/);
  });

  it("moving to the hour it already has changes nothing", async () => {
    const { coach, student } = await setup("Dee");
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: at(2), byCoach: false }, DAY_BEFORE);
    const same = await moveLesson(db, { lessonId: lesson.id, coach, startsAt: at(2), by: "student", actorPlayerId: student.id }, DAY_BEFORE);
    expect(same.to.startsAt.getTime()).toBe(at(2).getTime());
  });
});
