import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { activePackage, bookLesson, createCoach, createPackage, listOffers, MAX_OFFERS, openHour, outsideHoursFee, owedBy, presetHours, priceFor, saveOffers, setStudentStatus, takeOffer, updateCoach } from "@/lib/domain/coaching";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

/**
 * Benji's card at the desk: 60 and 90 minutes, each with a price for one and for a pair; ten-lesson
 * packages for one or for a pair; and 300 more for a lesson outside working hours. Every line of it
 * has to be sayable in the book, and then the book has to charge it.
 */
const TZ = "Asia/Bangkok";
// A Sunday 00:00 UTC; the "mornings" preset is 07:00–12:00 Bangkok = 00:00–05:00 UTC, Monday to Saturday (rule 11).
const sunday = new Date("2026-10-04T00:00:00.000Z");
const at = (hoursFromSundayUtc: number) => new Date(sunday.getTime() + hoursFromSundayUtc * HOUR);
// Monday 09:00 Bangkok: inside the hours. Monday 20:00 Bangkok: outside them.
const mondayInside = at(24 + 2);
const mondayOutside = at(24 + 13);

describe("a second length, and its price", () => {
  const coach = { priceSingle: 2800, priceTwo: 2000, priceThree: null, priceFour: null, secondMinutes: 90, priceSecondSingle: 4200, priceSecondTwo: 3000 };

  it("prices the second length by its own two rungs", () => {
    expect(priceFor(coach, 1, 90)).toBe(4200);
    expect(priceFor(coach, 2, 90)).toBe(3000);
    // Three and four at the long length fall back to the pair price, as the main ladder does.
    expect(priceFor(coach, 3, 90)).toBe(3000);
  });

  it("prices the usual length as before, whether or not the minutes are named", () => {
    expect(priceFor(coach, 1, 60)).toBe(2800);
    expect(priceFor(coach, 2)).toBe(2000);
    // A length the coach does not sell is priced as the usual one, never as nothing.
    expect(priceFor(coach, 1, 45)).toBe(2800);
  });

  it("says nothing for a long lesson when the coach set no long price", () => {
    expect(priceFor({ ...coach, priceSecondSingle: null, priceSecondTwo: null }, 1, 90)).toBeNull();
  });
});

describe("the extra outside the hours", () => {
  const hours = presetHours("mornings");
  it("is charged outside the weekly hours and not inside them, and is nothing when unset", () => {
    expect(outsideHoursFee({ hours, tz: TZ, outsideHoursFee: 300 }, mondayInside, 60)).toBe(0);
    expect(outsideHoursFee({ hours, tz: TZ, outsideHoursFee: 300 }, mondayOutside, 60)).toBe(300);
    expect(outsideHoursFee({ hours, tz: TZ, outsideHoursFee: null }, mondayOutside, 60)).toBe(0);
  });
});

describe("what a lesson costs, with Benji's card in the book", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const benji = async (name: string) => {
    const cp = await makePlayer(db, `${name}Coach`);
    const made = await createCoach(db, { playerId: cp.id, displayName: `${name}Coach`, tz: TZ, hours: presetHours("mornings") });
    const coach = await updateCoach(db, made.id, { priceSingle: 2800, priceTwo: 2000, secondMinutes: 90, priceSecondSingle: 4200, priceSecondTwo: 3000, outsideHoursFee: 300 });
    const student = await makePlayer(db, name);
    await setStudentStatus(db, coach.id, student.id, "accepted");
    return { coach, student };
  };

  it("charges the long price for a long lesson, per head", async () => {
    const { coach, student } = await benji("Ann");
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: mondayInside, byCoach: false, minutes: 90, heads: 2 }, sunday);
    expect(lesson.minutes).toBe(90);
    expect(lesson.amount).toBe(3000);
  });

  it("adds the extra to a lesson outside the hours, on top of the price", async () => {
    const { coach, student } = await benji("Bo");
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: mondayOutside, byCoach: true }, sunday);
    expect(lesson.amount).toBe(2800 + 300);
  });

  it("adds the extra to a package lesson too, which is then all the student owes for it", async () => {
    const { coach, student } = await benji("Cy");
    await createPackage(db, { coachId: coach.id, studentPlayerId: student.id, size: 10, amount: 25200 }, sunday);
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: mondayOutside, byCoach: true }, sunday);
    expect(lesson.consumed).toBe(true);
    expect(lesson.amount).toBe(300);
    // And an hour the coach opened on one date is outside the week as well: the extra applies there.
    await openHour(db, coach.id, at(24 + 14), 60);
    const { lesson: opened } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: at(24 + 14), byCoach: true }, sunday);
    expect(opened.amount).toBe(300);
    // Inside the hours a package lesson owes nothing, as before.
    const { lesson: inside } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: mondayInside, byCoach: true }, sunday);
    expect(inside.amount).toBeNull();
  });

  it("books a pair package's lessons as pairs, and as long as the package says", async () => {
    const { coach, student } = await benji("Di");
    await createPackage(db, { coachId: coach.id, studentPlayerId: student.id, size: 10, amount: 18000, heads: 2, minutes: 90 }, sunday);
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: mondayInside, byCoach: false }, sunday);
    expect(lesson.heads).toBe(2);
    expect(lesson.minutes).toBe(90);
    expect(lesson.consumed).toBe(true);
    expect(lesson.amount).toBeNull();
  });

  it("does not spend a long package on a lesson the student explicitly asked short", async () => {
    const { coach, student } = await benji("Ed");
    await createPackage(db, { coachId: coach.id, studentPlayerId: student.id, size: 10, amount: 36000, minutes: 90 }, sunday);
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: mondayInside, byCoach: false, minutes: 60 }, sunday);
    expect(lesson.consumed).toBe(false);
    expect(lesson.amount).toBe(2800);
  });
});

