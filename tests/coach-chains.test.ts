import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { coaches, lessonPackages, lessons, lessonWaitlist } from "@/db/schema";
import {
  acceptOffer,
  afterLessonFreed,
  alternativesFor,
  claimManager,
  decideRequest,
  joinWaitlist,
  lessonRemindersDue,
  listManagers,
  listOpenRequests,
  listWaitlist,
  lowPackageNoticesDue,
  managerCode,
  monthCounts,
  monthRange,
  OFFER_MINUTES,
  offerFreedSlot,
  removeManager,
  requestOrBook,
  tickWaitlist,
  weekStartOf,
  withdrawWaitlist,
} from "@/lib/coach/chains";
import { addStudentByName, availableSlots, bookLesson, cancelLesson, createCoach, createPackage, getCoachForActor, markNoShow, presetHours } from "@/lib/domain/coaching";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const TZ = "Asia/Bangkok";
// Monday 14 Sep 2026, 07:00 in Bangkok.
const monday07 = new Date("2026-09-14T00:00:00.000Z");
const MIN = 60_000;

async function freshCoach(name: string) {
  const cp = await makePlayer(db, name);
  const coach = await createCoach(db, { playerId: cp.id, displayName: name, tz: TZ, hours: presetHours("both") });
  return { coach, cp };
}

describe("weeks", () => {
  it("finds the Monday of a week in the coach's zone", () => {
    expect(weekStartOf(new Date("2026-09-16T10:00:00Z"), TZ)).toBe("2026-09-14");
    expect(weekStartOf(new Date("2026-09-13T18:30:00Z"), TZ)).toBe("2026-09-14"); // already Monday 01:30 in Bangkok
    expect(weekStartOf(new Date("2026-09-13T16:30:00Z"), TZ)).toBe("2026-09-07");
  });
  it("bounds the month in the coach's zone", () => {
    const { from, to, label } = monthRange(TZ, monday07);
    expect(label).toBe("2026-09");
    expect(from.toISOString()).toBe("2026-08-31T17:00:00.000Z");
    expect(to.toISOString()).toBe("2026-09-30T17:00:00.000Z");
  });
});

