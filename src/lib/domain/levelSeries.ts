import type { LevelLogEntry } from "@/db/schema";
import { LEVEL_MAX, LEVEL_MIN, isLevelVerified } from "./levels";

/**
 * A level over time, pure: the line the passport draws. Points come from the
 * result log (each finalized match or tournament that nudged the number), the
 * confirmation when the tick still holds, and today. Fewer than two points is
 * not a line, so the caller draws nothing.
 */
export type LevelPointKind = "start" | "match" | "tournament" | "confirmed" | "now";
export type LevelPoint = { at: Date; level: number; kind: LevelPointKind; code?: string };
export type LevelSeries = { points: LevelPoint[]; results: number; min: number; max: number; confirmed: boolean };

type Rated = { level: number | null; levelLog?: LevelLogEntry[] | null; levelVerifiedAt?: Date | null; levelVerifiedLevel?: number | null; levelUpdatedAt?: Date | null };

export function levelSeries(p: Rated, now = new Date()): LevelSeries | null {
  if (p.level == null) return null;
  const log = (p.levelLog ?? []).filter((e) => Number.isFinite(e.from) && Number.isFinite(e.to) && !Number.isNaN(Date.parse(e.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const points: LevelPoint[] = [];
  if (log.length > 0) {
    points.push({ at: new Date(log[0].at), level: log[0].from, kind: "start" });
    for (const e of log) points.push({ at: new Date(e.at), level: e.to, kind: e.type === "tournament" ? "tournament" : "match", code: e.code });
  }
  const confirmed = isLevelVerified({ level: p.level, levelVerifiedLevel: p.levelVerifiedLevel ?? null });
  if (confirmed && p.levelVerifiedAt && p.levelVerifiedLevel != null) points.push({ at: p.levelVerifiedAt, level: p.levelVerifiedLevel, kind: "confirmed" });
  points.sort((a, b) => a.at.getTime() - b.at.getTime());
  const last = points[points.length - 1];
  // Today closes the line unless the last point already is today's number.
  if (!last || Math.abs(last.level - p.level) > 1e-9 || now.getTime() - last.at.getTime() > 86_400_000) points.push({ at: now, level: p.level, kind: "now" });
  if (points.length < 2) return null;
  const levels = points.map((x) => x.level);
  return { points, results: log.length, min: Math.min(...levels), max: Math.max(...levels), confirmed };
}

export type LinePoint = { x: number; y: number; kind: LevelPointKind };
export type LineGeometry = { width: number; height: number; path: string; points: LinePoint[]; yTicks: { y: number; label: number }[] };

/** Scales the series into a small drawing: time left to right, level bottom to top, at least one full level tall. */
export function lineGeometry(s: LevelSeries, width = 320, height = 96, pad = 10): LineGeometry {
  const t0 = s.points[0].at.getTime();
  const t1 = s.points[s.points.length - 1].at.getTime();
  const lo = Math.max(LEVEL_MIN, Math.floor((s.min - 0.25) * 2) / 2);
  const hi = Math.min(LEVEL_MAX, Math.max(lo + 1, Math.ceil((s.max + 0.25) * 2) / 2));
  const n = s.points.length;
  const x = (i: number, t: number) => (t1 > t0 ? pad + ((t - t0) / (t1 - t0)) * (width - 2 * pad) : pad + (i / Math.max(1, n - 1)) * (width - 2 * pad));
  const y = (l: number) => pad + (1 - (l - lo) / (hi - lo)) * (height - 2 * pad);
  const pts = s.points.map((p, i) => ({ x: Math.round(x(i, p.at.getTime()) * 10) / 10, y: Math.round(y(p.level) * 10) / 10, kind: p.kind }));
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
  const yTicks = [lo, hi].map((l) => ({ y: Math.round(y(l) * 10) / 10, label: l }));
  return { width, height, path, points: pts, yTicks };
}
