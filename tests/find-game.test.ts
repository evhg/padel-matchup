import { readFileSync } from "node:fs";
import path from "node:path";
import { createTranslator } from "next-intl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { cancelEvent, createEvent } from "@/lib/domain/events";
import { CITIES, cityBySlug } from "@/lib/domain/cities";
import { clubsOf, filterGames, findGames, firstNameOf, homeCity, parsePlayFilters, playCities, playHref, playWindow, type PlayFilters } from "@/lib/domain/findGame";
import { joinEvent } from "@/lib/domain/slots";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";

// Friday 9 October 2026, 12:00 in Phuket (Asia/Bangkok is UTC+7 all year):
// today's midnight is 17:00Z on the 9th, tomorrow's is 17:00Z on the 10th,
// and the week ends at midnight on Friday the 16th, 17:00Z on the 15th.
const NOW = new Date("2026-10-09T05:00:00Z");
freezeClock(NOW);

const phuket = cityBySlug("phuket")!;
const singapore = cityBySlug("singapore")!;
const base: PlayFilters = { city: "phuket", day: "week", fits: false, club: null, spots: false };

describe("the page's description names the cities /play serves, read from CITIES", () => {
  it("lists every city in the reader's language, and the copy itself names none", () => {
    expect(playCities("en")).toBe("Phuket and Singapore");
    expect(playCities("ru")).toBe("Phuket и Singapore");
    expect(playCities("es")).toBe("Phuket y Singapore");
    for (const locale of ["en", "ru", "es"] as const) {
      const messages = JSON.parse(readFileSync(path.resolve(process.cwd(), "messages", `${locale}.json`), "utf8"));
      // A fixed city in the sentence is the copy that went stale the day a third city arrived.
      expect(messages.city.playMetaDescription, locale).not.toMatch(/Phuket|Singapore|Пхукет|Сингапур|Singapur/);
      const text = createTranslator({ locale, messages })("city.playMetaDescription" as never, { cities: playCities(locale) } as never) as string;
      for (const c of CITIES) expect(text, locale).toContain(c.name);
    }
  });
});

describe("the city a visitor meets first", () => {
  it("is the edge's city when it is one of ours, a whole-city zone next, and Phuket otherwise", () => {
    expect(homeCity({ city: "Singapore", tz: "Asia/Bangkok" }).slug).toBe("singapore");
    expect(homeCity({ city: "phuket" }).slug).toBe("phuket");
    expect(homeCity({ city: null, tz: "Asia/Singapore" }).slug).toBe("singapore");
    // Bangkok's zone is Phuket's too, but it does not say Phuket: the default answers, not the zone.
    expect(homeCity({ city: "Bangkok", tz: "Asia/Bangkok" }).slug).toBe("phuket");
    expect(homeCity({ city: "Berlin", tz: "Europe/Berlin" }).slug).toBe("phuket");
    expect(homeCity({}).slug).toBe("phuket");
  });
});

describe("the filters in the URL", () => {
  it("reads what it knows and falls back on everything else", () => {
    expect(parsePlayFilters({}, "phuket")).toEqual(base);
    expect(parsePlayFilters({ city: "singapore", day: "today", fits: "1", club: "rawai-padel", spots: "1" }, "phuket")).toEqual({ city: "singapore", day: "today", fits: true, club: "rawai-padel", spots: true });
    expect(parsePlayFilters({ city: "atlantis", day: "someday", fits: "yes", club: "../etc", spots: "0" }, "singapore")).toEqual({ ...base, city: "singapore" });
    expect(parsePlayFilters({ city: ["singapore", "phuket"], day: ["tomorrow"] }, "phuket")).toMatchObject({ city: "singapore", day: "tomorrow" });
  });

  it("writes a link that carries the city, leaves the defaults out, and round-trips", () => {
    expect(playHref(base)).toBe("/play?city=phuket");
    const all: PlayFilters = { city: "phuket", day: "tomorrow", fits: true, club: "rawai-padel", spots: true };
    expect(playHref(all)).toBe("/play?city=phuket&day=tomorrow&club=rawai-padel&fits=1&spots=1");
    const back = Object.fromEntries(new URL(`https://x${playHref(all)}`).searchParams);
    expect(parsePlayFilters(back, "singapore")).toEqual(all);
    // Toggling one chip keeps the others.
    expect(playHref(all, { spots: false })).toBe("/play?city=phuket&day=tomorrow&club=rawai-padel&fits=1");
  });

  it("drops the club when the city changes, because a club belongs to its city", () => {
    expect(playHref({ ...base, club: "rawai-padel" }, { city: "singapore" })).toBe("/play?city=singapore");
    expect(playHref({ ...base, club: "rawai-padel" }, { city: "phuket" })).toBe("/play?city=phuket&club=rawai-padel");
  });
});

