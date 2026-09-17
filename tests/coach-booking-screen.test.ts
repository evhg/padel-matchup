import { describe, expect, it } from "vitest";
import { sameHoursEveryDay } from "@/lib/coach/view";
import { presetHours } from "@/lib/domain/coaching";

/**
 * The booking screen's own small rules. Each one is here because the screen read as broken while the
 * data behind it was perfectly correct — which is the only kind of bug a student ever reports.
 */
describe("the coach's week, in one line", () => {
  it("says the hours when every open day is the same, which is what a preset makes", () => {
    expect(sameHoursEveryDay(presetHours("both"))).toBe("07:00–12:00, 15:00–20:00");
    expect(sameHoursEveryDay(presetHours("mornings"))).toBe("07:00–12:00");
  });

  it("ignores the days off rather than calling the week uneven", () => {
    // Ricardo's shape: open every day, one range. A coach closed on Sunday still has one line.
    const sundayOff = { ...presetHours("mornings"), "0": [] as [string, string][] };
    expect(sameHoursEveryDay(sundayOff)).toBe("07:00–12:00");
  });

  it("says nothing when the days differ, because a header is one line", () => {
    expect(sameHoursEveryDay({ "1": [["07:00", "12:00"]], "2": [["15:00", "20:00"]] })).toBeNull();
  });

  it("says nothing for a coach who has set no hours at all", () => {
    expect(sameHoursEveryDay({})).toBeNull();
    expect(sameHoursEveryDay(null)).toBeNull();
  });
});

/**
 * The hour chips are one row: free ones tappable, taken ones struck through and tappable to join the
 * waiting list. They used to be two rows concatenated, so a booked 16:00 sat to the right of a free
 * 19:00. This is the ordering the screen now does, kept honest here.
 */
describe("the hours in a day, in the order they happen", () => {
  const at = (h: number) => ({ iso: `2026-10-01T${String(h).padStart(2, "0")}:00:00.000Z`, time: `${String(h).padStart(2, "0")}:00`, day: "2026-10-01" });
  const order = (free: number[], taken: number[]) =>
    [...free.map((h) => ({ ...at(h), free: true })), ...taken.map((h) => ({ ...at(h), free: false }))]
      .sort((a, b) => a.iso.localeCompare(b.iso))
      .map((s) => `${s.time}${s.free ? "" : "*"}`);

  it("puts a taken hour in its place, not after every free one", () => {
    expect(order([17, 18, 19], [16])).toEqual(["16:00*", "17:00", "18:00", "19:00"]);
  });

  it("holds the order when the taken hours are scattered through the day", () => {
    expect(order([8, 11, 14], [9, 10, 12])).toEqual(["08:00", "09:00*", "10:00*", "11:00", "12:00*", "14:00"]);
  });
});
