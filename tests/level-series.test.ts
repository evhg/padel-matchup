import { describe, expect, it } from "vitest";
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

  it("orders results by time, starts from the first 'from', closes with today, counts results", () => {
    const s = levelSeries({ level: 3.12, levelLog: log }, NOW)!;
    expect(s.points.map((p) => p.kind)).toEqual(["start", "match", "match", "tournament", "now"]);
    expect(s.points.map((p) => p.level)).toEqual([3, 3.04, 3.0, 3.12, 3.12]);
    expect(s.points[3].code).toBe("BBBB");
    expect(s.results).toBe(3);
    expect(s.min).toBe(3);
    expect(s.max).toBe(3.12);
    expect(s.confirmed).toBe(false);
  });

  it("marks a confirmation that still holds, and a confirmation alone makes a line", () => {
    const s = levelSeries({ level: 3.25, levelLog: log, levelVerifiedAt: new Date("2026-08-20T10:00:00Z"), levelVerifiedLevel: 3.25 }, NOW)!;
    expect(s.confirmed).toBe(true);
    expect(s.points.map((p) => p.kind)).toEqual(["start", "match", "match", "tournament", "confirmed", "now"]);
    // Drifted a full step since: the tick no longer holds, so it is not drawn.
    const far = levelSeries({ level: 4.5, levelLog: log, levelVerifiedAt: new Date("2026-08-20T10:00:00Z"), levelVerifiedLevel: 3.25 }, NOW)!;
    expect(far.points.some((p) => p.kind === "confirmed")).toBe(false);
    const only = levelSeries({ level: 3, levelLog: [], levelVerifiedAt: new Date("2026-08-20T10:00:00Z"), levelVerifiedLevel: 3 }, NOW)!;
    expect(only.points.map((p) => p.kind)).toEqual(["confirmed", "now"]);
    // Today is not repeated when the last point is today's number from today.
    const fresh = levelSeries({ level: 3, levelLog: [], levelVerifiedAt: NOW, levelVerifiedLevel: 3 }, NOW);
    expect(fresh).toBeNull();
  });

  it("draws inside the box, at least one level tall, time left to right", () => {
    const s = levelSeries({ level: 3.12, levelLog: log }, NOW)!;
    const g = lineGeometry(s, 320, 96, 10);
    expect(g.points).toHaveLength(5);
    expect(g.points[0].x).toBe(10);
    expect(g.points[4].x).toBe(310);
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
    // Same-moment points spread evenly instead of stacking.
    const same = levelSeries({ level: 3, levelLog: [], levelVerifiedAt: new Date("2026-09-01T10:00:00Z"), levelVerifiedLevel: 3 }, new Date("2026-09-01T10:00:00Z"));
    expect(same).toBeNull();
  });
});