describe("what a day chip means", () => {
  it("is today until midnight, the whole of tomorrow, and seven days for the week, in the city's zone", () => {
    expect(playWindow("today", NOW, phuket.tz)).toEqual({ from: NOW, to: new Date("2026-10-09T17:00:00Z") });
    expect(playWindow("tomorrow", NOW, phuket.tz)).toEqual({ from: new Date("2026-10-09T17:00:00Z"), to: new Date("2026-10-10T17:00:00Z") });
    expect(playWindow("week", NOW, phuket.tz)).toEqual({ from: NOW, to: new Date("2026-10-15T17:00:00Z") });
    // Singapore is an hour ahead of Phuket, so its midnight comes an hour sooner.
    expect(playWindow("today", NOW, singapore.tz).to).toEqual(new Date("2026-10-09T16:00:00Z"));
  });

  it("gives a day the hours it really has when the clocks change", () => {
    // Madrid leaves summer time on Sunday 25 October 2026: that day lasts 25 hours.
    const sat = new Date("2026-10-24T10:00:00Z");
    const w = playWindow("tomorrow", sat, "Europe/Madrid");
    expect(w).toEqual({ from: new Date("2026-10-24T22:00:00Z"), to: new Date("2026-10-25T23:00:00Z") });
    expect(w.to.getTime() - w.from.getTime()).toBe(25 * HOUR);
  });
});

describe("the chips that narrow the list", () => {
  const at = (h: number) => new Date(NOW.getTime() + h * HOUR);
  const rows = [
    { id: "open-today", startsAt: at(3), venueSlug: "rawai-padel", venueName: "Rawai Padel", levelMin: null, levelMax: null, spotsLeft: 2 },
    { id: "full-today", startsAt: at(4), venueSlug: "rawai-padel", venueName: "Rawai Padel", levelMin: null, levelMax: null, spotsLeft: 0 },
    { id: "ranged-tomorrow", startsAt: at(26), venueSlug: "kata-padel", venueName: "Kata Padel", levelMin: 3, levelMax: 4, spotsLeft: 1 },
    { id: "high-later", startsAt: at(80), venueSlug: "kata-padel", venueName: "Kata Padel", levelMin: 5, levelMax: null, spotsLeft: 3 },
  ];
  const ids = (r: { id: string }[]) => r.map((x) => x.id);
  const week = playWindow("week", NOW, phuket.tz);

  it("keeps everything by default, full games included", () => {
    expect(ids(filterGames(rows, base, week, null))).toEqual(["open-today", "full-today", "ranged-tomorrow", "high-later"]);
  });
  it("keeps the day's window", () => {
    expect(ids(filterGames(rows, base, playWindow("today", NOW, phuket.tz), null))).toEqual(["open-today", "full-today"]);
    expect(ids(filterGames(rows, base, playWindow("tomorrow", NOW, phuket.tz), null))).toEqual(["ranged-tomorrow"]);
  });
  it("keeps one club", () => {
    expect(ids(filterGames(rows, { ...base, club: "kata-padel" }, week, null))).toEqual(["ranged-tomorrow", "high-later"]);
  });
  it("hides the full ones when asked", () => {
    expect(ids(filterGames(rows, { ...base, spots: true }, week, null))).toEqual(["open-today", "ranged-tomorrow", "high-later"]);
  });
  it("keeps what fits the viewer's level, open games included, and ignores the chip for a viewer with no level", () => {
    expect(ids(filterGames(rows, { ...base, fits: true }, week, 3.5))).toEqual(["open-today", "full-today", "ranged-tomorrow"]);
    expect(ids(filterGames(rows, { ...base, fits: true }, week, 5.5))).toEqual(["open-today", "full-today", "high-later"]);
    expect(ids(filterGames(rows, { ...base, fits: true }, week, null))).toHaveLength(4);
  });
  it("names each club once, by name, whatever the club chip says", () => {
    expect(clubsOf(rows)).toEqual([
      { slug: "kata-padel", name: "Kata Padel" },
      { slug: "rawai-padel", name: "Rawai Padel" },
    ]);
  });
  it("shows the organiser by first name only", () => {
    expect(firstNameOf("  Anna   Maria Lopez ")).toBe("Anna");
    expect(firstNameOf(null)).toBe("");
  });
});

