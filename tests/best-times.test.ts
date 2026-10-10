import { describe, expect, it } from "vitest";
import type { ClubAvailability, ClubFreeSlot } from "@/db/schema";
import { zonedTimeToUtc } from "@/lib/dates";
import { BEST_TIMES, bestTimes, freeAt, freeFeedOf, type FreeFeed } from "@/lib/domain/bestTimes";
import { freezeClock } from "./helpers/clock";

/**
 * The best times to play: free courts from the feeds clubs share, ranked for a person or a crew.
 * A free court at a usual club at a usual time comes first, then the soonest; one time per club and
 * day, so three chips are three choices and not three hours in a row.
 *
 * NOW is Saturday 10 October 2026, 05:00 UTC, which is 12:00 in Bangkok (UTC+7). Every hour below is
 * Bangkok's, and every date comes off NOW (rule 11). The cache holds several days, as a platform's
 * public free times do; a club's own feed read today holds today only:
 *   Sat 10  13:00 (one hour ahead: too soon), 15:00, 16:00
 *   Mon 12  10:00 (one hour only)
 *   Thu 15  18:00, 19:00, 20:00 (two courts at 19:00 and 20:00)
 *   Sat 17  08:00, 09:00, and 13:00 (past the seven days, which end at Sat 17 12:00)
 * Chalong, which the person never played at: Sun 11 09:00, 10:00 and Thu 15 19:00, 20:00.
 */
const NOW = new Date("2026-10-10T05:00:00Z");
freezeClock(NOW);
const TZ = "Asia/Bangkok";
const at = (date: string, time: string) => zonedTimeToUtc(date, time, TZ);
const hour = (date: string, time: string, free = 1): ClubFreeSlot => {
  const start = at(date, time);
  return { start: start.toISOString(), end: new Date(start.getTime() + 3600_000).toISOString(), free };
};
const RAWAI_WEEK = [
  hour("2026-10-10", "13:00"),
  hour("2026-10-10", "15:00"),
  hour("2026-10-10", "16:00"),
  hour("2026-10-12", "10:00"),
  hour("2026-10-15", "18:00"),
  hour("2026-10-15", "19:00", 2),
  hour("2026-10-15", "20:00", 2),
  hour("2026-10-17", "08:00"),
  hour("2026-10-17", "09:00"),
  hour("2026-10-17", "13:00"),
];
const CHALONG_WEEK = [hour("2026-10-11", "09:00"), hour("2026-10-11", "10:00"), hour("2026-10-15", "19:00"), hour("2026-10-15", "20:00")];
const feed = (slots: ClubFreeSlot[], o: Partial<ClubAvailability> = {}): ClubAvailability => ({ fetchedAt: NOW.toISOString(), day: "2026-10-10", tz: TZ, slots, error: null, source: "scrape:playtomic", ...o });
const TODAY_ONLY = RAWAI_WEEK.filter((s) => s.start < at("2026-10-11", "00:00").toISOString());
const rawai = freeFeedOf(feed(RAWAI_WEEK), NOW);
const chalong = freeFeedOf(feed(CHALONG_WEEK), NOW);
const clubs = [
  { slug: "rawai-padel", name: "Rawai Padel", feed: rawai, usual: true },
  { slug: "chalong-padel", name: "Chalong Padel", feed: chalong, usual: false },
];
const THU_7PM = { dow: 4, time: "19:00" };
const SAT_8AM = { dow: 6, time: "08:00" };
/** "Rawai Padel Thu 2026-10-15 19:00" for each answer, so a table row reads as the chips would. */
const said = (r: ReturnType<typeof bestTimes>) => r.map((b) => `${b.name} ${b.date} ${b.time}${b.usual ? " *" : ""}`);

