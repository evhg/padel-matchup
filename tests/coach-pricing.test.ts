import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { attachSlip, bookLesson, compLesson, createCoach, createPackage, getSlip, MAX_HEADS, owedBy, presetHours, priceFor, setLessonPaid, setStudentStatus, updateCoach } from "@/lib/domain/coaching";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

/**
 * What a lesson costs, and what it costs when the coach gives it away.
 *
 * The number a coach sets is what **each person** pays, never the court total. That keeps one debt per
 * student on every screen the book already has, and it means nobody divides 1200 by three.
 */
describe("what one person pays", () => {
  const coach = { priceSingle: 800, priceTwo: 500, priceThree: 400, priceFour: 350 };

  it("reads the price for the size of the group", () => {
    expect(priceFor(coach, 1)).toBe(800);
    expect(priceFor(coach, 2)).toBe(500);
    expect(priceFor(coach, 3)).toBe(400);
    expect(priceFor(coach, MAX_HEADS)).toBe(350);
  });

  it("falls back down the ladder, so a coach who set one number keeps working", () => {
    const only = { priceSingle: 800, priceTwo: null, priceThree: null, priceFour: null };
    expect(priceFor(only, 4)).toBe(800);
    // A pair price and nothing else: three and four are charged the pair price, never nothing.
    const pair = { priceSingle: 800, priceTwo: 500, priceThree: null, priceFour: null };
    expect(priceFor(pair, 3)).toBe(500);
    expect(priceFor(pair, 4)).toBe(500);
  });

  it("says nothing for a coach who sells packages only", () => {
    expect(priceFor({ priceSingle: null, priceTwo: null, priceThree: null, priceFour: null }, 2)).toBeNull();
  });

  it("treats a head count outside the court as the nearest one inside it", () => {
    expect(priceFor(coach, 0)).toBe(800);
    expect(priceFor(coach, 9)).toBe(350);
  });
});

describe("a lesson's price, and the coach giving it away", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const pair = async (name: string, prices: { priceSingle?: number | null; priceTwo?: number | null } = {}) => {
    const cp = await makePlayer(db, `${name}Coach`);
    const made = await createCoach(db, { playerId: cp.id, displayName: `${name}Coach`, tz: "Asia/Bangkok", hours: presetHours("both") });
    // The prices are set through the patch, because that is the only door the screens have either.
    const coach = await updateCoach(db, made.id, { priceSingle: prices.priceSingle ?? 800, priceTwo: prices.priceTwo ?? null });
    const student = await makePlayer(db, name);
    await setStudentStatus(db, coach.id, student.id, "accepted");
    return { coach, student };
  };

  it("charges the group price per head when the coach says how many came", async () => {
    const { coach, student } = await pair("Ida", { priceTwo: 500 });
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: new Date(Date.now() + HOUR), byCoach: true, heads: 2 });
    expect(lesson.heads).toBe(2);
    expect(lesson.amount).toBe(500);
    expect((await owedBy(db, coach, student.id)).total).toBe(500);
  });

  it("zeroes a priced lesson and takes it off what the student owes", async () => {
    const { coach, student } = await pair("Jon");
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: new Date(Date.now() + HOUR), byCoach: true });
    expect((await owedBy(db, coach, student.id)).total).toBe(800);
    const comped = await compLesson(db, { lessonId: lesson.id, coach, reason: "Sorry I was late" });
    expect(comped.amount).toBe(0);
    expect(comped.compReason).toBe("Sorry I was late");
    expect((await owedBy(db, coach, student.id)).total).toBe(0);
  });

  it("gives a package lesson back rather than zeroing a number nobody sees", async () => {
    const { coach, student } = await pair("Kim");
    await createPackage(db, { coachId: coach.id, studentPlayerId: student.id, size: 10 });
    const { lesson, package: pkg } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: new Date(Date.now() + HOUR), byCoach: true });
    expect(pkg?.used).toBe(1);
    expect(lesson.consumed).toBe(true);
    await compLesson(db, { lessonId: lesson.id, coach });
    const [after] = await db.query.lessonPackages.findMany({ where: (p, { eq }) => eq(p.id, pkg!.id) });
    expect(after.used).toBe(0);
  });

  it("is not a second refund when the coach taps twice", async () => {
    const { coach, student } = await pair("Lia");
    await createPackage(db, { coachId: coach.id, studentPlayerId: student.id, size: 10 });
    const { lesson, package: pkg } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: new Date(Date.now() + HOUR), byCoach: true });
    await compLesson(db, { lessonId: lesson.id, coach, reason: "On me" });
    const second = await compLesson(db, { lessonId: lesson.id, coach, reason: "changed my mind" });
    expect(second.compReason).toBe("On me");
    const [after] = await db.query.lessonPackages.findMany({ where: (p, { eq }) => eq(p.id, pkg!.id) });
    expect(after.used).toBe(0);
  });

  it("refuses to give away a lesson the coach already marked paid: that is a refund, and refunds happen at the bank", async () => {
    const { coach, student } = await pair("Mia");
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: new Date(Date.now() + HOUR), byCoach: true });
    await setLessonPaid(db, coach.id, lesson.id, true);
    await expect(compLesson(db, { lessonId: lesson.id, coach, reason: "late" })).rejects.toMatchObject({ code: "already_paid" });
  });

  it("keeps a student's claim on the row when the coach comps over it, rather than losing it", async () => {
    const { coach, student } = await pair("Noa");
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: new Date(Date.now() + HOUR), byCoach: true });
    await attachSlip(db, lesson.id, student.id, "image/png", "iVBORw0KGgo=");
    const comped = await compLesson(db, { lessonId: lesson.id, coach, reason: "On me" });
    expect(comped.paidClaimedAt).not.toBeNull();
    expect(comped.slipAssetId).not.toBeNull();
  });
});

