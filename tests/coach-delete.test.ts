import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import {
  bookLesson,
  coachBookContents,
  createCoach,
  createPackage,
  deleteCoachBook,
  getCoachByHandle,
  getCoachByPlayerId,
  insertCoach,
  presetHours,
  setStudentStatus,
} from "@/lib/domain/coaching";
import { anonymizePlayer } from "@/lib/domain/anonymize";
import { coachManagers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

/**
 * A coach who set a book up to see what it was had no way to put it back, and a coach testing the
 * walk could not take it again: the walk reopens at the price step, and `insertCoach` returns the
 * existing book untouched, so the first three answers went nowhere. These are the rules for closing one.
 */
describe("closing a coach's book", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const TZ = "Asia/Bangkok";
  // A Monday 07:00 in Bangkok, as UTC. Never today (rule 11). at(2) = 09:00, inside the "both" preset.
  const monday07 = new Date("2026-09-14T00:00:00.000Z");
  const at = (h: number) => new Date(monday07.getTime() + h * HOUR);
  const DAY_BEFORE = at(-24);

  const aBook = async (name: string) => {
    const p = await makePlayer(db, `${name} coach`);
    const coach = await createCoach(db, { playerId: p.id, displayName: name, tz: TZ, hours: presetHours("both") });
    const student = await makePlayer(db, `${name} student`);
    await setStudentStatus(db, coach.id, student.id, "accepted");
    return { owner: p, coach, student };
  };

  it("takes the students, the lessons and the packages with it, and frees the handle", async () => {
    const { owner, coach, student } = await aBook("Olga");
    await createPackage(db, { coachId: coach.id, studentPlayerId: student.id, size: 10 });
    await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: at(2), byCoach: false }, DAY_BEFORE);
    expect(await coachBookContents(db, coach.id, DAY_BEFORE)).toMatchObject({ students: 1, lessons: 1, packages: 1 });

    // The lesson has happened by the time the book closes, so nobody is left waiting for an hour.
    const gone = await deleteCoachBook(db, { coachId: coach.id, actorPlayerId: owner.id }, at(48));
    expect(gone).toMatchObject({ students: 1, lessons: 1, packages: 1, upcoming: 0 });
    expect(await getCoachByPlayerId(db, owner.id)).toBeNull();
    expect(await getCoachByHandle(db, coach.handle)).toBeNull();
    expect(await coachBookContents(db, coach.id, at(48))).toMatchObject({ students: 0, lessons: 0, packages: 0 });
  });

  it("lets the same person set up again from the first question", async () => {
    const { owner, coach } = await aBook("Nok");
    await deleteCoachBook(db, { coachId: coach.id, actorPlayerId: owner.id }, at(48));

    // The point of the whole thing: a second book, not the first one handed back. Archiving could not
    // do this — coaches_player_idx is unique on player_id with no partial clause, so an archived row
    // still holds the slot and insertCoach would find nothing and throw.
    const again = await insertCoach(db, { playerId: owner.id, displayName: "Nok", clubNames: "Thanyapura", lessonMinutes: 60, hours: presetHours("mornings"), tz: TZ });
    expect(again.created).toBe(true);
    expect(again.coach.id).not.toBe(coach.id);
    expect(again.coach.hours).toEqual(presetHours("mornings"));
  });

  it("refuses while a lesson is still to come, so the student is told first", async () => {
    const { owner, coach, student } = await aBook("Ana");
    await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: at(2), byCoach: false }, DAY_BEFORE);
    await expect(deleteCoachBook(db, { coachId: coach.id, actorPlayerId: owner.id }, DAY_BEFORE)).rejects.toThrow(/has_lessons/);
    // And the book is still there: a refusal changes nothing.
    expect(await getCoachByPlayerId(db, owner.id)).not.toBeNull();
  });

  it("goes when the account goes, and the student hears about the hour they were expecting", async () => {
    const { owner, coach, student } = await aBook("Dee");
    await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: at(2), byCoach: false }, DAY_BEFORE);

    // Deleting an account wiped the name, the email and the phone and left the coach page standing:
    // public, under the same name, with the clubs and the PromptPay id still on it.
    const r = await anonymizePlayer(db, owner.id, DAY_BEFORE);
    expect(await getCoachByHandle(db, coach.handle)).toBeNull();
    expect(await getCoachByPlayerId(db, owner.id)).toBeNull();
    // Unlike the coach closing it themselves, this cannot refuse — so the lesson is cancelled and
    // handed back for the student to be told, with the name they know rather than "Deleted player".
    expect(r.coachClosure?.coach.displayName).toBe("Dee");
    expect(r.coachClosure?.cancelled).toHaveLength(1);
    expect(r.coachClosure?.cancelled[0].student?.id).toBe(student.id);
  });

  it("stops running anyone else's lessons", async () => {
    const { coach } = await aBook("Eve");
    const helper = await makePlayer(db, "Helper");
    await db.insert(coachManagers).values({ coachId: coach.id, playerId: helper.id });

    await anonymizePlayer(db, helper.id, DAY_BEFORE);
    // An access grant is not history: the helper's own book is untouched, their key to Eve's is not.
    expect(await db.select().from(coachManagers).where(eq(coachManagers.playerId, helper.id))).toHaveLength(0);
    expect(await getCoachByHandle(db, coach.handle)).not.toBeNull();
  });

  it("belongs to the coach alone: nobody else may close it", async () => {
    const { coach, student } = await aBook("Bea");
    const stranger = await makePlayer(db, "Stranger");
    await expect(deleteCoachBook(db, { coachId: coach.id, actorPlayerId: student.id }, at(48))).rejects.toThrow(/forbidden/);
    await expect(deleteCoachBook(db, { coachId: coach.id, actorPlayerId: stranger.id }, at(48))).rejects.toThrow(/forbidden/);
    expect(await getCoachByHandle(db, coach.handle)).not.toBeNull();
  });
});