describe("waitlist and offers", () => {
  it("offers a freed slot to the first in line for thirty minutes, and books it on acceptance", async () => {
    const { coach } = await freshCoach("Wait");
    const anna = await addStudentByName(db, coach.id, "Anna", "en");
    const ben = await addStudentByName(db, coach.id, "Ben", "en");
    const cara = await addStudentByName(db, coach.id, "Cara", "en");
    const now = monday07;
    const free = await availableSlots(db, coach, now, new Date(now.getTime() + DAY), now);
    const slot = free[2];
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: slot, byCoach: false }, now);
    // Ben wants exactly that slot; Cara wants anything that week, and joined earlier.
    await joinWaitlist(db, coach, cara.id, { weekStart: weekStartOf(slot, TZ) }, new Date(now.getTime() - HOUR));
    const benEntry = await joinWaitlist(db, coach, ben.id, { slotStartsAt: slot }, now);
    expect((await joinWaitlist(db, coach, ben.id, { slotStartsAt: slot }, now)).id).toBe(benEntry.id); // idempotent
    expect((await listWaitlist(db, coach.id, now)).map((e) => e.player.displayName)).toEqual(["Cara", "Ben"]);

    // Nothing to offer while the slot is taken.
    expect(await offerFreedSlot(db, coach, slot, now)).toBeNull();

    // The coach cancels: Anna gets alternatives, the slot goes to Ben (exact slot beats the week).
    const t1 = new Date(now.getTime() + 10 * MIN);
    const { lesson: cancelled } = await cancelLesson(db, { lessonId: lesson.id, by: "coach", coach }, t1);
    const freed = await afterLessonFreed(db, coach, cancelled, "coach", t1);
    expect(freed.alternatives.length).toBeGreaterThan(0);
    expect(freed.alternatives.every((d) => d.getTime() > t1.getTime())).toBe(true);
    expect(freed.offer?.player.displayName).toBe("Ben");
    expect(freed.offer?.expiresAt.toISOString()).toBe(new Date(t1.getTime() + OFFER_MINUTES * MIN).toISOString());

    // Ben takes it.
    const t2 = new Date(t1.getTime() + 5 * MIN);
    const booked = await acceptOffer(db, coach, benEntry.id, ben.id, t2);
    expect(booked.lesson.startsAt.toISOString()).toBe(slot.toISOString());
    expect(booked.lesson.source).toBe("waitlist");
    const [entry] = await db.select().from(lessonWaitlist).where(eq(lessonWaitlist.id, benEntry.id));
    expect(entry.status).toBe("booked");
    expect(entry.offeredLessonId).toBe(booked.lesson.id);
    // Cara is still waiting for the week.
    expect((await listWaitlist(db, coach.id, t2)).map((e) => e.player.displayName)).toEqual(["Cara"]);
    // Accepting twice is refused.
    await expect(acceptOffer(db, coach, benEntry.id, ben.id, t2)).rejects.toThrow();
  });

  it("lets an offer lapse after thirty minutes and passes the slot down the line", async () => {
    const { coach } = await freshCoach("Lapse");
    const anna = await addStudentByName(db, coach.id, "Anna", "en");
    const ben = await addStudentByName(db, coach.id, "Ben", "en");
    const cara = await addStudentByName(db, coach.id, "Cara", "en");
    const now = monday07;
    const free = await availableSlots(db, coach, now, new Date(now.getTime() + DAY), now);
    const slot = free[3];
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: slot, byCoach: false }, now);
    await joinWaitlist(db, coach, ben.id, { slotStartsAt: slot }, now);
    await joinWaitlist(db, coach, cara.id, { slotStartsAt: slot }, new Date(now.getTime() + MIN));
    const { lesson: cancelled } = await cancelLesson(db, { lessonId: lesson.id, by: "student", coach, actorPlayerId: anna.id }, now);
    const freed = await afterLessonFreed(db, coach, cancelled, "student", now);
    expect(freed.alternatives).toEqual([]);
    expect(freed.offer?.player.displayName).toBe("Ben");
    // Ben never answers.
    const later = new Date(now.getTime() + (OFFER_MINUTES + 1) * MIN);
    const tick = await tickWaitlist(db, later);
    expect(tick.lapsed.map((l) => l.player?.displayName)).toEqual(["Ben"]);
    expect(tick.offers.map((o) => o.player.displayName)).toEqual(["Cara"]);
    expect(tick.offers[0].coach.id).toBe(coach.id);
    // A second tick has nothing to do.
    expect(await tickWaitlist(db, later)).toEqual({ lapsed: [], offers: [] });
    // Withdrawing works for the offered entry too.
    const caraEntry = tick.offers[0].entry;
    expect((await withdrawWaitlist(db, coach.id, caraEntry.id, cara.id, later))?.status).toBe("withdrawn");
    expect(await listWaitlist(db, coach.id, later)).toEqual([]);
  });

  it("never offers a student a time they already have a lesson at", async () => {
    const { coach } = await freshCoach("Clash");
    const anna = await addStudentByName(db, coach.id, "Anna", "en");
    const ben = await addStudentByName(db, coach.id, "Ben", "en");
    const now = monday07;
    const free = await availableSlots(db, coach, now, new Date(now.getTime() + DAY), now);
    const slot = free[2];
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: slot, byCoach: false }, now);
    await joinWaitlist(db, coach, ben.id, { weekStart: weekStartOf(slot, TZ) }, now);
    // Ben already has a lesson at that exact time with the same coach? Not possible (slot taken) — give him one overlapping via coach booking of a longer lesson is also blocked; so book Ben elsewhere and check the week offer still comes, then the exact-time clash path with a second coach.
    const other = await freshCoach("Other");
    await db.update(coaches).set({ hours: presetHours("both") }).where(eq(coaches.id, other.coach.id));
    await addStudentByName(db, other.coach.id, "x", "en");
    const [otherCoach] = await db.select().from(coaches).where(eq(coaches.id, other.coach.id));
    await bookLesson(db, { coach: otherCoach, studentPlayerId: ben.id, startsAt: slot, byCoach: true }, now);
    const { lesson: cancelled } = await cancelLesson(db, { lessonId: lesson.id, by: "coach", coach }, now);
    const freed = await afterLessonFreed(db, coach, cancelled, "coach", now);
    expect(freed.offer).toBeNull();
  });
});

describe("requests outside the hours", () => {
  it("books inside the rules, asks outside them, and the coach's yes books as the coach", async () => {
    const { coach } = await freshCoach("Req");
    const anna = await addStudentByName(db, coach.id, "Anna", "en");
    const now = monday07;
    const free = await availableSlots(db, coach, now, new Date(now.getTime() + DAY), now);
    const inside = await requestOrBook(db, coach, anna.id, free[1], null, now);
    expect(inside.kind).toBe("booked");
    // 22:00 Bangkok is outside "both" hours.
    const late = new Date("2026-09-14T15:00:00.000Z");
    const asked = await requestOrBook(db, coach, anna.id, late, "after work?", now);
    expect(asked.kind).toBe("requested");
    if (asked.kind !== "requested") throw new Error("expected a request");
    expect(asked.request.note).toBe("after work?");
    expect((await requestOrBook(db, coach, anna.id, late, null, now)).kind).toBe("requested");
    expect((await listOpenRequests(db, coach.id, now)).map((r) => [r.player.displayName, r.id])).toEqual([["Anna", asked.request.id]]);
    const yes = await decideRequest(db, coach, asked.request.id, true, now);
    expect(yes.lesson?.startsAt.toISOString()).toBe(late.toISOString());
    expect(yes.lesson?.source).toBe("request");
    expect(yes.request.status).toBe("accepted");
    expect(await listOpenRequests(db, coach.id, now)).toEqual([]);
    await expect(decideRequest(db, coach, asked.request.id, true, now)).rejects.toThrow();
    // A no closes it without a lesson.
    const late2 = new Date("2026-09-15T15:00:00.000Z");
    const asked2 = await requestOrBook(db, coach, anna.id, late2, null, now);
    if (asked2.kind !== "requested") throw new Error("expected a request");
    const no = await decideRequest(db, coach, asked2.request.id, false, now);
    expect(no.lesson).toBeNull();
    expect(no.request.status).toBe("declined");
  });
});