/** The bank slip: proof attached to the claim, seen by exactly the people it concerns. */
describe("the slip", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  const PNG = "iVBORw0KGgo=";

  const booked = async (name: string) => {
    const cp = await makePlayer(db, `${name}Coach`);
    const made = await createCoach(db, { playerId: cp.id, displayName: `${name}Coach`, tz: "Asia/Bangkok", hours: presetHours("both") });
    const coach = await updateCoach(db, made.id, { priceSingle: 800 });
    const student = await makePlayer(db, name);
    await setStudentStatus(db, coach.id, student.id, "accepted");
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: new Date(Date.now() + HOUR), byCoach: true });
    return { coach, coachPlayer: cp, student, lesson };
  };

  it("attaching one is the claim, and it shows on what is owed", async () => {
    const { coach, student, lesson } = await booked("Ola");
    const before = await owedBy(db, coach, student.id);
    expect(before.lessons[0]).toMatchObject({ claimedAt: null, hasSlip: false });
    const after = await attachSlip(db, lesson.id, student.id, "image/png", PNG);
    expect(after?.paidClaimedAt).not.toBeNull();
    expect((await owedBy(db, coach, student.id)).lessons[0]).toMatchObject({ hasSlip: true });
  });

  it("is read by the student who sent it and by the coach, and by nobody else", async () => {
    const { coachPlayer, student, lesson } = await booked("Pim");
    await attachSlip(db, lesson.id, student.id, "image/png", PNG);
    expect((await getSlip(db, lesson.id, student.id))?.mime).toBe("image/png");
    expect((await getSlip(db, lesson.id, coachPlayer.id))?.mime).toBe("image/png");
    const stranger = await makePlayer(db, "Stranger");
    expect(await getSlip(db, lesson.id, stranger.id)).toBeNull();
  });

  it("replaces an earlier slip rather than keeping two, and refuses one on a lesson already paid", async () => {
    const { coach, student, lesson } = await booked("Rui");
    const first = await attachSlip(db, lesson.id, student.id, "image/png", PNG);
    const second = await attachSlip(db, lesson.id, student.id, "image/jpeg", PNG);
    expect(second?.slipAssetId).not.toBe(first?.slipAssetId);
    expect((await getSlip(db, lesson.id, student.id))?.mime).toBe("image/jpeg");
    await setLessonPaid(db, coach.id, lesson.id, true);
    expect(await attachSlip(db, lesson.id, student.id, "image/png", PNG)).toBeNull();
  });

  it("refuses a picture that is not a picture, or one too big to be a screenshot", async () => {
    const { student, lesson } = await booked("Sol");
    await expect(attachSlip(db, lesson.id, student.id, "application/pdf", PNG)).rejects.toMatchObject({ code: "invalid" });
    await expect(attachSlip(db, lesson.id, student.id, "image/png", "A".repeat(900_000))).rejects.toMatchObject({ code: "invalid" });
  });
});
