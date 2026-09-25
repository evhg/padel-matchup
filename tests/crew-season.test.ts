import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import type { Player } from "@/db/schema";
import { crewSeasonSeats, SEASON_HOT_STREAK, seasonTable, type SeasonSeat } from "@/lib/domain/crewSeason";
import { createEvent } from "@/lib/domain/events";
import { createGroup } from "@/lib/domain/groups";
import { saveMatchScore } from "@/lib/domain/scores";
import { joinEvent } from "@/lib/domain/slots";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * A small season table for each crew (the owner, 25 September 2026): played, won and the current run
 * of wins, over the crew's matches of the last ninety days, from the second scored match on.
 *
 * NOW is Friday 25 September 2026, 12:00 UTC. Every match below is a whole number of days before it;
 * ninety days back is 27 June 2026, 12:00 UTC.
 */
const NOW = new Date("2026-09-25T12:00:00.000Z");
freezeClock(NOW);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

/** The seats of one match: pair A, pair B, and the sets each pair won. */
const match = (id: string, days: number, a: string[], b: string[], setsA: number, setsB: number): SeasonSeat[] => [
  ...a.map((playerId) => ({ eventId: id, startsAt: daysAgo(days), playerId, team: "a" as const, setsA, setsB })),
  ...b.map((playerId) => ({ eventId: id, startsAt: daysAgo(days), playerId, team: "b" as const, setsA, setsB })),
];
const crew = (...names: string[]) => names.map((name) => ({ playerId: name.split(" ")[0].toLowerCase(), name }));

describe("the season table", () => {
  it("waits for the crew's second scored match, and a match without both pairs is not one", () => {
    const members = crew("Ana", "Ben", "Cid", "Dee");
    const one = match("m1", 3, ["ana", "ben"], ["cid", "dee"], 2, 0);
    expect(seasonTable(one, members, NOW)).toBeNull();
    // A second score, but nobody set the pairs: nobody can say who won it.
    const teamless = match("m2", 2, [], [], 2, 1).concat(["ana", "ben", "cid", "dee"].map((playerId) => ({ eventId: "m2", startsAt: daysAgo(2), playerId, team: null, setsA: 2, setsB: 1 })));
    expect(seasonTable([...one, ...teamless], members, NOW)).toBeNull();
    // Nor does a match from before the ninety days.
    const old = match("m0", 91, ["ana", "ben"], ["cid", "dee"], 2, 0);
    expect(seasonTable([...one, ...old], members, NOW)).toBeNull();
    // The second real one does.
    const two = match("m3", 1, ["ana", "cid"], ["ben", "dee"], 0, 2);
    expect(seasonTable([...one, ...two], members, NOW)).not.toBeNull();
  });

  it("counts played and won for members only, by first name, most wins first, then most played", () => {
    const members = crew("Ana Ortiz", "Ben", "Cid", "Dee", "Al", "Eve");
    const seats = [
      ...match("m1", 20, ["ana", "ben"], ["cid", "dee"], 2, 0), // A wins
      ...match("m2", 15, ["ana", "cid"], ["ben", "dee"], 2, 1), // A wins
      ...match("m3", 10, ["ana", "dee"], ["ben", "cid"], 2, 0), // A wins
      ...match("m4", 5, ["ben", "cid"], ["dee", "guest"], 1, 1), // a draw; the guest is not in the crew
      ...match("m5", 4, ["al", "guest"], ["other", "stranger"], 2, 0), // Al wins his only match
      ...match("m0", 91, ["dee", "cid"], ["ana", "ben"], 2, 0), // before the season
    ];
    const table = seasonTable(seats, members, NOW)!;
    expect(table.map((l) => [l.name, l.played, l.won])).toEqual([
      ["Ana", 3, 3],
      ["Ben", 4, 1],
      ["Cid", 4, 1],
      ["Dee", 4, 1],
      ["Al", 1, 1],
    ]);
    // Eve played nothing and the guest is no member: neither is listed.
    expect(table.some((l) => l.playerId === "eve" || l.playerId === "guest")).toBe(false);
  });

  it("gives the current run of wins, newest first, and a loss or a draw ends it", () => {
    const members = crew("Run", "Broken", "Drawn");
    const seats = [
      // Run: won the last three, lost the one before: 3, the 🔥.
      ...match("r1", 30, ["run", "x1"], ["x2", "x3"], 0, 2),
      ...match("r2", 20, ["run", "x1"], ["x2", "x3"], 2, 0),
      ...match("r3", 10, ["run", "x1"], ["x2", "x3"], 2, 1),
      ...match("r4", 5, ["run", "x1"], ["x2", "x3"], 2, 0),
      // Broken: three wins, then the latest lost.
      ...match("b1", 29, ["broken", "y1"], ["y2", "y3"], 2, 0),
      ...match("b2", 19, ["broken", "y1"], ["y2", "y3"], 2, 0),
      ...match("b3", 9, ["broken", "y1"], ["y2", "y3"], 2, 0),
      ...match("b4", 4, ["y2", "y3"], ["broken", "y1"], 2, 0),
      // Drawn: a win, then a draw.
      ...match("d1", 8, ["drawn", "z1"], ["z2", "z3"], 2, 0),
      ...match("d2", 3, ["drawn", "z1"], ["z2", "z3"], 1, 1),
    ];
    const byName = new Map(seasonTable(seats, members, NOW)!.map((l) => [l.name, l]));
    expect(byName.get("Run")?.streak).toBe(3);
    expect(byName.get("Run")!.streak).toBeGreaterThanOrEqual(SEASON_HOT_STREAK);
    expect(byName.get("Broken")).toMatchObject({ played: 4, won: 3, streak: 0 });
    expect(byName.get("Drawn")).toMatchObject({ played: 2, won: 1, streak: 0 });
  });
});

