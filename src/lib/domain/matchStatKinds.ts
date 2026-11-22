/**
 * The numbers a filmed match can carry: which kinds exist, what a value may be, and how a board orders them.
 * Pure, and safe in a browser. The rows are in `matchStats.ts`.
 *
 * The owner's decisions of 22 November 2026:
 *   - a number goes on a card or a board only when it is known to 10% or better (`MAX_MARGIN`),
 *   - the numbers of a player show to the match, on the club's board and on the public profile,
 *   - the heart rate is health data: it is kept only for a player who said yes (`health`).
 *
 * A kind is a text in the row and an entry here, not a Postgres enum, so a new kind is a line in this
 * file and three messages, never a migration. Every kind is "higher is better": a board sorts down.
 */
export const STAT_KINDS = {
  /** Games won one after another by a pair. */
  gamesInRow: { unit: "count", pair: true, health: false, min: 2, max: 24 },
  /** Games a pair won on the other pair's serve. */
  breaks: { unit: "count", pair: true, health: false, min: 1, max: 40 },
  /** Share of the points a player won in the games that player served. */
  servePointsWon: { unit: "percent", pair: false, health: false, min: 0, max: 100 },
  /** The longest rally of the match, for the pair that won it. */
  longestRally: { unit: "seconds", pair: true, health: false, min: 3, max: 600 },
  /** The fastest shot that was timed between two known places and checked on the frames. */
  fastestShot: { unit: "kmh", pair: false, health: false, min: 20, max: 250 },
  /** The highest minute of a player's heart rate. Health data. */
  heartRateMax: { unit: "bpm", pair: false, health: true, min: 60, max: 230 },
  /** How far a player moved during the points. */
  distance: { unit: "metres", pair: false, health: false, min: 100, max: 20000 },
} as const;

export type StatKind = keyof typeof STAT_KINDS;
export type StatUnit = (typeof STAT_KINDS)[StatKind]["unit"];
export const STAT_KIND_NAMES = Object.keys(STAT_KINDS) as StatKind[];

/** How far off a number may be and still be shown, as a share of the number. The owner's 10%. */
export const MAX_MARGIN = 0.1;
/** At most this many rows of one kind on a board. */
export const BOARD_ROWS = 3;

export const isStatKind = (k: unknown): k is StatKind => typeof k === "string" && Object.hasOwn(STAT_KINDS, k);
export const isHealthKind = (k: StatKind) => STAT_KINDS[k].health;

export type StatRefusal = "unknown_kind" | "bad_value" | "bad_margin" | "needs_partner" | "no_partner";
export type StatVerdict = { ok: true; kind: StatKind; value: number; margin: number | null } | { ok: false; why: StatRefusal };

/**
 * May this number be kept? A value outside what the kind can be is a mistake of the sender, and a margin
 * above `MAX_MARGIN` is a number that is not good enough to show. A pair's number names the partner, and a
 * player's number names none.
 */
export function checkStat(i: { kind: unknown; value: unknown; margin?: unknown; partner?: unknown }): StatVerdict {
  if (!isStatKind(i.kind)) return { ok: false, why: "unknown_kind" };
  const rule = STAT_KINDS[i.kind];
  if (typeof i.value !== "number" || !Number.isFinite(i.value)) return { ok: false, why: "bad_value" };
  const value = Math.round(i.value * 10) / 10;
  if (value < rule.min || value > rule.max) return { ok: false, why: "bad_value" };
  let margin: number | null = null;
  if (i.margin != null) {
    if (typeof i.margin !== "number" || !Number.isFinite(i.margin) || i.margin < 0) return { ok: false, why: "bad_margin" };
    margin = Math.round(i.margin * 100) / 100;
    if (margin > MAX_MARGIN) return { ok: false, why: "bad_margin" };
  }
  const partner = i.partner != null && i.partner !== "";
  if (rule.pair && !partner) return { ok: false, why: "needs_partner" };
  if (!rule.pair && partner) return { ok: false, why: "no_partner" };
  return { ok: true, kind: i.kind, value, margin };
}

/** What a screen writes for a value: the digits, and which unit message follows them. */
export function statNumber(kind: StatKind, value: number): { digits: string; unit: StatUnit } {
  const unit = STAT_KINDS[kind].unit;
  if (unit === "metres") return { digits: (Math.round(value / 100) / 10).toFixed(1), unit };
  return { digits: String(Math.round(value)), unit };
}

/** The shape a board and a list of bests read. A pair's number is one row for each of its two players. */
export type StatLine = { kind: string; value: number; playerId: string; partnerId: string | null };

/** The best row of each kind, in the order of `STAT_KINDS`. */
export function bestsOf<T extends StatLine>(rows: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    if (!isStatKind(r.kind)) continue;
    const b = best.get(r.kind);
    if (!b || r.value > b.value) best.set(r.kind, r);
  }
  return STAT_KIND_NAMES.flatMap((k) => (best.has(k) ? [best.get(k)!] : []));
}

/**
 * One row for each pair: a pair's number is kept for both players, and a board names the pair once.
 * The row of the player whose id sorts first stays.
 */
export function oncePerPair<T extends StatLine>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.partnerId == null || r.playerId < r.partnerId);
}

/** The board of one kind: the highest values first, a pair once, `BOARD_ROWS` at most. */
export function boardOf<T extends StatLine>(rows: readonly T[], kind: StatKind, n = BOARD_ROWS): T[] {
  return oncePerPair(rows.filter((r) => r.kind === kind))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}