describe("bestTimes: a usual club at a usual time first, then the soonest", () => {
  const table = [
    {
      why: "90 minutes, Thursdays at seven and Saturdays at eight: both usual times first, then the soonest",
      lengthMinutes: 90,
      patterns: [THU_7PM, SAT_8AM],
      want: ["Rawai Padel 2026-10-15 19:00 *", "Rawai Padel 2026-10-17 08:00 *", "Rawai Padel 2026-10-10 15:00"],
    },
    {
      why: "no history: the soonest, one per club and day, never an hour closer than two away",
      lengthMinutes: 60,
      patterns: [],
      want: ["Rawai Padel 2026-10-10 15:00", "Chalong Padel 2026-10-11 09:00", "Rawai Padel 2026-10-12 10:00"],
    },
    {
      why: "two hours need two free hours in a row: Monday's single hour drops out",
      lengthMinutes: 120,
      patterns: [],
      want: ["Rawai Padel 2026-10-10 15:00", "Chalong Padel 2026-10-11 09:00", "Rawai Padel 2026-10-15 18:00"],
    },
    {
      why: "a usual time at a club the person never played at is not first: it waits its turn by date",
      lengthMinutes: 60,
      patterns: [{ dow: 0, time: "09:00" }],
      want: ["Rawai Padel 2026-10-10 15:00", "Chalong Padel 2026-10-11 09:00", "Rawai Padel 2026-10-12 10:00"],
    },
    {
      why: "a usual time is within the hour: for 18:30 on Thursdays, 18:00 and 19:00 are as near, and the earlier wins",
      lengthMinutes: 60,
      patterns: [{ dow: 4, time: "18:30" }],
      want: ["Rawai Padel 2026-10-15 18:00 *", "Rawai Padel 2026-10-10 15:00", "Chalong Padel 2026-10-11 09:00"],
    },
  ];
  // A loop, not it.each: a table's titles are cut at forty characters, and a title is how a test is named and run.
  for (const { why, lengthMinutes, patterns, want } of table) {
    it(why, () => {
      expect(said(bestTimes({ clubs, patterns, lengthMinutes, now: NOW }))).toEqual(want);
    });
  }

  it("the nearest hour to the usual time wins on its day", () => {
    // 18:00, 19:00 and 20:00 are all free on Thursday and all within the hour of 19:00: 19:00 is the one.
    expect(said(bestTimes({ clubs: clubs.slice(0, 1), patterns: [THU_7PM], lengthMinutes: 60, now: NOW, limit: 1 }))).toEqual(["Rawai Padel 2026-10-15 19:00 *"]);
  });

  it("carries what a button needs: the instant, the club's own day and hour, its zone and the courts free", () => {
    const [first] = bestTimes({ clubs, patterns: [THU_7PM], lengthMinutes: 90, now: NOW, limit: 1 });
    expect(first).toEqual({ slug: "rawai-padel", name: "Rawai Padel", tz: TZ, start: at("2026-10-15", "19:00"), date: "2026-10-15", time: "19:00", free: 2, usual: true });
  });

  it("stays inside seven days and never offers a court too close to reach", () => {
    const all = bestTimes({ clubs: clubs.slice(0, 1), patterns: [], lengthMinutes: 60, now: NOW, limit: 20 });
    expect(all.every((b) => b.start.getTime() >= NOW.getTime() + BEST_TIMES.minLeadMs && b.start.getTime() < NOW.getTime() + BEST_TIMES.horizonMs)).toBe(true);
    expect(said(all)).not.toContain("Rawai Padel 2026-10-17 13:00");
    expect(said(all)).not.toContain("Rawai Padel 2026-10-10 13:00");
  });

  it("is bounded: a limit, and nothing from no clubs", () => {
    expect(bestTimes({ clubs, patterns: [], lengthMinutes: 60, now: NOW, limit: 1 })).toHaveLength(1);
    expect(bestTimes({ clubs: [], patterns: [THU_7PM], lengthMinutes: 60, now: NOW })).toEqual([]);
    expect(bestTimes({ clubs: [{ slug: "x", name: "X", feed: null, usual: true }], patterns: [], lengthMinutes: 60, now: NOW })).toEqual([]);
  });
});

