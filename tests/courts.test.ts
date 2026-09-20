import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { clubCourts, clubs } from "@/db/schema";
import { claimClub, decideClub } from "@/lib/domain/clubs";
import { cleanCourts, countsOf, courtNamesBySlug, courtNumber, listCourts, numberedCourts, replaceCourts } from "@/lib/domain/courts";
import { venuesForPicking } from "@/lib/domain/clubs";
import { createTestDb, makePlayer } from "./helpers/db";

/** A club's courts as rows, and the three counts that follow them. */
describe("the courts model", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  it("reads a number from a name, cleans a list, refuses a name twice, and derives the counts", () => {
    expect(courtNumber("Court 3")).toBe(3);
    expect(courtNumber("Pista 12")).toBe(12);
    expect(courtNumber("7")).toBe(7);
    expect(courtNumber("Centre")).toBeNull();
    expect(courtNumber("Court 1 and 2")).toBeNull();
    const clean = cleanCourts([{ name: "  Court  1 ", kind: "indoor" }, { name: "Centre", kind: "outdoor" }, { name: "", kind: "indoor" }, { name: "Court 3", kind: "roof" }, { name: "Court 9", number: 4 }]);
    expect(clean).toEqual([
      { name: "Court 1", number: 1, kind: "indoor" },
      { name: "Centre", number: null, kind: "outdoor" },
      { name: "Court 3", number: 3, kind: null },
      { name: "Court 9", number: 4, kind: null },
    ]);
    expect(() => cleanCourts([{ name: "Court 1" }, { name: "court 1" }])).toThrow(/court_name_twice/);
    expect(countsOf(clean)).toEqual({ courts: 4, courtsIndoor: 1, courtsOutdoor: 1 });
    expect(countsOf([{ kind: null }, { kind: null }])).toEqual({ courts: 2, courtsIndoor: null, courtsOutdoor: null });
    expect(countsOf([])).toEqual({ courts: null, courtsIndoor: null, courtsOutdoor: null });
    expect(numberedCourts(3, "Pista").map((c) => c.name)).toEqual(["Pista 1", "Pista 2", "Pista 3"]);
  });

  it("replaces the club's courts as a set through the manage token, keeps the counts in step, and hands the names to the match form", async () => {
    const pim = await makePlayer(db, "Pim");
    const club = await claimClub(db, { name: "Chiang Mai Padel", playerId: pim.id, tz: "Asia/Bangkok", courts: 6, courtsIndoor: 4, courtsOutdoor: 2 });
    // The picker lists live clubs only, so the owner's tap comes first.
    await decideClub(db, club.slug, true);
    expect(await replaceCourts(db, "nope", [{ name: "Court 1" }])).toBeNull();
    const r = await replaceCourts(db, club.manageToken, [
      { name: "Court 1", kind: "indoor" },
      { name: "Court 2", kind: "indoor" },
      { name: "Centre", kind: "outdoor" },
    ]);
    expect(r?.courts.map((c) => [c.name, c.number, c.kind, c.position])).toEqual([
      ["Court 1", 1, "indoor", 0],
      ["Court 2", 2, "indoor", 1],
      ["Centre", null, "outdoor", 2],
    ]);
    // The typed counts (6, 4, 2) gave way to what the rows say.
    expect([r?.club.courts, r?.club.courtsIndoor, r?.club.courtsOutdoor]).toEqual([3, 2, 1]);
    // The match form's picker carries the names for this club.
    const picks = await venuesForPicking(db, pim.id, { tz: "Asia/Bangkok", city: null });
    expect(picks.find((v) => v.slug === club.slug)?.courtNames).toEqual(["Court 1", "Court 2", "Centre"]);
    expect((await courtNamesBySlug(db, [club.slug, "nowhere"])).get(club.slug)).toEqual(["Court 1", "Court 2", "Centre"]);
    // Replaced again: the old rows are gone, the new order stands.
    const again = await replaceCourts(db, club.manageToken, [{ name: "Centre", kind: "outdoor" }, { name: "Court 1", kind: "indoor" }]);
    expect(again?.courts.map((c) => c.name)).toEqual(["Centre", "Court 1"]);
    expect([again?.club.courts, again?.club.courtsIndoor, again?.club.courtsOutdoor]).toEqual([2, 1, 1]);
    // An empty list clears the rows and leaves the counts alone: a club that lists nothing loses nothing.
    const cleared = await replaceCourts(db, club.manageToken, []);
    expect(await listCourts(db, club.slug)).toEqual([]);
    expect([cleared?.club.courts, cleared?.club.courtsIndoor, cleared?.club.courtsOutdoor]).toEqual([2, 1, 1]);
    // The rows go with the club.
    await replaceCourts(db, club.manageToken, [{ name: "Court 1" }]);
    await db.delete(clubs).where(eq(clubs.slug, club.slug));
    expect(await db.select().from(clubCourts).where(eq(clubCourts.clubSlug, club.slug))).toEqual([]);
  });
});
