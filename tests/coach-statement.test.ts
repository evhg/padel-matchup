import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { lessons } from "@/db/schema";
import { coachStatement, statementCsv, statementText, type StatementLabels } from "@/lib/coach/statement";
import { monthRange } from "@/lib/coach/chains";
import { compLesson, createCoach, createPackage, presetHours, setLessonPaid, setPackagePaid, setStudentStatus, updateCoach } from "@/lib/domain/coaching";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

/**
 * The month as an accountant wants it. Rows per student, the money split into paid and unpaid, the
 * lessons into done, missed, counted and given away; the file and the message from the same rows.
 */
const TZ = "Asia/Bangkok";
// September 2026 in Bangkok, seen from the morning of 1 October (rule 11: no "now").
const FIRST = new Date("2026-10-01T02:30:00Z");
const sep = monthRange(TZ, new Date("2026-09-15T05:00:00Z"));
const at = (day: number, hour: number) => new Date(Date.UTC(2026, 8, day, hour - 7));
const labels: StatementLabels = { student: "Student", done: "done", noShows: "no-show", late: "late", comped: "on me", lessonsPaid: "paid", lessonsUnpaid: "unpaid", packages: "packages", packagesPaid: "packages paid", packagesUnpaid: "packages unpaid", total: "Total" };

describe("the monthly statement", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  it("sums a coach's month per student, and renders the same rows as a file and as a message", async () => {
    const cp = await makePlayer(db, "Olga");
    const made = await createCoach(db, { playerId: cp.id, displayName: "Olga", tz: TZ, hours: presetHours("both") });
    const coach = await updateCoach(db, made.id, { priceSingle: 800 });
    const anna = await makePlayer(db, "Anna");
    const boris = await makePlayer(db, "Boris");
    for (const p of [anna, boris]) await setStudentStatus(db, coach.id, p.id, "accepted");
    // Anna: three lessons, one paid, one not, one on the house; a package bought and paid.
    const [a1] = await db.insert(lessons).values({ coachId: coach.id, studentPlayerId: anna.id, startsAt: at(2, 9), minutes: 60, status: "done", amount: 800 }).returning();
    await db.insert(lessons).values({ coachId: coach.id, studentPlayerId: anna.id, startsAt: at(9, 9), minutes: 60, status: "done", amount: 800 });
    const [a3] = await db.insert(lessons).values({ coachId: coach.id, studentPlayerId: anna.id, startsAt: at(16, 9), minutes: 60, status: "done", amount: 800 }).returning();
    await setLessonPaid(db, coach.id, a1.id, true);
    await compLesson(db, { lessonId: a3.id, coach, reason: "late" }, at(16, 12));
    const pkg = await createPackage(db, { coachId: coach.id, studentPlayerId: anna.id, size: 10, amount: 7000 }, at(20, 10));
    await setPackagePaid(db, coach.id, pkg.id, true);
    // Boris: a no-show and a late cancellation that counted, both unpaid; a package not yet paid.
    await db.insert(lessons).values({ coachId: coach.id, studentPlayerId: boris.id, startsAt: at(5, 15), minutes: 60, status: "no_show", amount: 800 });
    await db.insert(lessons).values({ coachId: coach.id, studentPlayerId: boris.id, startsAt: at(12, 15), minutes: 60, status: "late_cancelled", amount: 800 });
    await createPackage(db, { coachId: coach.id, studentPlayerId: boris.id, size: 5, amount: 3500 }, at(25, 10));
    // Out of the month: a lesson in October and one still to come never count.
    await db.insert(lessons).values({ coachId: coach.id, studentPlayerId: anna.id, startsAt: new Date(Date.UTC(2026, 9, 2, 2)), minutes: 60, status: "done", amount: 800 });
    await db.insert(lessons).values({ coachId: coach.id, studentPlayerId: anna.id, startsAt: at(28, 9), minutes: 60, status: "booked", amount: 800 });

    const st = await coachStatement(db, coach, sep.from, sep.to);
    expect(st.rows.map((r) => r.name)).toEqual(["Anna", "Boris"]);
    const [a, b] = st.rows;
    expect(a).toMatchObject({ done: 3, noShows: 0, lateCounted: 0, comped: 1, lessonsPaid: 800, lessonsUnpaid: 800, packagesBought: 1, packagesPaid: 7000, packagesUnpaid: 0 });
    expect(b).toMatchObject({ done: 0, noShows: 1, lateCounted: 1, comped: 0, lessonsPaid: 0, lessonsUnpaid: 1600, packagesBought: 1, packagesPaid: 0, packagesUnpaid: 3500 });
    expect(st.totals).toMatchObject({ done: 3, noShows: 1, lateCounted: 1, comped: 1, lessonsPaid: 800, lessonsUnpaid: 2400, packagesBought: 2, packagesPaid: 7000, packagesUnpaid: 3500 });

    const csv = statementCsv(st, labels);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("Student,done,no-show,late,on me,paid (THB),unpaid (THB),packages,packages paid (THB),packages unpaid (THB)");
    expect(lines[1]).toBe("Anna,3,0,0,1,800,800,1,7000,0");
    expect(lines[3]).toBe("Total,3,1,1,1,800,2400,2,7000,3500");

    const text = statementText(st, "September 2026", labels, (n) => `${n} THB`);
    expect(text).toContain("Anna: 3 done · 1 on me · 1 packages · paid 7800 THB · unpaid 800 THB");
    expect(text).toContain("Boris: 1 no-show · 1 late · 1 packages · unpaid 5100 THB");
    expect(text.endsWith("Total: 3 done · 1 no-show · 1 late · 1 on me · 2 packages · paid 7800 THB · unpaid 5900 THB")).toBe(true);
    void FIRST;
    void HOUR;
  });

  it("quotes a name with a comma in it, so the file still has ten columns", () => {
    const st = { currency: "THB", rows: [{ playerId: "x", name: 'Ana "la" Rey, jr', done: 1, noShows: 0, lateCounted: 0, comped: 0, lessonsPaid: 0, lessonsUnpaid: 800, packagesBought: 0, packagesPaid: 0, packagesUnpaid: 0 }], totals: { done: 1, noShows: 0, lateCounted: 0, comped: 0, lessonsPaid: 0, lessonsUnpaid: 800, packagesBought: 0, packagesPaid: 0, packagesUnpaid: 0 } };
    const line = statementCsv(st, labels).split("\n")[1];
    expect(line.startsWith('"Ana ""la"" Rey, jr",1,')).toBe(true);
  });
});
