import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, scores, slots, type Player } from "@/db/schema";
import { cityBySlug } from "@/lib/domain/cities";
import { anonymizePlayer } from "@/lib/domain/anonymize";
import { createEvent } from "@/lib/domain/events";
import { setRankingOptIn } from "@/lib/domain/ranking";
import { RECENT_RESULTS, recentResultRows, recentResults, toRecentResult } from "@/lib/domain/recentResults";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";

/**
 * The "Recent results" strip (`src/lib/domain/recentResults.ts`) on a club page and a city page:
 * only matches the organiser listed, over by their own length, with a score, at this club or in this
 * city, newest first and never more than ten. A name shows only for a player who opted in to the
 * rankings, for a result from the last 90 days, and never for a deleted account; every other seat
 * comes back as null, which the strip shows as "Player". The query decides it, so the name of a
 * seat that may not be shown never leaves the database. Each test makes its own matches.
 */

/** Wednesday 10 June 2026, 16:00 in Phuket. Every date below is counted back from here. */
const NOW = new Date("2026-06-10T09:00:00Z");
freezeClock(NOW);
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const phuket = cityBySlug("phuket")!;
let db: Db;
let close: () => Promise<void>;
let four: Player[];
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  four = [await makePlayer(db, "Ana Smith"), await makePlayer(db, "Bo"), await makePlayer(db, "Cy"), await makePlayer(db, "Di")];
  // Ana and Cy switched on "Show me in rankings"; Bo and Di never did (the default).
  await setRankingOptIn(db, four[0].id, true);
  await setRankingOptIn(db, four[2].id, true);
});
afterAll(async () => close());

/** A match at a venue, the four seated (Ana and Bo on side A, unless other seats are given), with these sets. Listed, Phuket time and 90 minutes unless told. */
async function played(venueName: string, startsAt: Date, o: { sets?: [number, number][]; listed?: boolean; tz?: string; seats?: Player[] } = {}) {
  const seated = o.seats ?? four;
  const ev = await createEvent(db, { creatorPlayerId: seated[0].id, type: "match", tz: o.tz ?? "Asia/Bangkok", whenFull: "waitlist", venueName, startsAt, publicListing: o.listed ?? true });
  for (const [i, p] of seated.entries()) {
    await db
      .update(slots)
      .set({ playerId: p.id, status: "joined", team: i < 2 ? "a" : "b" })
      .where(and(eq(slots.eventId, ev.id), eq(slots.position, i + 1)));
  }
  const sets = o.sets ?? [[6, 3], [6, 4]];
  if (sets.length > 0) await db.insert(scores).values(sets.map(([a, b], i) => ({ eventId: ev.id, setNumber: i + 1, sideA: a, sideB: b })));
  return ev;
}

