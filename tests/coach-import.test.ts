import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { coachBlocks, coaches, lessonPackages } from "@/db/schema";
import { importPackages, parsePackageSheet, parseSheetDate, sheetCsvUrl, splitCells } from "@/lib/coach/import";
import { cleanCalendarSettings, setCoachCalendar } from "@/lib/coach/sync";
import { addStudentByName, createCoach, listStudents, packageLine } from "@/lib/domain/coaching";
import { createTestDb, makePlayer } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const now = new Date("2026-09-08T05:00:00.000Z");

describe("sheet parsing", () => {
  it("splits tabs, commas with quotes, and semicolons", () => {
    expect(splitCells("Anna\t10\t4")).toEqual(["Anna", "10", "4"]);
    expect(splitCells('"Smith, Anna",10,4')).toEqual(["Smith, Anna", "10", "4"]);
    expect(splitCells("Anna;10;4")).toEqual(["Anna", "10", "4"]);
  });

  it("reads dates the way people type them", () => {
    expect(parseSheetDate("2026-12-01", now)).toBe("2026-12-01");
    expect(parseSheetDate("1/12/2026", now)).toBe("2026-12-01");
    expect(parseSheetDate("01.12.26", now)).toBe("2026-12-01");
    expect(parseSheetDate("1 Dec 2026", now)).toBe("2026-12-01");
    expect(parseSheetDate("15 ноя", now)).toBe("2026-11-15");
    expect(parseSheetDate("31/02/2026", now)).toBeNull();
    expect(parseSheetDate("10", now)).toBeNull();
  });

  it("reads a sheet with a header in any column order", () => {
    const text = ["Student,Paid,Expires,Lessons,Used,Price,Email", "Anna,yes,2026-12-01,10,4,4500,anna@example.com", "Ben,no,15/11/2026,20,12,8000,", "Chris,,,,5,,", "Dana,paid,,50,0,18000,"].join("\n");
    const { rows, skipped } = parsePackageSheet(text, now);
    expect(skipped).toBe(1);
    expect(rows.map((r) => [r.name, r.size, r.used, r.expires, r.amount, r.paid, r.email])).toEqual([
      ["Anna", 10, 4, "2026-12-01", 4500, true, "anna@example.com"],
      ["Ben", 20, 12, "2026-11-15", 8000, false, null],
      ["Dana", 50, 0, null, 18000, true, null],
    ]);
  });

  it("reads a header that counts what is left, in Russian", () => {
    const { rows } = parsePackageSheet("Имя\tПакет\tОсталось\tСрок\nАнна\t10\t6\t01.12.2026", now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Анна", size: 10, used: 4, expires: "2026-12-01", paid: true });
  });

  it("reads bare rows without a header, including 4/10 shapes and prices", () => {
    const text = ["Anna\t4/10\t1 Dec 2026\tpaid", "Ben 20 12", "Anna Smith 10 4 used 2026-12-01", 'Carla,10,"฿4,500",unpaid', "just words here", ""].join("\n");
    const { rows, skipped } = parsePackageSheet(text, now);
    expect(skipped).toBe(1);
    expect(rows[0]).toMatchObject({ name: "Anna", size: 10, used: 4, expires: "2026-12-01", paid: true });
    expect(rows[1]).toMatchObject({ name: "Ben", size: 20, used: 12 });
    expect(rows[2]).toMatchObject({ name: "Anna Smith", size: 10, used: 4, expires: "2026-12-01" });
    expect(rows[3]).toMatchObject({ name: "Carla", size: 10, used: 0, amount: 4500, paid: false });
  });

  it("turns a Google Sheet link into its CSV export", () => {
    expect(sheetCsvUrl("https://docs.google.com/spreadsheets/d/1AbC_dEf-9/edit#gid=123")).toBe("https://docs.google.com/spreadsheets/d/1AbC_dEf-9/export?format=csv&gid=123");
    expect(sheetCsvUrl("https://docs.google.com/spreadsheets/d/1AbC/edit?usp=sharing")).toBe("https://docs.google.com/spreadsheets/d/1AbC/export?format=csv&gid=0");
    expect(sheetCsvUrl("https://example.com/list.csv")).toBe("https://example.com/list.csv");
    expect(sheetCsvUrl("https://example.com/page")).toBeNull();
  });
});

describe("importing packages", () => {
  it("reuses students by name, creates the rest, and writes packages with what was already used", async () => {
    const cp = await makePlayer(db, "Coach Imp");
    const coach = await createCoach(db, { playerId: cp.id, displayName: "Imp", tz: "Asia/Bangkok" });
    const anna = await addStudentByName(db, coach.id, "Anna", "en");
    const { rows } = parsePackageSheet("Name,Lessons,Used,Expires,Paid\nanna,10,4,2026-12-01,yes\nBen,20,12,,no", now);
    const out = await importPackages(db, coach, rows, "en", now);
    expect(out).toEqual({ created: 2, newStudents: 1, matched: 1 });
    const students = await listStudents(db, coach.id, now);
    expect(students.map((s) => s.player.displayName).sort()).toEqual(["Anna", "Ben"]);
    const annaRow = students.find((s) => s.player.id === anna.id)!;
    expect(annaRow.activePackage && packageLine(annaRow.activePackage, now).left).toBe(6);
    expect(annaRow.activePackage?.expiresAt?.toISOString()).toBe("2026-12-01T23:59:59.000Z");
    const [benPkg] = await db.select().from(lessonPackages).where(eq(lessonPackages.studentPlayerId, students.find((s) => s.player.displayName === "Ben")!.player.id));
    expect(benPkg.used).toBe(12);
    expect(benPkg.paidAt).toBeNull();
    expect(benPkg.note).toBe("sheet");
  });
});

describe("calendar settings", () => {
  it("cleans addresses and links, and clears old busy time when detached", async () => {
    expect(cleanCalendarSettings({ gcalId: " Coach@Gmail.com ", icalUrl: "webcal://p.example.com/x.ics" })).toEqual({ gcalId: "coach@gmail.com", icalUrl: "https://p.example.com/x.ics" });
    expect(cleanCalendarSettings({ gcalId: "not an address", icalUrl: "ftp://x" })).toEqual({ gcalId: null, icalUrl: null });
    const cp = await makePlayer(db, "Coach Cal2");
    const coach = await createCoach(db, { playerId: cp.id, displayName: "Cal2", tz: "Asia/Bangkok" });
    await setCoachCalendar(db, coach.id, { gcalId: "cal2@example.com", icalUrl: null });
    await db.insert(coachBlocks).values({ coachId: coach.id, startsAt: now, endsAt: new Date(now.getTime() + 3600_000), reason: "x", source: "gcal", externalId: "e1" });
    let [row] = await db.select().from(coaches).where(eq(coaches.id, coach.id));
    expect(row.gcalStatus).toBe("pending");
    await setCoachCalendar(db, coach.id, { gcalId: null, icalUrl: null });
    [row] = await db.select().from(coaches).where(eq(coaches.id, coach.id));
    expect(row.gcalId).toBeNull();
    expect(row.gcalStatus).toBeNull();
    expect(await db.select().from(coachBlocks).where(eq(coachBlocks.coachId, coach.id))).toHaveLength(0);
  });
});
