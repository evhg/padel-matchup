import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { activePackage, addStudentByName, bookLesson, cancelLesson, completePastLessons, createCoach, createPackage, foundingPlaces, getCoachByHandle, getCoachForActor, handleFromName, insertCoach, isCoachActor, isFoundingCoach, listCoachLessons, listStudentLessons, listStudents, lowPackages, openSlots, packageLine, parseHoursLine, presetHours, requestStudent, setStudentStatus, studentCoaches, studentStatus, updateCoach, withinHours } from "@/lib/domain/coaching";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const TZ = "Asia/Bangkok";
// A Monday 07:00 in Bangkok, as UTC.
const monday07 = new Date("2026-09-14T00:00:00.000Z");
const at = (hoursFrom07: number) => new Date(monday07.getTime() + hoursFrom07 * HOUR);

describe("coach handles and hours", () => {
  it("makes a handle from any name, transliterating Cyrillic", () => {
    expect(handleFromName("Benji")).toBe("benji");
    expect(handleFromName("Даниил Петров")).toBe("daniil-petrov");
    expect(handleFromName("Ana María")).toBe("ana-maria");
    expect(handleFromName("  ")).toBe("coach");
    expect(handleFromName("Ж")).toBe("zh");
  });

  it("parses the hours a coach types", () => {
    expect(parseHoursLine("07:00-12:00, 15:00-20:00")).toEqual([
      ["07:00", "12:00"],
      ["15:00", "20:00"],
    ]);
    expect(parseHoursLine("7-12")).toEqual([["07:00", "12:00"]]);
    expect(parseHoursLine("15:00 to 20:00")).toEqual([["15:00", "20:00"]]);
    expect(parseHoursLine("off")).toEqual([]);
    expect(parseHoursLine("")).toEqual([]);
    expect(parseHoursLine("12:00-07:00")).toBeNull();
    expect(parseHoursLine("07:00-12:00, 11:00-13:00")).toBeNull();
    expect(parseHoursLine("morning")).toBeNull();
    expect(Object.keys(presetHours("both"))).toHaveLength(7);
  });

  it("offers slots on the lesson grid, minus busy time and short notice", () => {
    const coach = { hours: presetHours("mornings"), tz: TZ, lessonMinutes: 60, minNoticeHours: 2 };
    const dayBefore = new Date(monday07.getTime() - DAY);
    const slots = openSlots({ coach, from: monday07, to: at(23), busy: [], now: dayBefore });
    expect(slots.map((s) => s.toISOString())).toEqual([0, 1, 2, 3, 4].map((h) => at(h).toISOString()));
    const withBusy = openSlots({ coach, from: monday07, to: at(23), busy: [{ startsAt: at(1), endsAt: at(2) }], now: dayBefore });
    expect(withBusy).toHaveLength(4);
    const lateNow = openSlots({ coach, from: monday07, to: at(23), busy: [], now: new Date(monday07.getTime() - 30 * 60_000) });
    expect(lateNow.map((s) => s.toISOString())).toEqual([2, 3, 4].map((h) => at(h).toISOString()));
    const ninety = openSlots({ coach: { ...coach, lessonMinutes: 90 }, from: monday07, to: at(23), busy: [], now: dayBefore });
    expect(ninety).toHaveLength(3);
    expect(withinHours(coach, at(4), 60)).toBe(true);
    expect(withinHours(coach, at(4), 90)).toBe(false);
    expect(withinHours(coach, at(9), 60)).toBe(false);
  });
});