describe("the season's seats, from the database", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  /** A crew match `days` ago with these four seated, the first organising. */
  const crewMatch = async (groupId: string | null, days: number, four: Player[]) => {
    const startsAt = daysAgo(days);
    const ev = await createEvent(db, { creatorPlayerId: four[0].id, type: "match", startsAt, tz: "Asia/Bangkok", whenFull: "waitlist", groupId });
    for (const p of four) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: new Date(startsAt.getTime() - HOUR) });
    return ev;
  };
  const score = (eventId: string, by: Player, teamA: Player[], sets: [number, number][], days: number) =>
    saveMatchScore(db, { eventId, playerId: by.id, isCreator: true, sets: sets.map(([sideA, sideB], i) => ({ setNumber: i + 1, sideA, sideB })), teamA: teamA.map((p) => p.id), now: new Date(daysAgo(days).getTime() + 2 * HOUR) });

  it("reads the crew's scored matches in the season, with the sets each pair won, and nothing else", async () => {
    const [ana, ben, cid, dee] = [await makePlayer(db, "Ana Ortiz"), await makePlayer(db, "Ben"), await makePlayer(db, "Cid"), await makePlayer(db, "Dee")];
    const group = await createGroup(db, { name: "Friday crew", creatorPlayerId: ana.id, tz: "Asia/Bangkok", memberIds: [ben.id, cid.id, dee.id] });
    const won = await crewMatch(group.id, 10, [ana, ben, cid, dee]);
    await score(won.id, ana, [ana, ben], [[6, 4], [3, 6], [7, 5]], 10);
    const lost = await crewMatch(group.id, 3, [ana, ben, cid, dee]);
    await score(lost.id, ana, [ana, cid], [[2, 6], [4, 6]], 3);
    await crewMatch(group.id, 1, [ana, ben, cid, dee]); // played, never scored
    const old = await crewMatch(group.id, 100, [ana, ben, cid, dee]);
    await score(old.id, ana, [ana, ben], [[6, 0]], 100); // before the season
    const other = await createGroup(db, { name: "Sunday crew", creatorPlayerId: ana.id, tz: "Asia/Bangkok", memberIds: [ben.id, cid.id, dee.id] });
    const elsewhere = await crewMatch(other.id, 5, [ana, ben, cid, dee]);
    await score(elsewhere.id, ana, [ana, ben], [[6, 0]], 5); // the same four, another crew

    const seats = await crewSeasonSeats(db, group.id, NOW);
    expect(new Set(seats.map((s) => s.eventId))).toEqual(new Set([won.id, lost.id]));
    expect(seats).toHaveLength(8);
    expect(seats.find((s) => s.eventId === won.id)).toMatchObject({ setsA: 2, setsB: 1 });
    expect(seats.find((s) => s.eventId === lost.id)).toMatchObject({ setsA: 0, setsB: 2 });

    // Ten days ago Ana and Ben won 6-4 3-6 7-5; three days ago Ben and Dee beat Ana and Cid 6-2 6-4.
    const members = [ana, ben, cid, dee].map((p) => ({ playerId: p.id, name: p.displayName }));
    expect(seasonTable(seats, members, NOW)!.map((l) => [l.name, l.played, l.won, l.streak])).toEqual([
      ["Ben", 2, 2, 2],
      ["Ana", 2, 1, 0],
      ["Dee", 2, 1, 1],
      ["Cid", 2, 0, 0],
    ]);
  });
});
