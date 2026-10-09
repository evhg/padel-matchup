import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, scores, slots, type Player } from "@/db/schema";
import { cityBySlug } from "@/lib/domain/cities";
import { createEvent } from "@/lib/domain/events";
import { RECENT_RESULTS, recentResults, toRecentResult } from "@/lib/domain/recentResults";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";

/**
 * The "Recent results" strip (`src/lib/domain/recentResults.ts`) on a club page and a city page:
 * only matches the organiser listed, over by their own length, with a score, at this club or in this
 * city, newest first and never more than ten.
 */

/** Wednesday 10 June 2026, 16:00 in Phuket. Every date below is counted back from here. */
const NOW = new Date("2026-06-10T09:00:00Z");
freezeClock(NOW);
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const phuket = cityBySlug("phuket")!;
let db: Db;
let close: () => Promise<void>;
let four: Player[];
/** Set by the first test, read by the second: the one Rawai result and the Kata one. */
const codes = { rawai: "", kata: "" };
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  four = [await makePlayer(db, "Ana Smith"), await makePlayer(db, "Bo"), await makePlayer(db, "Cy"), await makePlayer(db, "Di")];
});
afterAll(async () => close());

/** A match at a venue, the four seated (Ana and Bo on side A), with these sets. Listed, Phuket time and 90 minutes unless told. */
async function played(venueName: string, startsAt: Date, o: { sets?: [number, number][]; listed?: boolean; tz?: string } = {}) {
  const ev = await createEvent(db, { creatorPlayerId: four[0].id, type: "match", tz: o.tz ?? "Asia/Bangkok", whenFull: "waitlist", venueName, startsAt, publicListing: o.listed ?? true });
  for (const [i, p] of four.entries()) {
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
  it("lists only scored, finished, listed matches at this club, with first names, sides and sets", async () => {
    const shown = await played("Rawai Padel Club", ago(DAY), { sets: [[4, 6], [6, 3], [7, 5]] });
    await played("Rawai Padel Club", ago(2 * DAY), { sets: [] }); // no score
    await played("Rawai Padel Club", ago(30 * 60 * 1000)); // still on: 90 minutes, started half an hour ago
    await played("Rawai Padel Club", ago(3 * DAY), { listed: false }); // the organiser never listed it
    const cancelled = await played("Rawai Padel Club", ago(4 * DAY));
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, cancelled.id));
    await played("Rawai Padel Club", ago(200 * DAY)); // older than the half year the city board looks at
    codes.kata = (await played("Kata Padel", ago(5 * DAY))).code; // another club in the city
    codes.rawai = shown.code;

    const rows = await recentResults(db, { venueSlug: "rawai-padel-club" });
    expect(rows.map((r) => r.code)).toEqual([shown.code]);
    expect(rows[0]).toMatchObject({ a: ["Ana", "Bo"], b: ["Cy", "Di"], winner: "a", venueName: "Rawai Padel Club", sets: [{ sideA: 4, sideB: 6 }, { sideA: 6, sideB: 3 }, { sideA: 7, sideB: 5 }] });
  });

  it("a city's strip takes every club in the city and nothing outside it", async () => {
    const singapore = await played("Kallang Padel", ago(DAY + HOUR), { tz: "Asia/Singapore" });
    expect((await recentResults(db, { city: phuket })).map((r) => r.code)).toEqual([codes.rawai, codes.kata]);
    expect((await recentResults(db, { city: cityBySlug("singapore")! })).map((r) => r.code)).toEqual([singapore.code]);
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
      { team: "a" as const, status: "joined" as const, name: "Ana Smith" },
      { team: "a" as const, status: "joined" as const, name: "Bo" },
      { team: "b" as const, status: "joined" as const, name: "Cy" },
      { team: "b" as const, status: "joined" as const, name: "Di" },
    ];
    expect(toRecentResult({ ...base, sets: [{ setNumber: 1, sideA: 0, sideB: 1 }], roster })).toMatchObject({ winner: "b", sets: [], a: ["Ana", "Bo"] });
    expect(toRecentResult({ ...base, sets: [{ setNumber: 1, sideA: 6, sideB: 2 }], roster: roster.slice(0, 2) })).toBeNull();
    expect(toRecentResult({ ...base, sets: null, roster })).toBeNull();
  });
});
