import { describe, expect, it } from "vitest";
import { LEVEL_LOG_CAP } from "@/lib/domain/levels";
import { levelSeries, lineGeometry } from "@/lib/domain/levelSeries";

const NOW = new Date("2026-09-09T10:00:00Z");
const log = [
  { at: "2026-08-01T10:00:00Z", from: 3, to: 3.04, code: "AAAA", type: "match" as const },
  { at: "2026-08-15T10:00:00Z", from: 3.04, to: 3.12, code: "BBBB", type: "tournament" as const },
  { at: "2026-08-08T10:00:00Z", from: 3.04, to: 3.0, code: "CCCC", type: "match" as const },
];

describe("the level over time", () => {
  it("is nothing without a level or with a single point", () => {
    expect(levelSeries({ level: null }, NOW)).toBeNull();
    // A self-declared level that never moved and was never confirmed: one point, no line.
    expect(levelSeries({ level: 3, levelLog: [] }, NOW)).toBeNull();
  });

  it("orders results by time, starts from the first 'from', draws a step where the number changed between results, closes with today, counts results", () => {
    const s = levelSeries({ level: 3.12, levelLog: log }, NOW)!;
    // The 15 Aug tournament started from 3.04 while the 8 Aug match had left it at 3.0: something moved it by hand in between.
    expect(s.points.map((p) => p.kind)).toEqual(["start", "match", "match", "adjusted", "tournament", "now"]);
    expect(s.points.map((p) => p.level)).toEqual([3, 3.04, 3.0, 3.04, 3.12, 3.12]);
    expect(s.points[4].code).toBe("BBBB");
    expect(s.results).toBe(3);
    expect(s.capped).toBe(false);
    expect(s.min).toBe(3);
    expect(s.max).toBe(3.12);
    expect(s.confirmed).toBe(false);
    // A continuous log draws no step.
    const smooth = levelSeries({ level: 3.12, levelLog: log.filter((e) => e.code !== "CCCC") }, NOW)!;
    expect(smooth.points.map((p) => p.kind)).toEqual(["start", "match", "tournament", "now"]);
  });

  it("says when the log is full, so the caption counts the last results only", () => {
    const full = Array.from({ length: LEVEL_LOG_CAP }, (_, i) => ({ at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), from: 3 + i * 0.01, to: 3 + (i + 1) * 0.01, code: `C${i}`, type: "match" as const }));
    const s = levelSeries({ level: 3 + LEVEL_LOG_CAP * 0.01, levelLog: full }, NOW)!;
    expect(s.results).toBe(LEVEL_LOG_CAP);
    expect(s.capped).toBe(true);
  });

  it("marks a confirmation that still holds, and a confirmation alone makes a line", () => {
    const s = levelSeries({ level: 3.25, levelLog: log, levelVerifiedAt: new Date("2026-08-20T10:00:00Z"), levelVerifiedLevel: 3.25 }, NOW)!;
    expect(s.confirmed).toBe(true);
    expect(s.points.map((p) => p.kind)).toEqual(["start", "match", "match", "adjusted", "tournament", "confirmed", "now"]);
    // Drifted a full step since: the tick no longer holds, so it is not drawn.
    const far = levelSeries({ level: 4.5, levelLog: log, levelVerifiedAt: new Date("2026-08-20T10:00:00Z"), levelVerifiedLevel: 3.25 }, NOW)!;
    expect(far.points.some((p) => p.kind === "confirmed")).toBe(false);
    expect(far.confirmed).toBe(false);
    const only = levelSeries({ level: 3, levelLog: [], levelVerifiedAt: new Date("2026-08-20T10:00:00Z"), levelVerifiedLevel: 3 }, NOW)!;
    expect(only.points.map((p) => p.kind)).toEqual(["confirmed", "now"]);
    // Today is not repeated when the last point is today's number from today.
    const fresh = levelSeries({ level: 3, levelLog: [], levelVerifiedAt: NOW, levelVerifiedLevel: 3 }, NOW);
    expect(fresh).toBeNull();
  });

  it("draws inside the box, at least one level tall, time left to right", () => {
    const s = levelSeries({ level: 3.12, levelLog: log }, NOW)!;
    const g = lineGeometry(s, 320, 96, 10);
    expect(g.points).toHaveLength(6);
    expect(g.points[0].x).toBe(10);
    expect(g.points[5].x).toBe(310);
    for (const p of g.points) {
      expect(p.x).toBeGreaterThanOrEqual(10);
      expect(p.x).toBeLessThanOrEqual(310);
      expect(p.y).toBeGreaterThanOrEqual(10);
      expect(p.y).toBeLessThanOrEqual(86);
    }
    // Higher level, smaller y.
    const byLevel = [...g.points].sort((a, b) => a.y - b.y);
    expect(byLevel[0].kind === "tournament" || byLevel[0].kind === "now").toBe(true);
    expect(g.yTicks.map((tk) => tk.label)).toEqual([2.5, 3.5]);
    expect(g.path.startsWith("M10 ")).toBe(true);
  });

  it("spreads same-moment points evenly, and keeps a full level of height at the top of the scale", () => {
    // A single result from today whose number is today's number: two points at one instant.
    const same = levelSeries({ level: 3.04, levelLog: [{ at: NOW.toISOString(), from: 3, to: 3.04, code: "AAAA", type: "match" }] }, NOW)!;
    expect(same.points).toHaveLength(2);
    const g = lineGeometry(same, 320, 96, 10);
    expect(g.points.map((p) => p.x)).toEqual([10, 310]);
    expect(g.path.includes("NaN")).toBe(false);
    // Confirmed at 7.0 two days ago: the box cannot grow upwards, so it grows downwards, and the top point stays on the padding line, not above it.
    const top = levelSeries({ level: 7, levelLog: [], levelVerifiedAt: new Date(NOW.getTime() - 2 * 86_400_000), levelVerifiedLevel: 7 }, NOW)!;
    const gt = lineGeometry(top, 320, 96, 10);
    expect(gt.yTicks.map((tk) => tk.label)).toEqual([6, 7]);
    for (const p of gt.points) expect(p.y).toBe(10);
  });

  it("keeps a full level of height at the bottom of the scale too", () => {
    // A first result from 0 to 0.04: the box cannot grow downwards, so it grows upwards, and the bottom point sits on the padding line.
    const bottom = levelSeries({ level: 0.04, levelLog: [{ at: "2026-09-01T10:00:00Z", from: 0, to: 0.04, code: "AAAA", type: "match" }] }, NOW)!;
    expect(bottom.points.map((p) => p.level)).toEqual([0, 0.04, 0.04]);
    const g = lineGeometry(bottom, 320, 96, 10);
    expect(g.yTicks.map((tk) => tk.label)).toEqual([0, 1]);
    expect(g.yTicks[1].label - g.yTicks[0].label).toBeGreaterThanOrEqual(1);
    expect(g.points[0].y).toBe(86);
    // 0.04 is a hair above the floor, not halfway up the box.
    expect(g.points[1].y).toBe(83);
    // A level that never left 0 draws the same box.
    const zero = levelSeries({ level: 0, levelLog: [], levelVerifiedAt: new Date(NOW.getTime() - 2 * 86_400_000), levelVerifiedLevel: 0 }, NOW)!;
    expect(lineGeometry(zero, 320, 96, 10).yTicks.map((tk) => tk.label)).toEqual([0, 1]);
    // And the top keeps its full level as before.
    const top = levelSeries({ level: 7, levelLog: [], levelVerifiedAt: new Date(NOW.getTime() - 2 * 86_400_000), levelVerifiedLevel: 7 }, NOW)!;
    const gt = lineGeometry(top, 320, 96, 10);
    expect(gt.yTicks[1].label - gt.yTicks[0].label).toBeGreaterThanOrEqual(1);
  });
});
