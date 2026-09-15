import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { bookLesson, claimLessonPaid, createCoach, owedPerStudent, owedToCoach, presetHours, setLessonPaid, setStudentStatus } from "@/lib/domain/coaching";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

/**
 * "Who still owes me?" was a question the coach could only answer by opening the web page one student
 * at a time. `owedBy` is per student; asking it from a chat message meant a query per student, which
 * is exactly the loop rule 12 forbids. This is the one-query answer, and these are its edges.
 */
describe("who still owes the coach", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const TZ = "Asia/Bangkok";
  // A Monday 07:00 in Bangkok, as UTC. Every time comes off it, never off today (rule 11).
  const monday07 = new Date("2026-09-14T00:00:00.000Z");
  const at = (h: number) => new Date(monday07.getTime() + h * HOUR);
  const now = at(-24);

  const setup = async (tag: string) => {
    const cp = await makePlayer(db, `${tag} coach`);
    const coach = await createCoach(db, { playerId: cp.id, displayName: `${tag} coach`, tz: TZ, hours: presetHours("both") });
    return coach;
  };

  it("lists one row per unpaid lesson, with the student's name and whether they have claimed", async () => {
    const coach = await setup("owed");
    const anna = await makePlayer(db, "Anna");
    const bo = await makePlayer(db, "Bo");
    await setStudentStatus(db, coach.id, anna.id, "accepted");
    await setStudentStatus(db, coach.id, bo.id, "accepted");

    const a = await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(2), byCoach: true }, now);
    const b = await bookLesson(db, { coach, studentPlayerId: bo.id, startsAt: at(4), byCoach: true }, now);
    // A lesson only counts as owed once it carries a price, which is what the coach's rate sets.
    await db.execute(`update lessons set amount = 500 where id in ('${a.lesson.id}', '${b.lesson.id}')`);

    const rows = await owedToCoach(db, coach.id);
    expect(rows.map((r) => r.name).sort()).toEqual(["Anna", "Bo"]);
    expect(rows.every((r) => r.claimedAt === null)).toBe(true);
    expect(rows.map((r) => r.amount)).toEqual([500, 500]);
    // Earliest lesson first, so the oldest debt reads at the top.
    expect(rows[0].startsAt.getTime()).toBeLessThan(rows[1].startsAt.getTime());

    await claimLessonPaid(db, a.lesson.id, anna.id, now);
    const claimed = await owedToCoach(db, coach.id);
    expect(claimed.find((r) => r.name === "Anna")?.claimedAt).not.toBe(null);
    expect(claimed.find((r) => r.name === "Bo")?.claimedAt).toBe(null);
  });

  it("drops a lesson the moment the coach confirms it, and never shows a free one", async () => {
    const coach = await setup("settled");
    const cara = await makePlayer(db, "Cara");
    await setStudentStatus(db, coach.id, cara.id, "accepted");
    const paid = await bookLesson(db, { coach, studentPlayerId: cara.id, startsAt: at(2), byCoach: true }, now);
    const free = await bookLesson(db, { coach, studentPlayerId: cara.id, startsAt: at(4), byCoach: true }, now);
    await db.execute(`update lessons set amount = 500 where id = '${paid.lesson.id}'`);
    // `free` keeps amount null: a lesson off a package is already paid for and is not a debt.

    expect((await owedToCoach(db, coach.id)).map((r) => r.lessonId)).toEqual([paid.lesson.id]);
    await setLessonPaid(db, coach.id, paid.lesson.id, true, now);
    expect(await owedToCoach(db, coach.id)).toEqual([]);
    expect((await owedToCoach(db, coach.id)).some((r) => r.lessonId === free.lesson.id)).toBe(false);
  });

  it("stays one coach's business, and stops at the limit it is given", async () => {
    const mine = await setup("mine");
    const theirs = await setup("theirs");
    const dee = await makePlayer(db, "Dee");
    await setStudentStatus(db, mine.id, dee.id, "accepted");
    await setStudentStatus(db, theirs.id, dee.id, "accepted");
    const a = await bookLesson(db, { coach: mine, studentPlayerId: dee.id, startsAt: at(2), byCoach: true }, now);
    const b = await bookLesson(db, { coach: theirs, studentPlayerId: dee.id, startsAt: at(26), byCoach: true }, now);
    await db.execute(`update lessons set amount = 500 where id in ('${a.lesson.id}', '${b.lesson.id}')`);

    expect((await owedToCoach(db, mine.id)).map((r) => r.lessonId)).toEqual([a.lesson.id]);
    expect((await owedToCoach(db, theirs.id)).map((r) => r.lessonId)).toEqual([b.lesson.id]);
    expect(await owedToCoach(db, mine.id, 0)).toEqual([]);
  });
});

/**
 * The same question on the students screen, where the coach reads it rather than asks it: one figure
 * per student, and one total. Pure, because the screen already has both lists in hand.
 */
describe("what each student owes, as one figure", () => {
  it("adds a student's unpaid lessons to the package they have not paid for", () => {
    const owed = owedPerStudent(
      [
        { studentPlayerId: "anna", amount: 800 },
        { studentPlayerId: "anna", amount: 800 },
        { studentPlayerId: "bo", amount: 600 },
      ],
      [{ studentPlayerId: "anna", amount: 4800 }],
    );
    expect(owed.get("anna")).toBe(6400);
    expect(owed.get("bo")).toBe(600);
  });

  it("leaves out a student who owes nothing, so the screen shows no zero", () => {
    const owed = owedPerStudent([{ studentPlayerId: "cara", amount: 0 }], [{ studentPlayerId: "dee", amount: null }]);
    expect(owed.size).toBe(0);
    expect(owed.get("cara")).toBeUndefined();
  });

  it("counts a package with no price as nothing owed rather than as a blank", () => {
    const owed = owedPerStudent([{ studentPlayerId: "eve", amount: 500 }], [{ studentPlayerId: "eve", amount: null }]);
    expect(owed.get("eve")).toBe(500);
  });
});
