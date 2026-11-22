import { describe, expect, it } from "vitest";
import { BOARD_ROWS, MAX_MARGIN, STAT_KIND_NAMES, STAT_KINDS, bestsOf, boardOf, checkStat, isHealthKind, oncePerPair, statNumber } from "@/lib/domain/matchStatKinds";

describe("which number of a match may be kept", () => {
  it("keeps a player's number inside what the kind can be, rounded to one decimal", () => {
    expect(checkStat({ kind: "fastestShot", value: 84.26, margin: 0.1 })).toEqual({ ok: true, kind: "fastestShot", value: 84.3, margin: 0.1 });
    expect(checkStat({ kind: "servePointsWon", value: 68 })).toEqual({ ok: true, kind: "servePointsWon", value: 68, margin: null });
  });

  it("refuses a kind it does not know, and a value that is not a number", () => {
    expect(checkStat({ kind: "aces", value: 3 })).toEqual({ ok: false, why: "unknown_kind" });
    expect(checkStat({ kind: "toString", value: 3 })).toEqual({ ok: false, why: "unknown_kind" });
    expect(checkStat({ kind: "fastestShot", value: "84" })).toEqual({ ok: false, why: "bad_value" });
    expect(checkStat({ kind: "fastestShot", value: Number.NaN })).toEqual({ ok: false, why: "bad_value" });
  });

  it("refuses a value outside the kind's range: 388 km/h is a chain that started late, not a shot", () => {
    expect(checkStat({ kind: "fastestShot", value: 388 })).toEqual({ ok: false, why: "bad_value" });
    expect(checkStat({ kind: "servePointsWon", value: 101 })).toEqual({ ok: false, why: "bad_value" });
    expect(checkStat({ kind: "heartRateMax", value: 30 })).toEqual({ ok: false, why: "bad_value" });
  });

  it("refuses a number that is known to worse than 10%", () => {
    expect(MAX_MARGIN).toBe(0.1);
    expect(checkStat({ kind: "fastestShot", value: 73, margin: 0.2 })).toEqual({ ok: false, why: "bad_margin" });
    expect(checkStat({ kind: "fastestShot", value: 73, margin: -0.01 })).toEqual({ ok: false, why: "bad_margin" });
    expect(checkStat({ kind: "fastestShot", value: 84, margin: 0.104 })).toMatchObject({ ok: true, margin: 0.1 });
  });

  it("asks a pair's number for the partner, and a player's number for none", () => {
    expect(checkStat({ kind: "gamesInRow", value: 8 })).toEqual({ ok: false, why: "needs_partner" });
    expect(checkStat({ kind: "gamesInRow", value: 8, partner: "p2" })).toMatchObject({ ok: true, value: 8 });
    expect(checkStat({ kind: "fastestShot", value: 84, partner: "p2" })).toEqual({ ok: false, why: "no_partner" });
  });

  it("names the heart rate as the one kind of health data", () => {
    expect(STAT_KIND_NAMES.filter(isHealthKind)).toEqual(["heartRateMax"]);
  });

  it("gives each kind a range with a floor under its ceiling", () => {
    for (const k of STAT_KIND_NAMES) expect(STAT_KINDS[k].min).toBeLessThan(STAT_KINDS[k].max);
  });
});

describe("how a number reads", () => {
  it("writes whole numbers, and a distance in kilometres with one decimal", () => {
    expect(statNumber("fastestShot", 84.3)).toEqual({ digits: "84", unit: "kmh" });
    expect(statNumber("servePointsWon", 68)).toEqual({ digits: "68", unit: "percent" });
    expect(statNumber("distance", 1380)).toEqual({ digits: "1.4", unit: "metres" });
  });
});

describe("bests and boards", () => {
  const row = (kind: string, value: number, playerId: string, partnerId: string | null = null) => ({ kind, value, playerId, partnerId });
  const rows = [
    row("fastestShot", 84, "a"), row("fastestShot", 52, "b"), row("fastestShot", 75, "a"), row("fastestShot", 50, "c"),
    row("gamesInRow", 8, "c", "d"), row("gamesInRow", 8, "d", "c"), row("gamesInRow", 3, "a", "b"), row("gamesInRow", 3, "b", "a"),
    row("somethingOld", 99, "a"),
  ];

  it("keeps the best row of each kind, in the order of the kinds, and drops a kind it no longer knows", () => {
    expect(bestsOf(rows).map((r) => [r.kind, r.value])).toEqual([["gamesInRow", 8], ["fastestShot", 84]]);
  });

  it("names a pair once", () => {
    expect(oncePerPair(rows.filter((r) => r.kind === "gamesInRow")).map((r) => r.playerId)).toEqual(["c", "a"]);
  });

  it("orders a board from the top and stops at its length", () => {
    expect(BOARD_ROWS).toBe(3);
    expect(boardOf(rows, "fastestShot").map((r) => r.value)).toEqual([84, 75, 52]);
    expect(boardOf(rows, "gamesInRow").map((r) => [r.playerId, r.value])).toEqual([["c", 8], ["a", 3]]);
  });
});
