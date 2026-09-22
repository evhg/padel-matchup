import { describe, expect, it } from "vitest";
import { courtDay, courtsInUse, sameCourt, type Busy } from "@/lib/domain/courts";

/**
 * Roadmap item 4: the club has its courts as rows already, and could not see which of them were
 * busy. A match names a court and a lesson now does too, so the two together are the club's own
 * capacity. The matching is the part worth testing: a player types "3" where the club writes
 * "Court 3", and a booking that named nothing must never be placed on a guess.
 */
const at = (hhmm: string) => new Date(`2026-09-22T${hhmm}:00Z`);
const match = (court: string | null, hhmm: string, title: string | null = null): Busy => ({ court, startsAt: at(hhmm), minutes: 120, kind: "match", title });
const lesson = (court: string | null, hhmm: string): Busy => ({ court, startsAt: at(hhmm), minutes: 60, kind: "lesson", title: null });

describe("sameCourt", () => {
  it("reads a number through whatever word is in front of it", () => {
    for (const [a, b] of [["Court 3", "3"], ["3", "Pista 3"], ["Cancha 2", "court 2"], ["Court 10", "10"]]) {
      expect(sameCourt(a, b)).toBe(true);
    }
  });

  it("keeps two different courts apart, numbered or not", () => {
    expect(sameCourt("Court 3", "Court 4")).toBe(false);
    expect(sameCourt("Centre", "Court 1")).toBe(false);
    // Two unnumbered names match only when they read the same.
    expect(sameCourt("Centre", " centre ")).toBe(true);
    expect(sameCourt("Centre", "Show court")).toBe(false);
  });

  it("never matches on nothing: an empty court name is not a court", () => {
    expect(sameCourt(null, "Court 1")).toBe(false);
    expect(sameCourt("Court 1", "")).toBe(false);
    expect(sameCourt("   ", "   ")).toBe(false);
  });
});

describe("courtDay", () => {
  const courts = ["Court 1", "Court 2", "Centre"];

  it("puts each booking on the club's own court, in the club's order and in time order", () => {
    const rows = courtDay(courts, [match("2", "18:00", "Friday social"), lesson("Court 1", "09:00"), match("Court 1", "07:00"), lesson("centre", "12:00")]);
    expect(rows.map((r) => r.name)).toEqual(["Court 1", "Court 2", "Centre"]);
    expect(rows[0].blocks.map((b) => b.startsAt.toISOString())).toEqual([at("07:00").toISOString(), at("09:00").toISOString()]);
    expect(rows[1].blocks.map((b) => b.title)).toEqual(["Friday social"]);
    expect(rows[2].blocks).toHaveLength(1);
  });

  it("gives whatever named no court of theirs a row of its own, rather than a guess", () => {
    const rows = courtDay(courts, [match(null, "10:00"), match("Court 9", "11:00"), lesson("Court 2", "08:00")]);
    expect(rows).toHaveLength(4);
    expect(rows[3].name).toBeNull();
    expect(rows[3].blocks).toHaveLength(2);
    // And the one that did name a court is still on it.
    expect(rows[1].blocks).toHaveLength(1);
  });

  it("adds no extra row when everything found its court", () => {
    expect(courtDay(courts, [match("1", "10:00")]).map((r) => r.name)).toEqual(courts);
    expect(courtDay(courts, [])).toHaveLength(3);
  });

  it("does not split a day when a club typed one court twice", () => {
    const rows = courtDay(["Court 1", "court 1"], [match("1", "10:00"), match("Court 1", "12:00")]);
    expect(rows[0].blocks).toHaveLength(2);
    expect(rows[1].blocks).toHaveLength(0);
  });

  it("counts only the club's own courts as in use", () => {
    const rows = courtDay(courts, [match(null, "10:00"), lesson("Court 2", "08:00")]);
    // The loose row holds a booking, and it is not one of the club's courts.
    expect(courtsInUse(rows)).toBe(1);
    expect(courtsInUse(courtDay(courts, []))).toBe(0);
  });
});