describe("the packages on the page", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const benji = async (name: string) => {
    const cp = await makePlayer(db, `${name}Coach`);
    const made = await createCoach(db, { playerId: cp.id, displayName: `${name}Coach`, tz: TZ, hours: presetHours("mornings") });
    const coach = await updateCoach(db, made.id, { priceSingle: 2800, currency: "THB" });
    const student = await makePlayer(db, name);
    await setStudentStatus(db, coach.id, student.id, "accepted");
    return { coach, student };
  };
  const ten = { size: 10, minutes: 60, heads: 1, price: 25200, validDays: 70 };
  const tenPair = { size: 10, minutes: 60, heads: 2, price: 18000, validDays: 70 };

  it("saves at most three, in the coach's order, and archives the ones taken off the list", async () => {
    const { coach } = await benji("Fay");
    const saved = await saveOffers(db, coach.id, [ten, tenPair], sunday);
    expect(saved.map((o) => o.price)).toEqual([25200, 18000]);
    // The pair one goes; the single one is edited in place and keeps its id.
    const again = await saveOffers(db, coach.id, [{ ...ten, id: saved[0].id, price: 26000 }], sunday);
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(saved[0].id);
    expect(again[0].price).toBe(26000);
    await expect(saveOffers(db, coach.id, [ten, ten, ten, ten], sunday)).rejects.toMatchObject({ code: "invalid" });
    expect(MAX_OFFERS).toBe(3);
  });

  it("refuses a row that is not a package before writing any of them", async () => {
    const { coach } = await benji("Gus");
    await expect(saveOffers(db, coach.id, [ten, { ...ten, price: 0 }], sunday)).rejects.toMatchObject({ code: "invalid" });
    expect(await listOffers(db, coach.id)).toHaveLength(0);
    await expect(saveOffers(db, coach.id, [{ ...ten, minutes: 50 }], sunday)).rejects.toMatchObject({ code: "invalid" });
  });

  it("starts an unpaid package at the offer's price when a student takes one, and what they owe says so", async () => {
    const { coach, student } = await benji("Hal");
    const [offer] = await saveOffers(db, coach.id, [tenPair], sunday);
    const { pkg } = await takeOffer(db, coach, student.id, offer.id, sunday);
    expect(pkg.size).toBe(10);
    expect(pkg.amount).toBe(18000);
    expect(pkg.heads).toBe(2);
    expect(pkg.minutes).toBe(60);
    expect(pkg.paidAt).toBeNull();
    expect(pkg.offerId).toBe(offer.id);
    expect(pkg.expiresAt?.getTime()).toBe(sunday.getTime() + 70 * 24 * HOUR);
    const owed = await owedBy(db, coach, student.id);
    expect(owed.total).toBe(18000);
    expect(owed.packages[0]?.size).toBe(10);
    // A second tap while lessons are left is the same tap twice.
    await expect(takeOffer(db, coach, student.id, offer.id, sunday)).rejects.toMatchObject({ code: "has_package" });
    expect((await activePackage(db, coach.id, student.id, sunday))?.id).toBe(pkg.id);
  });

  it("is only for a student on the list, and only for this coach's live offers", async () => {
    const { coach } = await benji("Ivo");
    const other = await benji("Jo");
    const [offer] = await saveOffers(db, coach.id, [ten], sunday);
    const stranger = await makePlayer(db, "Stranger");
    await expect(takeOffer(db, coach, stranger.id, offer.id, sunday)).rejects.toMatchObject({ code: "not_student" });
    await expect(takeOffer(db, other.coach, other.student.id, offer.id, sunday)).rejects.toMatchObject({ code: "not_found" });
    await saveOffers(db, coach.id, [], sunday);
    const { student } = { student: await makePlayer(db, "Kim") };
    await setStudentStatus(db, coach.id, student.id, "accepted");
    await expect(takeOffer(db, coach, student.id, offer.id, sunday)).rejects.toMatchObject({ code: "not_found" });
  });
});