describe("recent results", () => {
  it("lists only scored, finished, listed matches at this club, with sides, sets and only opted-in first names", async () => {
    const shown = await played("Rawai Padel Club", ago(DAY), { sets: [[4, 6], [6, 3], [7, 5]] });
    await played("Rawai Padel Club", ago(2 * DAY), { sets: [] }); // no score
    await played("Rawai Padel Club", ago(30 * 60 * 1000)); // still on: 90 minutes, started half an hour ago
    await played("Rawai Padel Club", ago(3 * DAY), { listed: false }); // the organiser never listed it
    const cancelled = await played("Rawai Padel Club", ago(4 * DAY));
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, cancelled.id));
    await played("Rawai Padel Club", ago(200 * DAY)); // older than the half year the city board looks at
    await played("Kata Padel", ago(5 * DAY)); // another club in the city

    const rows = await recentResults(db, { venueSlug: "rawai-padel-club" });
    expect(rows.map((r) => r.code)).toEqual([shown.code]);
    expect(rows[0]).toMatchObject({ a: ["Ana", null], b: ["Cy", null], winner: "a", venueName: "Rawai Padel Club", sets: [{ sideA: 4, sideB: 6 }, { sideA: 6, sideB: 3 }, { sideA: 7, sideB: 5 }] });
  });

  it("a city's strip takes every club in the city and nothing outside it", async () => {
    // Its own matches, finished and newer than any other test's, so it reads the same alone or after them.
    const naiHarn = await played("Nai Harn Padel", ago(100 * 60 * 1000));
    const kamala = await played("Kamala Padel", ago(110 * 60 * 1000));
    const singapore = await played("Kallang Padel", ago(105 * 60 * 1000), { tz: "Asia/Singapore" });
    const inPhuket = (await recentResults(db, { city: phuket })).map((r) => r.code);
    expect(inPhuket.slice(0, 2)).toEqual([naiHarn.code, kamala.code]);
    expect(inPhuket).not.toContain(singapore.code);
    expect((await recentResults(db, { city: cityBySlug("singapore")! })).map((r) => r.code)).toEqual([singapore.code]);
  });

  it("names an opted-in player only for a result from the last 90 days; the query hands out no other name", async () => {
    const fresh = await played("Boat Avenue Padel", ago(2 * DAY));
    const old = await played("Boat Avenue Padel", ago(100 * DAY)); // in the strip's half year, past the ranking's 90 days
    const rows = await recentResults(db, { venueSlug: "boat-avenue-padel" });
    expect(rows.map((r) => r.code)).toEqual([fresh.code, old.code]);
    expect(rows[0]).toMatchObject({ a: ["Ana", null], b: ["Cy", null] });
    expect(rows[1]).toMatchObject({ a: [null, null], b: [null, null] });
    // What the database sent: Bo and Di never opted in, and nobody's name came back for the old result.
    const raw = await recentResultRows(db, { venueSlug: "boat-avenue-padel" });
    expect(raw[0].roster!.map((s) => s.name)).toEqual(["Ana Smith", null, "Cy", null]);
    expect(raw[1].roster!.map((s) => s.name)).toEqual([null, null, null, null]);
    expect(raw[1].roster!.every((s) => s.named)).toBe(true);
  });

  it("a deleted account shows as Player, never as \"Deleted\", even if it had opted in", async () => {
    const eve = await makePlayer(db, "Eve Long");
    await setRankingOptIn(db, eve.id, true);
    const ev = await played("Laguna Padel", ago(3 * DAY), { seats: [eve, four[1], four[2], four[3]] });
    await anonymizePlayer(db, eve.id, NOW);
    const [row] = await recentResults(db, { venueSlug: "laguna-padel" });
    expect(row).toMatchObject({ code: ev.code, a: [null, null], b: ["Cy", null] });
    expect(JSON.stringify(await recentResultRows(db, { venueSlug: "laguna-padel" }))).not.toContain("Deleted");
  });

  it("stops at ten scored results, newest first, and unscored matches do not take their places", async () => {
    const made = [];
    for (let i = 0; i < RECENT_RESULTS + 2; i++) made.push(await played("Chalong Padel", ago((i + 1) * 3 * HOUR)));
    // Newer than every scored one, finished, listed, and no score: the limit must count past them.
    for (let i = 0; i < 3; i++) await played("Chalong Padel", ago(2 * HOUR + i * 60 * 1000), { sets: [] });
    const rows = await recentResults(db, { venueSlug: "chalong-padel" });
    expect(rows).toHaveLength(RECENT_RESULTS);
    expect(rows.map((r) => r.code)).toEqual(made.slice(0, RECENT_RESULTS).map((e) => e.code));
  });

  it("a winner-only result keeps its tick and shows no sets; a result with one side empty is left out", () => {
    const base = { code: "ABCD", startsAt: NOW, tz: "UTC", venueName: null, venueSlug: null };
    const roster = [
      { team: "a" as const, status: "joined" as const, name: "Ana Smith", named: true },
      { team: "a" as const, status: "joined" as const, name: "Bo", named: true },
      { team: "b" as const, status: "joined" as const, name: "Cy", named: true },
      { team: "b" as const, status: "joined" as const, name: "Di", named: true },
    ];
    expect(toRecentResult({ ...base, sets: [{ setNumber: 1, sideA: 0, sideB: 1 }], roster })).toMatchObject({ winner: "b", sets: [], a: ["Ana", "Bo"] });
    expect(toRecentResult({ ...base, sets: [{ setNumber: 1, sideA: 6, sideB: 2 }], roster: roster.slice(0, 2) })).toBeNull();
    expect(toRecentResult({ ...base, sets: null, roster })).toBeNull();
  });

  it("a seat the query left unnamed is Player, and an empty invitation is still left out", () => {
    const base = { code: "ABCD", startsAt: NOW, tz: "UTC", venueName: null, venueSlug: null, sets: [{ setNumber: 1, sideA: 6, sideB: 4 }] };
    const roster = [
      { team: "a" as const, status: "joined" as const, name: "Ana Smith", named: true },
      { team: "a" as const, status: "joined" as const, name: null, named: true },
      // A seat the organiser reserved by name: it plays, with no name to show.
      { team: "b" as const, status: "invited" as const, name: null, named: true },
      { team: "b" as const, status: "joined" as const, name: null, named: true },
      // An invitation with no name at all: not in the line-up.
      { team: "b" as const, status: "invited" as const, name: null, named: false },
    ];
    expect(toRecentResult({ ...base, roster })).toMatchObject({ a: ["Ana", null], b: [null, null], winner: "a" });
  });
});
