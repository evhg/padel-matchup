import { describe, expect, it } from "vitest";
import { freezeClock } from "./helpers/clock";
import { matchStudent, parseCoachLine, parseStudentLine } from "@/lib/coach/assistant";

const TZ = "Asia/Bangkok";
// Tuesday 8 September 2026, 10:00 in Bangkok.
const now = new Date("2026-09-08T03:00:00.000Z");
freezeClock(now);
const students = [
  { id: "a", name: "Anna" },
  { id: "b", name: "Anton" },
  { id: "i", name: "Игорь" },
  { id: "m", name: "María José" },
];
const ctx = { now, tz: TZ, students };
const bkk = (day: string, time: string) => new Date(`${day}T${time}:00+07:00`).toISOString();

describe("the courtside assistant understands one line", () => {
  it("books a named student on a weekday and time, in any order and language", () => {
    const a = parseCoachLine("anna fri 15", ctx);
    expect(a.kind).toBe("book");
    if (a.kind === "book") {
      expect(a.student).toEqual({ kind: "one", student: students[0] });
      expect(a.day).toBe("2026-09-11");
      expect(a.startsAt.toISOString()).toBe(bkk("2026-09-11", "15:00"));
    }
    const b = parseCoachLine("пт 15:30 игорь", ctx);
    expect(b.kind === "book" && b.student.kind === "one" && b.student.student.id).toBe("i");
    const c = parseCoachLine("maria vie 9:00", ctx);
    expect(c.kind === "book" && c.student.kind === "one" && c.student.student.id).toBe("m");
    const d = parseCoachLine("Anna tomorrow 4pm", ctx);
    expect(d.kind === "book" && d.startsAt.toISOString()).toBe(bkk("2026-09-09", "16:00"));
    const e = parseCoachLine("anna 12.09 10", ctx);
    expect(e.kind === "book" && e.day).toBe("2026-09-12");
  });

  it("rolls a bare time that already passed to tomorrow, and reads small numbers as afternoon", () => {
    const past = parseCoachLine("anna 9", ctx);
    expect(past.kind === "book" && past.day).toBe("2026-09-09");
    const later = parseCoachLine("anna 3", ctx);
    expect(later.kind === "book" && later.startsAt.toISOString()).toBe(bkk("2026-09-08", "15:00"));
  });

  it("asks when a name is ambiguous, and treats an unknown name as a new student", () => {
    const amb = parseCoachLine("an fri 15", ctx);
    expect(amb.kind === "book" && amb.student.kind).toBe("many");
    const fresh = parseCoachLine("Pedro fri 15", ctx);
    expect(fresh.kind === "book" && fresh.student).toEqual({ kind: "new", name: "Pedro" });
    expect(matchStudent("ИГОРЬ", students)).toEqual({ kind: "one", student: students[2] });
    expect(matchStudent("jose", students)).toEqual({ kind: "one", student: students[3] });
  });

  it("cancels, blocks, starts packages, lists the day and the low packages", () => {
    const cancel = parseCoachLine("cancel anna fri", ctx);
    expect(cancel).toMatchObject({ kind: "cancel", day: "2026-09-11", time: null });
    expect(cancel.kind === "cancel" && cancel.student?.kind).toBe("one");
    const block = parseCoachLine("block sat", ctx);
    expect(block.kind === "block" && block.day).toBe("2026-09-12");
    const range = parseCoachLine("выходной пт 15-17", ctx);
    expect(range.kind === "block" && range.from.toISOString()).toBe(bkk("2026-09-11", "15:00"));
    expect(range.kind === "block" && range.to.toISOString()).toBe(bkk("2026-09-11", "17:00"));
    const pkg = parseCoachLine("anna +10 90d 6000", ctx);
    expect(pkg).toMatchObject({ kind: "package", size: 10, validDays: 90, amount: 6000 });
    const pkg2 = parseCoachLine("anna +10 6000฿ until 14.10", ctx);
    expect(pkg2.kind === "package" && pkg2.amount).toBe(6000);
    expect(pkg2.kind === "package" && pkg2.expiresAt?.toISOString().slice(0, 10)).toBe("2026-10-14");
    expect(parseCoachLine("today", ctx)).toEqual({ kind: "agenda", day: "2026-09-08" });
    expect(parseCoachLine("завтра", ctx)).toEqual({ kind: "agenda", day: "2026-09-09" });
    expect(parseCoachLine("week", ctx)).toEqual({ kind: "agenda", day: "week" });
    expect(parseCoachLine("who's low", ctx)).toEqual({ kind: "low" });
    expect(parseCoachLine("blah blah", ctx)).toEqual({ kind: "help" });
    expect(parseCoachLine("?", ctx)).toEqual({ kind: "help" });
  });

  it("understands a student's own lines", () => {
    expect(parseStudentLine("book fri 15", { now, tz: TZ })).toMatchObject({ kind: "book", day: "2026-09-11", time: "15:00" });
    expect(parseStudentLine("пятницу", { now, tz: TZ })).toMatchObject({ kind: "book", day: "2026-09-11", time: null });
    expect(parseStudentLine("cancel friday", { now, tz: TZ })).toMatchObject({ kind: "cancel", day: "2026-09-11" });
    expect(parseStudentLine("how many left", { now, tz: TZ })).toEqual({ kind: "left" });
    expect(parseStudentLine("осталось?", { now, tz: TZ })).toEqual({ kind: "left" });
    expect(parseStudentLine("lessons", { now, tz: TZ })).toEqual({ kind: "lessons" });
  });
});
