import { describe, expect, it } from "vitest";
import type { ClubAvailability, ClubFreeSlot } from "@/db/schema";
import { SCRAPE_SHOWN_MS } from "@/lib/booking/availability";
import { zonedTimeToUtc } from "@/lib/dates";
import { BEST_TIMES, bestTimes, datesSharingAWeekday, freeAt, freeFeedOf, freeLineMessage, freeLineOf, timeChipsOf, type FreeFeed } from "@/lib/domain/bestTimes";
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
 *   Sat 17  08:00, 09:00, and 13:00 (past the end of the sixth day: one weekday never shows twice)
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
      why: "90 minutes, Thursdays at seven and Saturdays at eight: Thursday first; next Saturday is past the sixth day, so the soonest follow",
      lengthMinutes: 90,
      patterns: [THU_7PM, SAT_8AM],
      want: ["Rawai Padel 2026-10-15 19:00 *", "Rawai Padel 2026-10-10 15:00", "Chalong Padel 2026-10-11 09:00"],
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
      why: "a usual time inside a free stretch is offered as it is: 18:30 on Thursdays",
      lengthMinutes: 60,
      patterns: [{ dow: 4, time: "18:30" }],
      want: ["Rawai Padel 2026-10-15 18:30 *", "Rawai Padel 2026-10-10 15:00", "Chalong Padel 2026-10-11 09:00"],
    },
    {
      why: "a usual time is within the hour: for 21:00 on Thursdays, when the club's last free hour starts at 20:00",
      lengthMinutes: 60,
      patterns: [{ dow: 4, time: "21:00" }],
      want: ["Rawai Padel 2026-10-15 20:00 *", "Rawai Padel 2026-10-10 15:00", "Chalong Padel 2026-10-11 09:00"],
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

  it("carries what a button needs: the instant, the club's own day and hour, its zone, the courts free and whose times they are", () => {
    const [first] = bestTimes({ clubs, patterns: [THU_7PM], lengthMinutes: 90, now: NOW, limit: 1 });
    expect(first).toEqual({ slug: "rawai-padel", name: "Rawai Padel", tz: TZ, start: at("2026-10-15", "19:00"), date: "2026-10-15", time: "19:00", free: 2, usual: true, platform: "Playtomic" });
  });

  it("stays inside seven days, never shows one weekday twice and never offers a court too close to reach", () => {
    const all = bestTimes({ clubs: clubs.slice(0, 1), patterns: [], lengthMinutes: 60, now: NOW, limit: 20 });
    expect(all.every((b) => b.start.getTime() >= NOW.getTime() + BEST_TIMES.minLeadMs && b.start.getTime() < NOW.getTime() + BEST_TIMES.horizonMs)).toBe(true);
    // "Sat 08:00" beside "Sat 15:00" reads as one day; it would be next Saturday's.
    expect(all.map((b) => b.date)).toEqual(["2026-10-10", "2026-10-12", "2026-10-15"]);
    expect(said(all)).not.toContain("Rawai Padel 2026-10-17 08:00");
    expect(said(all)).not.toContain("Rawai Padel 2026-10-10 13:00");
  });

  it("is bounded: a limit, and nothing from no clubs", () => {
    expect(bestTimes({ clubs, patterns: [], lengthMinutes: 60, now: NOW, limit: 1 })).toHaveLength(1);
    expect(bestTimes({ clubs: [], patterns: [THU_7PM], lengthMinutes: 60, now: NOW })).toEqual([]);
    expect(bestTimes({ clubs: [{ slug: "x", name: "X", feed: null, usual: true }], patterns: [], lengthMinutes: 60, now: NOW })).toEqual([]);
  });
});

