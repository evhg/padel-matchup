import { buildHistory, maxCourtsFor, mulberry32, planRound, rotationLength, scheduleRound, seededShuffle, type RoundRef } from "./americano";

/**
 * A whole americano schedule in one call (pure, deterministic for a seed).
 * The public API, the MCP tool, the /americano pages and the npm package all
 * go through here, so a schedule is the same everywhere.
 */
export type ScheduleInput = {
  /** Number of players, 4 to 64; ignored when names are given. Default 8. */
  players?: number;
  /** Player names; at least four to be used. */
  names?: readonly string[];
  /** Courts in play; defaults to floor(players / 4). */
  courts?: number;
  /** Rounds; defaults to players − 1 when the field is in fours (every pair partners once), else players. Max 40. */
  rounds?: number;
  format?: "americano";
  /** Same seed, same schedule. Default 1. */
  seed?: number;
};

export type ScheduleMatch = { court: number; a: [string, string]; b: [string, string] };
export type ScheduleRound = { round: number; matches: ScheduleMatch[]; resting: string[] };
export type ScheduleResult = {
  format: "americano";
  players: number;
  courts: number;
  /** Every pair partners exactly once per cycle (field in fours, all courts used). */
  exact: boolean;
  rounds: ScheduleRound[];
  note: string;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const int = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback);

export function buildSchedule(input: ScheduleInput = {}): ScheduleResult {
  const names = input.names?.map((n) => String(n).trim()).filter(Boolean).slice(0, 64);
  const n = names && names.length >= 4 ? names.length : clamp(int(input.players, 8), 4, 64);
  const label = (i: number) => names?.[i] ?? `Player ${i + 1}`;
  const maxCourts = maxCourtsFor(n);
  const courts = clamp(int(input.courts, maxCourts), 1, maxCourts);
  const cycle = rotationLength(n);
  const exact = Boolean(cycle) && courts === maxCourts;
  const roundCount = clamp(int(input.rounds, exact ? (cycle as number) : n), 1, 40);
  const seed = int(input.seed, 1);
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const rng = mulberry32(seed * 7919 + n);
  const ordered = seededShuffle(ids, mulberry32(seed * 104729 + n));
  const out: ScheduleRound[] = [];
  const refs: RoundRef[] = [];
  const plans: { matches: ScheduleMatch[]; resting: string[] }[] = [];
  for (let r = 0; r < roundCount; r++) {
    let plan: (typeof plans)[number];
    if (exact && cycle && r >= cycle) plan = plans[r - cycle];
    else if (exact) plan = scheduleRound(ordered, r, buildHistory(refs), rng);
    else plan = planRound(ids, courts, buildHistory(refs), rng);
    plans.push(plan);
    refs.push({ matches: plan.matches.map((m) => ({ a1: m.a[0], a2: m.a[1], b1: m.b[0], b2: m.b[1], sideA: null, sideB: null })), resting: plan.resting });
    const idx = (id: string) => Number(id.slice(1));
    out.push({ round: r + 1, matches: plan.matches.map((m) => ({ court: m.court, a: [label(idx(m.a[0])), label(idx(m.a[1]))], b: [label(idx(m.b[0])), label(idx(m.b[1]))] })), resting: plan.resting.map((id) => label(idx(id))) });
  }
  return {
    format: "americano",
    players: n,
    courts,
    exact,
    rounds: out,
    note: exact ? `${roundCount} rounds; every pair partners exactly once every ${cycle} rounds.` : `${n} players on ${courts} court${courts > 1 ? "s" : ""}: ${n - courts * 4} sit out each round, spread fairly.`,
  };
}