describe("the one read", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  it("lists the city's listed, live, upcoming games in the window, soonest first, with seats and a first name", async () => {
    const org = await makePlayer(db, "Nina Petrova");
    const joiner = await makePlayer(db, "Bo");
    const ev = { creatorPlayerId: org.id, tz: "Asia/Bangkok", whenFull: "waitlist" as const, publicListing: true };
    const match = await createEvent(db, { ...ev, type: "match", venueName: "Rawai Padel Club", startsAt: new Date(NOW.getTime() + 3 * HOUR), levelMin: 3, levelMax: 4, cost: "400 ฿" });
    const americano = await createEvent(db, { ...ev, type: "tournament", capacity: 8, format: "mexicano", venueName: "Kata Padel", startsAt: new Date(NOW.getTime() + 2 * HOUR) });
    await joinEvent(db, { eventId: match.id, playerId: org.id });
    await joinEvent(db, { eventId: match.id, playerId: joiner.id });
    // Each of these is left out for exactly one reason.
    await createEvent(db, { ...ev, type: "match", venueName: "Rawai Padel Club", startsAt: new Date(NOW.getTime() + 4 * HOUR), publicListing: false });
    const cancelled = await createEvent(db, { ...ev, type: "match", venueName: "Rawai Padel Club", startsAt: new Date(NOW.getTime() + 5 * HOUR) });
    await cancelEvent(db, cancelled.id, org.id);
    await createEvent(db, { ...ev, type: "match", venueName: "Bangkok Padel Arena", startsAt: new Date(NOW.getTime() + 3 * HOUR) });
    await createEvent(db, { ...ev, type: "match", venueName: "Rawai Padel Club", startsAt: new Date(NOW.getTime() + 8 * DAY) });
    await createEvent(db, { ...ev, type: "match", venueName: "Rawai Padel Club", startsAt: new Date(NOW.getTime() - 1 * HOUR) });
    await createEvent(db, { ...ev, type: "match", venueName: "Singapore Padel", tz: "Asia/Singapore", startsAt: new Date(NOW.getTime() + 3 * HOUR) });

    const games = await findGames(db, phuket, playWindow("week", NOW, phuket.tz), NOW);
    expect(games.map((g) => g.code)).toEqual([americano.code, match.code]);
    expect(games[1]).toMatchObject({ organiser: "Nina", occupied: 2, spotsLeft: 2, fill: { kind: "left", count: 2 }, levelMin: 3, levelMax: 4, cost: "400 ฿", venueSlug: "rawai-padel-club" });
    expect(games[0]).toMatchObject({ type: "tournament", format: "mexicano", occupied: 0, spotsLeft: 8, fill: { kind: "field", count: 0, capacity: 8 } });
    // The same read for Singapore finds Singapore's game and nothing of Phuket's.
    expect((await findGames(db, singapore, playWindow("week", NOW, singapore.tz), NOW)).map((g) => g.venueName)).toEqual(["Singapore Padel"]);
    // Tomorrow's window holds neither of today's games.
    expect(await findGames(db, phuket, playWindow("tomorrow", NOW, phuket.tz), NOW)).toEqual([]);
  });
});