describe("freeFeedOf: only a feed the club shared, read lately, without an error", () => {
  it("keeps the days up to the end of the sixth, as stretches that never overlap, and says until when it speaks", () => {
    expect(rawai?.tz).toBe(TZ);
    // The end of Friday the 16th: next Saturday is the same weekday as today, so it is left out.
    expect(rawai?.until).toBe(at("2026-10-17", "00:00").toISOString());
    expect(rawai?.slots.map((s) => `${s.start} ${s.end} ${s.free}`)).toEqual(
      [
        [at("2026-10-10", "13:00"), at("2026-10-10", "14:00"), 1],
        [at("2026-10-10", "15:00"), at("2026-10-10", "17:00"), 1],
        [at("2026-10-12", "10:00"), at("2026-10-12", "11:00"), 1],
        [at("2026-10-15", "18:00"), at("2026-10-15", "19:00"), 1],
        [at("2026-10-15", "19:00"), at("2026-10-15", "21:00"), 2],
      ].map(([a, b, n]) => `${(a as Date).toISOString()} ${(b as Date).toISOString()} ${n}`),
    );
  });

  it("refuses a read stamped in the future beyond a few minutes of clock skew", () => {
    expect(freeFeedOf(feed(RAWAI_WEEK, { fetchedAt: new Date(NOW.getTime() + 30 * 86_400_000).toISOString() }), NOW)).toBeNull();
    expect(freeFeedOf(feed(RAWAI_WEEK, { fetchedAt: new Date(NOW.getTime() + BEST_TIMES.skewMs + 60_000).toISOString() }), NOW)).toBeNull();
    expect(freeFeedOf(feed(RAWAI_WEEK, { fetchedAt: new Date(NOW.getTime() + 60_000).toISOString() }), NOW)).not.toBeNull();
  });

  it("a feed cut for room speaks only up to the first stretch it left out: past it a free court is unknown, never busy", () => {
    // A week of half hours whose count changes each time (the shape a platform's read takes): more than it keeps.
    const start = at("2026-10-10", "14:00").getTime();
    const many: ClubFreeSlot[] = Array.from({ length: BEST_TIMES.maxSlots + 20 }, (_, k) => ({ start: new Date(start + k * 1_800_000).toISOString(), end: new Date(start + (k + 1) * 1_800_000).toISOString(), free: 1 + (k % 2) }));
    const cut = freeFeedOf(feed(many), NOW) as FreeFeed;
    expect(cut.slots).toHaveLength(BEST_TIMES.maxSlots);
    expect(cut.until).toBe(many[BEST_TIMES.maxSlots].start);
    expect(freeAt(cut, new Date(many[BEST_TIMES.maxSlots - 2].start), 60, NOW)).toBe("free");
    expect(freeAt(cut, new Date(many[BEST_TIMES.maxSlots + 5].start), 60, NOW)).toBe("unknown");
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
    // 15:00 and 16:00 touch with one court each: one stretch.
    expect(today?.slots.map((s) => s.start)).toEqual([hour("2026-10-10", "13:00").start, hour("2026-10-10", "15:00").start]);
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
    ["Friday the 16th at 10:00, the sixth day, nothing listed", at("2026-10-16", "10:00"), 60, "busy"],
    ["Saturday the 17th at 08:00: a week on, past the end of the sixth day", at("2026-10-17", "08:00"), 60, "unknown"],
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

describe("bestTimes inside a long free stretch", () => {
  // Two courts free from 08:00 to 23:00, as a club's json_free block or a platform's read gives it.
  const block = (date: string) => ({ start: at(date, "08:00").toISOString(), end: at(date, "23:00").toISOString(), free: 2 });
  const long = [{ slug: "rawai-padel", name: "Rawai Padel", feed: freeFeedOf(feed([block("2026-10-10"), block("2026-10-15")]), NOW), usual: true }];

  it("a stretch that began before the two-hour lead offers its first half hour after it, and agrees with the line under the time", () => {
    expect(said(bestTimes({ clubs: long, patterns: [], lengthMinutes: 90, now: NOW, limit: 1 }))).toEqual(["Rawai Padel 2026-10-10 14:00"]);
    expect(freeAt(long[0].feed, at("2026-10-10", "19:00"), 90, NOW)).toBe("free");
  });

  it("a usual time inside the stretch is offered as itself, marked usual, even off the half hours", () => {
    expect(said(bestTimes({ clubs: long, patterns: [THU_7PM], lengthMinutes: 90, now: NOW, limit: 1 }))).toEqual(["Rawai Padel 2026-10-15 19:00 *"]);
    expect(said(bestTimes({ clubs: long, patterns: [{ dow: 4, time: "19:15" }], lengthMinutes: 90, now: NOW, limit: 1 }))).toEqual(["Rawai Padel 2026-10-15 19:15 *"]);
  });

  it("a stretch ends where the match must: never a start too late for the whole length", () => {
    const all = bestTimes({ clubs: [{ ...long[0], usual: false }], patterns: [{ dow: 4, time: "22:30" }], lengthMinutes: 90, now: NOW, limit: 5 });
    expect(said(all)).toEqual(["Rawai Padel 2026-10-10 14:00", "Rawai Padel 2026-10-15 08:00"]);
  });
});

describe("bestTimes cost: one pass over each club's stretches", () => {
  it("30 clubs of 200 stretches each rank in well under a second, even under the test's slow clock", () => {
    const start = at("2026-10-10", "13:00").getTime();
    const week: ClubFreeSlot[] = Array.from({ length: 220 }, (_, k) => ({ start: new Date(start + k * 1_800_000).toISOString(), end: new Date(start + (k + 1) * 1_800_000).toISOString(), free: 1 + (k % 2) }));
    const many = Array.from({ length: 30 }, (_, i) => ({ slug: `c${i}`, name: `Club ${i}`, feed: freeFeedOf(feed(week), NOW), usual: i < 3 }));
    expect(many[0].feed?.slots).toHaveLength(BEST_TIMES.maxSlots);
    const t0 = performance.now();
    const best = bestTimes({ clubs: many, patterns: [THU_7PM], lengthMinutes: 120, now: NOW });
    // About 0.15 s here; the first ranking, which walked every slot from the first for each start, took 3 s.
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(best).toHaveLength(BEST_TIMES.limit);
  });
});

describe("timeChipsOf: one row of chips, the club's free times first", () => {
  const c = (date: string, time: string) => ({ date, time });

  it("fills the row with the usual times the free ones do not already hold, and marks which is which", () => {
    expect(timeChipsOf([c("2026-10-10", "15:00")], [c("2026-10-15", "19:00"), c("2026-10-10", "15:00"), c("2026-10-11", "10:00")])).toEqual([
      { date: "2026-10-10", time: "15:00", free: true },
      { date: "2026-10-15", time: "19:00", free: false },
      { date: "2026-10-11", time: "10:00", free: false },
    ]);
  });

  it("never more than the row holds, free ones first", () => {
    const free = [c("2026-10-10", "15:00"), c("2026-10-11", "09:00"), c("2026-10-12", "10:00")];
    expect(timeChipsOf(free, [c("2026-10-15", "19:00"), c("2026-10-16", "19:00")], 4).map((x) => `${x.date} ${x.free}`)).toEqual(["2026-10-10 true", "2026-10-11 true", "2026-10-12 true", "2026-10-15 false"]);
    expect(timeChipsOf(free, [], 2)).toHaveLength(2);
    expect(timeChipsOf([], [c("2026-10-15", "19:00")])).toEqual([{ date: "2026-10-15", time: "19:00", free: false }]);
  });
});

describe("datesSharingAWeekday: a row never shows one weekday for two dates", () => {
  it("names the day and month of both Saturdays, and of nothing else", () => {
    // Saturday the 10th (today, free at 15:00) and Saturday the 17th (a usual 08:00, next week).
    expect([...datesSharingAWeekday([{ date: "2026-10-10" }, { date: "2026-10-15" }, { date: "2026-10-17" }, { date: "2026-10-10" }])].sort()).toEqual(["2026-10-10", "2026-10-17"]);
    expect(datesSharingAWeekday([{ date: "2026-10-10" }, { date: "2026-10-11" }, { date: "2026-10-10" }]).size).toBe(0);
  });
});

describe("freeLineOf: the line under the time, in the club's hour when the form's zone is not the club's", () => {
  const f = rawai as FreeFeed;

  it("in the club's own zone: what the club shows, and no hour", () => {
    expect(freeLineOf(f, { date: "2026-10-15", time: "19:00", tz: TZ }, 90, NOW)).toMatchObject({ state: "free", clubTime: null });
  });

  it("from Madrid, 14:00 there is 19:00 at the club: the line names the club's hour", () => {
    expect(freeLineOf(f, { date: "2026-10-15", time: "14:00", tz: "Europe/Madrid" }, 90, NOW)).toMatchObject({ state: "free", clubTime: "19:00" });
    // 19:00 in Madrid is midnight at the club, on a day it lists nothing.
    expect(freeLineOf(f, { date: "2026-10-15", time: "19:00", tz: "Europe/Madrid" }, 60, NOW)).toMatchObject({ state: "busy", clubTime: "00:00" });
    expect(freeLineOf(f, { date: "2026-10-15", time: "11:00", tz: "Europe/Madrid" }, 60, NOW)).toMatchObject({ state: "busy", clubTime: "16:00" });
  });

  it("names the platform when the times are a platform's, and the club when they are its own feed", () => {
    expect(freeLineMessage(freeLineOf(f, { date: "2026-10-15", time: "19:00", tz: TZ }, 90, NOW))).toEqual({ key: "create.freeThenOn", values: { platform: "Playtomic" } });
    expect(freeLineMessage(freeLineOf(f, { date: "2026-10-15", time: "11:00", tz: "Europe/Madrid" }, 60, NOW))).toEqual({ key: "create.busyThenOnClub", values: { platform: "Playtomic", time: "16:00" } });
    const own = freeFeedOf(feed(TODAY_ONLY, { source: "ics_bookings" }), NOW);
    expect(freeLineMessage(freeLineOf(own, { date: "2026-10-10", time: "15:00", tz: TZ }, 60, NOW))).toEqual({ key: "create.freeThen", values: {} });
    expect(freeLineMessage(freeLineOf(own, { date: "2026-10-10", time: "09:00", tz: "Europe/Madrid" }, 60, NOW))).toEqual({ key: "create.busyThenClub", values: { time: "14:00" } });
    expect(freeLineMessage(freeLineOf(null, { date: "2026-10-15", time: "19:00", tz: TZ }, 90, NOW))).toBeNull();
  });

  it("says nothing without a feed or a time", () => {
    expect(freeLineOf(null, { date: "2026-10-15", time: "19:00", tz: TZ }, 90, NOW).state).toBe("unknown");
    expect(freeLineOf(f, { date: "", time: "19:00", tz: TZ }, 90, NOW).state).toBe("unknown");
    expect(freeLineOf(f, { date: "2026-10-15", time: "19:00", tz: "Mars/Olympus" }, 90, NOW).state).toBe("unknown");
  });
});

describe("freeFeedOf on a platform's read: the days it covered, each as fresh as its own read", () => {
  // A read of the platform's public page covers today and the next two days (`days`); `fullAt` is when
  // all three were last read, and a read of today alone in between keeps the later days of that one.
  const DAYS = ["2026-10-10", "2026-10-11", "2026-10-12"];
  const SUNDAY = hour("2026-10-11", "09:00");
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
  const read = (o: Partial<ClubAvailability>) => feed([hour("2026-10-10", "15:00"), SUNDAY], { days: DAYS, platform: "playtomic", fetchedAt: minutesAgo(10), fullAt: minutesAgo(10), ...o });

  it("speaks to the end of the last day it read, so a fully booked day is busy, not unknown", () => {
    const f = freeFeedOf(read({}), NOW) as FreeFeed;
    expect(f.until).toBe(at("2026-10-13", "00:00").toISOString());
    expect(freeAt(f, at("2026-10-12", "10:00"), 60, NOW)).toBe("busy");
    expect(freeAt(f, at("2026-10-13", "10:00"), 60, NOW)).toBe("unknown");
  });

  it("names the platform, so every screen can say whose times these are", () => {
    expect(freeFeedOf(read({}), NOW)?.platform).toBe("Playtomic");
    expect(bestTimes({ clubs: [{ slug: "r", name: "Rawai", feed: freeFeedOf(read({}), NOW) }], patterns: [], lengthMinutes: 60, now: NOW, limit: 1 })[0].platform).toBe("Playtomic");
    expect(freeFeedOf(feed(TODAY_ONLY, { source: "ics_bookings" }), NOW)?.platform).toBeNull();
  });

  it("the later days only while the full read is fresh: today's own read does not make them new", () => {
    const f = freeFeedOf(read({ fullAt: minutesAgo(150) }), NOW) as FreeFeed;
    expect(f.until).toBe(at("2026-10-11", "00:00").toISOString());
    expect(f.slots.map((s) => s.start)).toEqual([hour("2026-10-10", "15:00").start]);
    expect(freeAt(f, new Date(SUNDAY.start), 60, NOW)).toBe("unknown");
  });

  it("is shown for as long as the platform's read is shown anywhere else, and a club's own feed for its hourly read", () => {
    expect(BEST_TIMES.platformShownMs).toBe(SCRAPE_SHOWN_MS);
    expect(freeFeedOf(read({ fetchedAt: minutesAgo(121), fullAt: minutesAgo(121) }), NOW)).toBeNull();
    expect(freeFeedOf(feed(TODAY_ONLY, { source: "ics_bookings", fetchedAt: minutesAgo(150) }), NOW)).not.toBeNull();
  });

  it("after the club's midnight, the new day counts only if the full read covered it and is fresh", () => {
    // 00:20 on Sunday: the last read was of Saturday alone at 23:50; the full read of Sat to Mon was at 22:10 or at 23:00.
    const late = at("2026-10-11", "00:20");
    const lastRead = (fullAt: string) => read({ fetchedAt: at("2026-10-10", "23:50").toISOString(), fullAt: at("2026-10-10", fullAt).toISOString() });
    expect(freeFeedOf(lastRead("22:10"), late)).toBeNull();
    expect(freeFeedOf(lastRead("23:00"), late)?.until).toBe(at("2026-10-13", "00:00").toISOString());
  });
});