describe("a coach's book", () => {
  it("creates a coach once per player with a unique handle", async () => {
    const p1 = await makePlayer(db, "Benji");
    const p2 = await makePlayer(db, "Benji");
    const c1 = await createCoach(db, { playerId: p1.id, displayName: "Benji", tz: TZ, clubNames: "Warehaus, Warehaus" });
    const c2 = await createCoach(db, { playerId: p2.id, displayName: "Benji", tz: TZ });
    expect(c1.handle).toBe("benji");
    expect(c2.handle).toBe("benji-2");
    expect(c1.clubNames).toEqual(["Warehaus"]);
    expect((await createCoach(db, { playerId: p1.id, displayName: "Other", tz: TZ })).id).toBe(c1.id);
    expect((await getCoachByHandle(db, "benji"))?.id).toBe(c1.id);
    expect(await getCoachByHandle(db, "Benji!")).toBeNull();
    expect(await isCoachActor(db, p1.id)).toBe(true);
    expect((await getCoachForActor(db, p1.id))?.role).toBe("coach");
    await expect(createCoach(db, { playerId: (await makePlayer(db, "X")).id, displayName: "X", tz: "Mars/Olympus" })).rejects.toMatchObject({ code: "invalid" });
    const updated = await updateCoach(db, c1.id, { cutoffHours: 500, whatsapp: "+66 89 999 9999", promptpayId: "089-999-9999", payLink: "not a link" });
    expect(updated.cutoffHours).toBe(72);
    expect(updated.whatsapp).toBe("66899999999");
    expect(updated.promptpayId).toBe("0899999999");
    expect(updated.payLink).toBeNull();
  });

  it("students request, the coach accepts, packages count down and the cancellation policy holds", async () => {
    const coachPlayer = await makePlayer(db, "Daniel");
    const coach = await createCoach(db, { playerId: coachPlayer.id, displayName: "Daniel", tz: TZ, hours: presetHours("mornings"), lessonMinutes: 60 });
    const anna = await makePlayer(db, "Anna");
    const now = new Date(monday07.getTime() - 3 * DAY);

    // Not a student yet: cannot book.
    await expect(bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(1), byCoach: false }, now)).rejects.toMatchObject({ code: "not_student" });
    expect(await requestStudent(db, coach.id, anna.id)).toBe("requested");
    expect(await requestStudent(db, coach.id, anna.id)).toBe("requested");
    expect(await studentStatus(db, coach.id, anna.id)).toBe("requested");
    await setStudentStatus(db, coach.id, anna.id, "accepted");

    // A package of ten, valid 90 days.
    const pkg = await createPackage(db, { coachId: coach.id, studentPlayerId: anna.id, size: 10, validDays: 90, amount: 6000 }, now);
    expect(packageLine(pkg, now)).toEqual({ left: 10, daysLeft: 90, expired: false });

    // Booking inside the hours draws one lesson from the package.
    const b1 = await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(1), byCoach: false }, now);
    expect(b1.lesson.consumed).toBe(true);
    expect(b1.package?.used).toBe(1);
    await expect(bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(1), byCoach: false }, now)).rejects.toMatchObject({ code: "slot_taken" });
    await expect(bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(1.5), byCoach: false }, now)).rejects.toMatchObject({ code: "slot_taken" });
    await expect(bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(9), byCoach: false }, now)).rejects.toMatchObject({ code: "outside_hours" });
    await expect(bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(2), byCoach: false }, new Date(at(2).getTime() - HOUR))).rejects.toMatchObject({ code: "too_soon" });
    await expect(bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(-80), byCoach: false }, now)).rejects.toMatchObject({ code: "past" });
    // The coach may book outside the hours.
    const b2 = await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(9), byCoach: true, source: "telegram" }, now);
    expect(b2.package?.used).toBe(2);

    // Timely cancellation by the student: refunded.
    const c1 = await cancelLesson(db, { lessonId: b1.lesson.id, by: "student", coach, actorPlayerId: anna.id }, now);
    expect(c1.outcome).toBe("refunded");
    expect(c1.lesson.status).toBe("cancelled_by_student");
    expect((await activePackage(db, coach.id, anna.id, now))?.used).toBe(1);
    await expect(cancelLesson(db, { lessonId: b1.lesson.id, by: "student", coach, actorPlayerId: anna.id }, now)).rejects.toMatchObject({ code: "cancelled" });

    // Late cancellation: the first uses the free pass, the second counts.
    const late = new Date(at(9).getTime() - 3 * HOUR);
    const c2 = await cancelLesson(db, { lessonId: b2.lesson.id, by: "student", coach, actorPlayerId: anna.id }, late);
    expect(c2.outcome).toBe("free_pass");
    expect(c2.lesson.status).toBe("late_cancelled");
    expect(c2.lesson.freePass).toBe(true);
    expect((await activePackage(db, coach.id, anna.id, now))?.used).toBe(0);
    const b3 = await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(3), byCoach: false }, now);
    const c3 = await cancelLesson(db, { lessonId: b3.lesson.id, by: "student", coach, actorPlayerId: anna.id }, new Date(at(3).getTime() - HOUR));
    expect(c3.outcome).toBe("counted");
    expect((await activePackage(db, coach.id, anna.id, now))?.used).toBe(1);
    // Someone else cannot cancel Anna's lesson.
    const b4 = await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(4), byCoach: false }, now);
    const other = await makePlayer(db, "Other");
    await expect(cancelLesson(db, { lessonId: b4.lesson.id, by: "student", coach, actorPlayerId: other.id }, now)).rejects.toMatchObject({ code: "forbidden" });
    // The coach cancels: never counts.
    const c4 = await cancelLesson(db, { lessonId: b4.lesson.id, by: "coach", coach }, late);
    expect(c4.outcome).toBe("refunded");
    expect(c4.lesson.status).toBe("cancelled");
    expect((await activePackage(db, coach.id, anna.id, now))?.used).toBe(1);

    // Lists.
    const students = await listStudents(db, coach.id, now);
    expect(students.map((s) => s.player.displayName)).toEqual(["Anna"]);
    expect(students[0].activePackage?.id).toBe(pkg.id);
    const mine = await studentCoaches(db, anna.id, now);
    expect(mine[0].coach.id).toBe(coach.id);
    expect(mine[0].status).toBe("accepted");
    expect(mine[0].activePackage?.used).toBe(1);

    // Time passes: booked lessons become done; the student sees them; low packages surface.
    const b5 = await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(2), byCoach: false }, now);
    expect(await completePastLessons(db, at(3.5))).toBe(1);
    const dayLessons = await listCoachLessons(db, coach.id, monday07, at(23));
    expect(dayLessons.find((l) => l.id === b5.lesson.id)?.status).toBe("done");
    expect((await listStudents(db, coach.id, now))[0].lessonsDone).toBe(1);
    expect((await listStudentLessons(db, anna.id, monday07)).map((l) => l.id)).toContain(b5.lesson.id);
    const small = await createPackage(db, { coachId: coach.id, studentPlayerId: (await addStudentByName(db, coach.id, "Igor", "ru")).id, size: 2, validDays: 5 }, now);
    const low = await lowPackages(db, coach.id, now);
    expect(low.map((l) => l.pkg.id)).toContain(small.id);
    expect(low.map((l) => l.pkg.id)).not.toContain(pkg.id);
  });

  it("draws from the package that expires first and skips expired ones", async () => {
    const coachPlayer = await makePlayer(db, "Coach3");
    const coach = await createCoach(db, { playerId: coachPlayer.id, displayName: "Coach Three", tz: TZ });
    const s = await addStudentByName(db, coach.id, "Sam", "en");
    const now = new Date(monday07.getTime() - DAY);
    const expired = await createPackage(db, { coachId: coach.id, studentPlayerId: s.id, size: 5, expiresAt: new Date(now.getTime() - DAY) }, now);
    const later = await createPackage(db, { coachId: coach.id, studentPlayerId: s.id, size: 5, validDays: 60 }, now);
    const soon = await createPackage(db, { coachId: coach.id, studentPlayerId: s.id, size: 5, validDays: 10 }, now);
    expect((await activePackage(db, coach.id, s.id, now))?.id).toBe(soon.id);
    expect(packageLine(expired, now).expired).toBe(true);
    expect(later.expiresAt!.getTime()).toBeGreaterThan(soon.expiresAt!.getTime());
  });

  it("founding places: the first ten listed in a city keep them, a later coach never earns one by relisting", async () => {
    const tz = "Pacific/Auckland";
    const made = [];
    for (let i = 0; i < 11; i++) {
      const p = await makePlayer(db, `Founder ${i}`);
      made.push(await createCoach(db, { playerId: p.id, displayName: `F${i}`, tz, clubNames: "Bay Padel" }));
    }
    expect(made.slice(0, 10).every((c) => c.foundingAt !== null && isFoundingCoach(c))).toBe(true);
    expect(made[10].foundingAt).toBeNull();
    expect(isFoundingCoach(made[10])).toBe(false);
    // The tenth unlists and relists: the place was earned and stays. The eleventh unlists and relists: still no place, the city is full.
    const tenth = await updateCoach(db, made[9].id, { isPublic: false });
    expect(isFoundingCoach(tenth)).toBe(false);
    expect(tenth.foundingAt).not.toBeNull();
    expect(isFoundingCoach(await updateCoach(db, made[9].id, { isPublic: true }))).toBe(true);
    await updateCoach(db, made[10].id, { isPublic: false });
    expect((await updateCoach(db, made[10].id, { isPublic: true })).foundingAt).toBeNull();
    // While a founder is unlisted the city still has no place left: a twelfth coach earns none either.
    await updateCoach(db, made[0].id, { isPublic: false });
    const twelfth = await createCoach(db, { playerId: (await makePlayer(db, "Founder 12")).id, displayName: "F12", tz, clubNames: "Bay Padel" });
    expect(twelfth.foundingAt).toBeNull();
    expect(await foundingPlaces(db, tz)).toBe(10);
    // A founder who moves city does not carry the badge; back home it shows again.
    const moved = await updateCoach(db, made[1].id, { tz: "Pacific/Fiji" });
    expect(moved.foundingAt).not.toBeNull();
    expect(isFoundingCoach(moved)).toBe(false);
    expect(isFoundingCoach(await updateCoach(db, made[1].id, { tz }))).toBe(true);
    // Two submits for one player make one book, and only the first says it was created.
    const p = await makePlayer(db, "Twice");
    const first = await insertCoach(db, { playerId: p.id, displayName: "Twice", tz, clubNames: "Bay Padel" });
    const second = await insertCoach(db, { playerId: p.id, displayName: "Twice", tz, clubNames: "Bay Padel" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.coach.id).toBe(first.coach.id);
  });
});
