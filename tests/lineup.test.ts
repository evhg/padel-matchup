import { describe, expect, it } from "vitest";
import { nextOccurrence, timePatternOf } from "@/lib/dates";
import { lineupComplete, withCompleteSuffix } from "@/lib/lineup";
import { personalEventPath } from "@/lib/personal";

const slot = (position: number, status: string) => ({ position, status }) as { position: number; status: "empty" | "joined" | "confirmed" | "invited" | "declined" };

describe("lineupComplete", () => {
  it("is complete only when every roster spot is joined or confirmed", () => {
    expect(lineupComplete([slot(1, "joined"), slot(2, "confirmed"), slot(3, "joined"), slot(4, "joined")], 4)).toBe(true);
    expect(lineupComplete([slot(1, "joined"), slot(2, "confirmed"), slot(3, "joined"), slot(4, "invited")], 4)).toBe(false);
    expect(lineupComplete([slot(1, "joined"), slot(2, "joined"), slot(3, "joined"), slot(4, "empty")], 4)).toBe(false);
    expect(lineupComplete([slot(1, "joined"), slot(2, "joined"), slot(3, "joined")], 4)).toBe(false);
  });
  it("ignores the waitlist", () => {
    expect(lineupComplete([slot(1, "joined"), slot(2, "joined"), slot(3, "joined"), slot(4, "joined"), slot(5, "joined")], 4)).toBe(true);
  });
  it("appends the suffix only when complete", () => {
    expect(withCompleteSuffix("Thursday padel · Club", true, "COMPLETE")).toBe("Thursday padel · Club - COMPLETE");
    expect(withCompleteSuffix("Thursday padel · Club", false, "COMPLETE")).toBe("Thursday padel · Club");
  });
});

describe("time patterns", () => {
  it("extracts weekday and wall time in the event zone", () => {
    // 2026-09-03 is a Thursday; 11:00Z = 18:00 in Bangkok
    expect(timePatternOf(new Date("2026-09-03T11:00:00Z"), "Asia/Bangkok")).toEqual({ dow: 4, time: "18:00" });
  });
  it("projects a pattern to its next occurrence, skipping today when too close", () => {
    const now = new Date("2026-09-03T10:00:00Z"); // Thu 17:00 Bangkok
    expect(nextOccurrence(4, "18:00", "Asia/Bangkok", now)).toEqual({ date: "2026-09-03", time: "18:00" }); // 60 min ahead → today
    expect(nextOccurrence(4, "17:15", "Asia/Bangkok", now)).toEqual({ date: "2026-09-10", time: "17:15" }); // 15 min ahead → next week
    expect(nextOccurrence(6, "10:00", "Asia/Bangkok", now)).toEqual({ date: "2026-09-05", time: "10:00" }); // Saturday
    expect(nextOccurrence(3, "20:00", "Asia/Bangkok", now)).toEqual({ date: "2026-09-09", time: "20:00" }); // Wednesday
  });
});

describe("personal event link", () => {
  it("nests the share code under the personal token", () => {
    expect(personalEventPath("abc", "PLAY")).toBe("/p/abc/PLAY");
  });
});
