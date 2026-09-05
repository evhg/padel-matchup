/**
 * Padel levels, framework-free. 0–7 like the apps players already know:
 * self-declared in quarter steps, nudged by results in hundredths.
 */
export const LEVEL_MIN = 0;
export const LEVEL_MAX = 7;
export const LEVEL_STEP = 0.25;
export const LEVEL_STEPS: readonly number[] = Array.from({ length: (LEVEL_MAX - LEVEL_MIN) / LEVEL_STEP + 1 }, (_, i) => LEVEL_MIN + i * LEVEL_STEP);

export type LevelRange = { min: number | null; max: number | null };
export type PresetKey = "bronze" | "silver" | "gold" | "platinum";
export const LEVEL_PRESETS: readonly { key: PresetKey; min: number; max: number }[] = [
  { key: "bronze", min: 1, max: 2.5 },
  { key: "silver", min: 2.5, max: 3.5 },
  { key: "gold", min: 3, max: 4.5 },
  { key: "platinum", min: 4.5, max: LEVEL_MAX },
];

export type BandKey = "starting" | "beginner" | "intermediate" | "advanced" | "expert" | "pro";
export const LEVEL_BANDS: readonly { key: BandKey; min: number; max: number }[] = [
  { key: "starting", min: 0, max: 1.5 },
  { key: "beginner", min: 1.5, max: 2.5 },
  { key: "intermediate", min: 2.5, max: 3.5 },
  { key: "advanced", min: 3.5, max: 4.5 },
  { key: "expert", min: 4.5, max: 5.5 },
  { key: "pro", min: 5.5, max: LEVEL_MAX },
];

export function bandOf(level: number): BandKey {
  let band: BandKey = "starting";
  for (const b of LEVEL_BANDS) if (level >= b.min) band = b.key;
  return band;
}

/** Self-declared input → quarter step inside 0–7, or null when not a number. */
export function normalizeLevel(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const q = Math.round(n / LEVEL_STEP) * LEVEL_STEP;
  return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, q));
}

/** Result-adjusted value → two decimals inside 0–7. */
export function clampLevel(n: number): number {
  return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, Math.round(n * 100) / 100));
}

/** 3 → "3.0", 3.5 → "3.5", 3.25 → "3.25", 3.27 → "3.27". */
export function formatLevel(level: number): string {
  const r = Math.round(level * 100) / 100;
  return Number.isInteger(Math.round(r * 10)) && Math.abs(r * 10 - Math.round(r * 10)) < 1e-9 ? r.toFixed(1) : r.toFixed(2);
}

/** Cleans a range: quarter steps, min ≤ max, and "everything" collapses to open (null, null). */
export function normalizeRange(min: unknown, max: unknown): LevelRange {
  let lo = normalizeLevel(min);
  let hi = normalizeLevel(max);
  if (lo != null && hi != null && lo > hi) [lo, hi] = [hi, lo];
  if (lo != null && lo <= LEVEL_MIN) lo = null;
  if (hi != null && hi >= LEVEL_MAX) hi = null;
  return { min: lo, max: hi };
}

export const hasRange = (r: LevelRange | null | undefined): r is LevelRange => Boolean(r && (r.min != null || r.max != null));

export function rangeFor(preset: PresetKey): LevelRange {
  const p = LEVEL_PRESETS.find((x) => x.key === preset)!;
  return normalizeRange(p.min, p.max);
}

/** Which preset a stored range is, "custom" for anything else, null when open. */
export function presetFor(r: LevelRange | null | undefined): PresetKey | "custom" | null {
  if (!hasRange(r)) return null;
  for (const p of LEVEL_PRESETS) {
    const pr = rangeFor(p.key);
    if (pr.min === r.min && pr.max === r.max) return p.key;
  }
  return "custom";
}

export type LevelFit = "ok" | "unknown" | "below" | "above";

/** Does a player's level fit the event? Open events fit everyone, even players without a level. */
export function levelFit(r: LevelRange | null | undefined, level: number | null | undefined): LevelFit {
  if (!hasRange(r)) return "ok";
  if (level == null) return "unknown";
  if (r.min != null && level < r.min - 1e-9) return "below";
  if (r.max != null && level > r.max + 1e-9) return "above";
  return "ok";
}