describe("freeFeedOf: only a feed the club shared, read lately, without an error", () => {
  it("keeps the week ahead, sorted, and says until when it speaks", () => {
    expect(rawai?.tz).toBe(TZ);
    // Seven days from now (Saturday the 17th, 12:00), before the end of the last day the feed lists.
    expect(rawai?.until).toBe(new Date(NOW.getTime() + BEST_TIMES.horizonMs).toISOString());
    expect(rawai?.slots.map((s) => s.start)).toEqual(RAWAI_WEEK.filter((s) => s.start !== hour("2026-10-17", "13:00").start).map((s) => s.start));
  });

  it("refuses a stale feed, a failed one, a zone nobody knows and a slot with no court", () => {
    expect(freeFeedOf(feed(RAWAI_WEEK, { fetchedAt: new Date(NOW.getTime() - BEST_TIMES.freshMs - 60_000).toISOString() }), NOW)).toBeNull();
    expect(freeFeedOf(feed(RAWAI_WEEK, { error: "HTTP 500" }), NOW)).toBeNull();
    expect(freeFeedOf(feed(RAWAI_WEEK, { tz: "Mars/Olympus" }), NOW)).toBeNull();
    expect(freeFeedOf(null, NOW)).toBeNull();
    expect(freeFeedOf(feed([hour("2026-10-12", "10:00", 0)]), NOW)?.slots).toEqual([]);
  });

  it("a club's own feed, read for today: it speaks for today only, whatever its source", () => {
    const today = freeFeedOf(feed(TODAY_ONLY, { source: "ics_bookings" }), NOW);
    expect(today?.slots.map((s) => s.start)).toEqual([hour("2026-10-10", "13:00").start, hour("2026-10-10", "15:00").start, hour("2026-10-10", "16:00").start]);
    expect(today?.until).toBe(at("2026-10-11", "00:00").toISOString());
    expect(freeAt(today, at("2026-10-12", "10:00"), 60, NOW)).toBe("unknown");
    // A fully booked last day is still a day the feed speaks for: busy there, not unknown.
    const booked = freeFeedOf(feed([...TODAY_ONLY, hour("2026-10-12", "10:00", 0)]), NOW);
    expect(booked?.until).toBe(at("2026-10-13", "00:00").toISOString());
    expect(freeAt(booked, at("2026-10-12", "10:00"), 60, NOW)).toBe("busy");
  });
});

describe("freeAt: does the club show a free court then?", () => {
  const f = rawai as FreeFeed;
  const table = [
    ["Thursday 19:00 for 90 minutes", at("2026-10-15", "19:00"), 90, "free"],
    ["Thursday 18:00 for 120 minutes", at("2026-10-15", "18:00"), 120, "free"],
    ["Thursday 20:00 for 90 minutes: the club closes its feed at 21:00", at("2026-10-15", "20:00"), 90, "busy"],
    ["Thursday 21:00", at("2026-10-15", "21:00"), 60, "busy"],
    ["Monday 10:30, half inside a free hour", at("2026-10-12", "10:30"), 60, "busy"],
    ["Saturday the 17th at 08:00, six days on", at("2026-10-17", "08:00"), 60, "free"],
    ["Saturday the 17th at 11:30: it ends past the seven days", at("2026-10-17", "11:30"), 60, "unknown"],
    ["an hour already gone", at("2026-10-10", "09:00"), 60, "unknown"],
  ] as const;
  for (const [why, start, minutes, want] of table) {
    it(`${why} → ${want}`, () => {
      expect(freeAt(f, start, minutes, NOW)).toBe(want);
    });
  }

  it("says nothing without a feed", () => {
    expect(freeAt(null, at("2026-10-15", "19:00"), 60, NOW)).toBe("unknown");
  });
});