describe("reminders", () => {
  it("sends one lesson reminder about twenty hours before, and none for a lesson booked inside that window", async () => {
    const { coach } = await freshCoach("Rem");
    const anna = await addStudentByName(db, coach.id, "Anna", "en");
    const ben = await addStudentByName(db, coach.id, "Ben", "en");
    const now = monday07;
    const free = await availableSlots(db, coach, now, new Date(now.getTime() + 3 * DAY), now);
    const wed = free.find((d) => d.getTime() > now.getTime() + 2 * DAY)!;
    await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: wed, byCoach: false }, now);
    expect(await lessonRemindersDue(db, new Date(wed.getTime() - 30 * HOUR))).toEqual([]);
    const due = await lessonRemindersDue(db, new Date(wed.getTime() - 19 * HOUR));
    expect(due.map((r) => r.student.displayName)).toEqual(["Anna"]);
    expect(await lessonRemindersDue(db, new Date(wed.getTime() - 18 * HOUR))).toEqual([]);
    // Ben books ten hours ahead: the booking is the reminder.
    const thu = free.find((d) => d.getTime() > wed.getTime() + 20 * HOUR)!;
    await bookLesson(db, { coach, studentPlayerId: ben.id, startsAt: thu, byCoach: false }, new Date(thu.getTime() - 10 * HOUR));
    expect(await lessonRemindersDue(db, new Date(thu.getTime() - 9 * HOUR))).toEqual([]);
    const [benLesson] = await db.select().from(lessons).where(eq(lessons.studentPlayerId, ben.id));
    expect(benLesson.remindedAt).not.toBeNull();
  });

  it("notes a nearly finished package once", async () => {
    const { coach } = await freshCoach("Low");
    const anna = await addStudentByName(db, coach.id, "Anna", "en");
    const fresh = await createPackage(db, { coachId: coach.id, studentPlayerId: anna.id, size: 10, used: 8 }, monday07);
    const due = await lowPackageNoticesDue(db, monday07);
    expect(due.map((d) => [d.student.displayName, d.left])).toEqual([["Anna", 2]]);
    expect(await lowPackageNoticesDue(db, monday07)).toEqual([]);
    const [row] = await db.select().from(lessonPackages).where(eq(lessonPackages.id, fresh.id));
    expect(row.lowRemindedAt).not.toBeNull();
    // An untouched small package is not "low".
    const ben = await addStudentByName(db, coach.id, "Ben", "en");
    await createPackage(db, { coachId: coach.id, studentPlayerId: ben.id, size: 2 }, monday07);
    expect(await lowPackageNoticesDue(db, monday07)).toEqual([]);
  });
});

describe("managers and the month", () => {
  it("hands out one link, lets a player claim it, and counts the month", async () => {
    const { coach } = await freshCoach("Mgr");
    const code = await managerCode(db, coach.id);
    expect(code).toMatch(/^[a-z0-9]{8}$/);
    expect(await managerCode(db, coach.id)).toBe(code);
    const wife = await makePlayer(db, "Wife");
    const claimed = await claimManager(db, code, wife.id);
    expect(claimed.id).toBe(coach.id);
    expect((await getCoachForActor(db, wife.id))?.role).toBe("manager");
    expect((await listManagers(db, coach.id)).map((p) => p.displayName)).toEqual(["Wife"]);
    await expect(claimManager(db, "nope1234", wife.id)).rejects.toThrow();
    const renewed = await managerCode(db, coach.id, true);
    expect(renewed).not.toBe(code);
    await expect(claimManager(db, code, wife.id)).rejects.toThrow();
    await removeManager(db, coach.id, wife.id);
    expect(await getCoachForActor(db, wife.id)).toBeNull();

    const anna = await addStudentByName(db, coach.id, "Anna", "en");
    const now = monday07;
    const free = await availableSlots(db, coach, now, new Date(now.getTime() + DAY), now);
    const a = await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: free[0], byCoach: true }, now);
    const b = await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: free[1], byCoach: true }, now);
    await db.update(lessons).set({ status: "done" }).where(eq(lessons.id, a.lesson.id));
    await markNoShow(db, coach.id, b.lesson.id);
    const { from, to } = monthRange(TZ, now);
    const counts = await monthCounts(db, coach.id, from, to);
    expect(counts.done).toBe(1);
    expect(counts.noShows).toBe(1);
    expect(counts.perStudent).toEqual([{ playerId: anna.id, done: 1, noShows: 1 }]);
  });
});