/** "3.0–4.5", "4.5+", "up to 2.5" (the wording comes from the caller's strings). */
export function formatRange(r: LevelRange, o: { between: (min: string, max: string) => string; plus: (min: string) => string; upTo: (max: string) => string }): string {
  if (r.min != null && r.max != null) return o.between(formatLevel(r.min), formatLevel(r.max));
  if (r.min != null) return o.plus(formatLevel(r.min));
  if (r.max != null) return o.upTo(formatLevel(r.max));
  return "";
}

type Rated = { id: string; level: number | null };

/** For exactly four rated players: the 2v2 split with the smallest level gap. */
export function balancedTeams(players: readonly Rated[]): { a: [string, string]; b: [string, string]; diff: number } | null {
  if (players.length !== 4 || players.some((p) => p.level == null)) return null;
  const [p0, p1, p2, p3] = players as { id: string; level: number }[];
  const splits: [[typeof p0, typeof p0], [typeof p0, typeof p0]][] = [
    [[p0, p1], [p2, p3]],
    [[p0, p2], [p1, p3]],
    [[p0, p3], [p1, p2]],
  ];
  let best: { a: [string, string]; b: [string, string]; diff: number } | null = null;
  for (const [a, b] of splits) {
    const diff = Math.abs(a[0].level + a[1].level - (b[0].level + b[1].level));
    if (!best || diff < best.diff - 1e-9) best = { a: [a[0].id, a[1].id], b: [b[0].id, b[1].id], diff: Math.round(diff * 100) / 100 };
  }
  return best;
}

/** Logistic expectation: one full level of difference ≈ 10:1 odds. */
export function expectedScore(own: number, opp: number): number {
  return 1 / (1 + Math.pow(10, opp - own));
}

export const MATCH_K = 0.1;
export const TOURNAMENT_K = 0.12;

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Per-player level deltas after a 2v2 result. Each team is rated by the
 * average of its known levels; players without a level neither move nor count.
 */
export function matchDeltas(teamA: readonly Rated[], teamB: readonly Rated[], result: "a" | "b" | "draw"): Map<string, number> {
  const out = new Map<string, number>();
  const la = teamA.filter((p) => p.level != null).map((p) => p.level as number);
  const lb = teamB.filter((p) => p.level != null).map((p) => p.level as number);
  if (la.length === 0 || lb.length === 0) return out;
  const ea = expectedScore(avg(la), avg(lb));
  const sa = result === "a" ? 1 : result === "b" ? 0 : 0.5;
  const da = round2(MATCH_K * (sa - ea));
  for (const p of teamA) if (p.level != null && da !== 0) out.set(p.id, da);
  for (const p of teamB) if (p.level != null && da !== 0) out.set(p.id, -da);
  return out;
}

/**
 * Tournament deltas from finishing rank: first place scores 1, last 0, and
 * each rated player is compared with the rated field's average.
 */
export function tournamentDeltas(rows: readonly { id: string; level: number | null; rank: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const rated = rows.filter((r) => r.level != null);
  if (rated.length < 2 || rows.length < 2) return out;
  const field = avg(rated.map((r) => r.level as number));
  const n = rows.length;
  for (const r of rated) {
    const score = (n - r.rank) / (n - 1);
    const d = round2(TOURNAMENT_K * (score - expectedScore(r.level as number, field)));
    if (d !== 0) out.set(r.id, d);
  }
  return out;
}

/** Half a step of drift keeps an organizer's confirmation valid while results nudge the level. */
export const VERIFIED_TOLERANCE = 0.5;

/** An organizer who played with them confirmed the level, and it has not moved much since. */
export function isLevelVerified(p: { level: number | null; levelVerifiedLevel: number | null }): boolean {
  return p.level != null && p.levelVerifiedLevel != null && Math.abs(p.level - p.levelVerifiedLevel) <= VERIFIED_TOLERANCE;
}
