import { describe, expect, it } from "vitest";
import { relativeTime } from "@/lib/dates";
import { freezeClock } from "./helpers/clock";

/**
 * The match page's "Starts in 2 days" counts calendar days in the match's own zone. Elapsed seconds
 * over 86,400 said "tomorrow" for a match two dates away whenever the hour now was later than the
 * start's: TDsv (Saturday 11:00 in Phuket) read "Starts tomorrow" all Thursday afternoon and evening
 * (15 October 2026).
 *
 * The match: Saturday 17 October 2026, 11:00 in Asia/Bangkok (UTC+7, no clock change), 04:00 UTC.
 *   Thu 15 Oct 21:44 Bangkok = 14:44 UTC  (1 day 13 h 16 min before; two dates away)
 *   Fri 16 Oct 10:00 Bangkok = 03:00 UTC  (25 h before; the next date)
 *   Fri 16 Oct 12:00 Bangkok = 05:00 UTC  (23 h before: under a day, so hours)
 *   Mon 19 Oct 09:00 Bangkok = 02:00 UTC  (1 day 22 h after; two dates back)
 */
const NOW = new Date("2026-10-15T14:44:00Z");
freezeClock(NOW);
const TZ = "Asia/Bangkok";
const START = new Date("2026-10-17T04:00:00Z");

describe("relativeTime with the match's zone counts calendar days", () => {
  it("Thursday 21:44 to Saturday 11:00 is in 2 days, where elapsed time said tomorrow", () => {
    expect(relativeTime(START, "en", NOW, TZ)).toBe("in 2 days");
    // Without a zone it stays elapsed time, as every caller but the match page has it.
    expect(relativeTime(START, "en", NOW)).toBe("tomorrow");
  });

  it("Friday 10:00 is tomorrow, and Friday 12:00 (under a day) is in 23 hours", () => {
    expect(relativeTime(START, "en", new Date("2026-10-16T03:00:00Z"), TZ)).toBe("tomorrow");
    expect(relativeTime(START, "en", new Date("2026-10-16T05:00:00Z"), TZ)).toBe("in 23 hours");
  });

  it("Monday 09:00 is 2 days ago, where elapsed time said yesterday", () => {
    expect(relativeTime(START, "en", new Date("2026-10-19T02:00:00Z"), TZ)).toBe("2 days ago");
    expect(relativeTime(START, "en", new Date("2026-10-19T02:00:00Z"))).toBe("yesterday");
  });

  it("speaks Russian and Spanish with their own words for two days away", () => {
    expect(relativeTime(START, "ru", NOW, TZ)).toBe("послезавтра");
    expect(relativeTime(START, "es", new Date("2026-10-19T02:00:00Z"), TZ)).toBe("anteayer");
  });

  it("a span of 24 hours or more inside one date, on the day the clocks go back, stays hours", () => {
    // Sunday 25 October 2026 in Madrid has 25 hours: 00:10 (CEST, UTC+2) to 23:50 (CET, UTC+1) is 24 h 40 min.
    expect(relativeTime(new Date("2026-10-25T22:50:00Z"), "en", new Date("2026-10-24T22:10:00Z"), "Europe/Madrid")).toBe("in 24 hours");
  });

  it("past 30 days it is months, zone or none", () => {
    expect(relativeTime(START, "en", new Date("2026-08-01T00:00:00Z"), TZ)).toBe("in 2 months");
  });
});
