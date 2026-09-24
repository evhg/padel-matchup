import type { MatchPhase } from "@/db/schema";
import { zonedTimeToUtc } from "@/lib/dates";

/**
 * Courts and times, pure: every match of a competition gets a court and a start from the match
 * lengths, the court list and the days' windows, in the order the draw needs them — a round after
 * the round it is built on, a knockout after its groups — with a rest between a pair's matches and
 * never a player on two courts at once. Greedy and deterministic: the earliest free slot, court by
 * court, so the organiser can read the result and move what they must.
 */

export type ScheduleMatch = {
  id: string;
  categoryId: string;
  phase: MatchPhase;
  groupLabel: string | null;
  round: number;
  position: number;
  pairA: string | null;
  pairB: string | null;
  sourceA: string | null;
  sourceB: string | null;
  bye: boolean;
  over: boolean;
  /** What the schedule allows for it. */
  minutes: number;
  /** A slot already given (a match played or pinned by the organiser): kept, and everything else fits around it. */
  fixed?: { courtName: string; startsAt: Date } | null;
  /**
   * The earliest it may start. A two-day weekend plays the groups on Saturday and the knockout on
   * Sunday; without this the greedy fill put the final on Saturday at 18:00 (ROADMAP, 23 September 2026).
   */
  notBefore?: Date | null;
};

export type DayWindow = { date: string; start: string; end: string };

export type ScheduleInput = {
  matches: ScheduleMatch[];
  courts: string[];
  days: DayWindow[];
  tz: string;
  /** Minutes between two matches of the same pair or player. */
  rest?: number;
  /** The grid starts on these minutes: 10 keeps times readable. */
  step?: number;
  /** Pair id → the two player ids, so a player in two categories is never on two courts at once. */
  playersOf?: Map<string, readonly string[]>;
};

export type Slot = { id: string; courtName: string; startsAt: Date; endsAt: Date };
/** The slots given, and how many matches still to play found no room in the windows: counted, never dropped in silence. */
export type Schedule = { slots: Slot[]; unplaced: number };

const MIN = 60_000;

/** The matches a match waits for: the ones its sources name, or every match of its group's phase for a group source. */
function dependencies(m: ScheduleMatch, all: readonly ScheduleMatch[]): ScheduleMatch[] {
  const out: ScheduleMatch[] = [];
  for (const src of [m.sourceA, m.sourceB]) {
    if (!src) continue;
    const [kind, ...rest] = src.split(":");
    if (kind === "G") out.push(...all.filter((x) => x.categoryId === m.categoryId && x.phase === "group" && x.groupLabel === rest[0]));
    else if (kind === "Q") {
      const last = Math.max(0, ...all.filter((x) => x.categoryId === m.categoryId && x.phase === "qualifying").map((x) => x.round));
      out.push(...all.filter((x) => x.categoryId === m.categoryId && x.phase === "qualifying" && x.round === last));
    } else {
      const [phase, round, position] = rest;
      const dep = all.find((x) => x.categoryId === m.categoryId && x.phase === phase && x.round === Number(round) && x.position === Number(position));
      if (dep) out.push(dep);
    }
  }
  return out;
}

const PHASE_ORDER: Record<MatchPhase, number> = { qualifying: 0, group: 1, main: 2, consolation: 3 };

/** A stable order that respects the draw: by phase, then round, then group and position; consolation rides beside the main draw's rounds. */
export function playingOrder(matches: readonly ScheduleMatch[]): ScheduleMatch[] {
  return [...matches].sort((a, b) => {
    const pa = a.phase === "consolation" ? PHASE_ORDER.main : PHASE_ORDER[a.phase];
    const pb = b.phase === "consolation" ? PHASE_ORDER.main : PHASE_ORDER[b.phase];
    if (pa !== pb) return pa - pb;
    if (a.round !== b.round) return a.round - b.round;
    if (a.phase !== b.phase) return PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase];
    if ((a.groupLabel ?? "") !== (b.groupLabel ?? "")) return (a.groupLabel ?? "").localeCompare(b.groupLabel ?? "");
    return a.position - b.position;
  });
}

/** The day windows as instants, in order. */
function windows(days: readonly DayWindow[], tz: string): { from: Date; to: Date }[] {
  return days
    .map((d) => ({ from: zonedTimeToUtc(d.date, d.start, tz), to: zonedTimeToUtc(d.date, d.end, tz) }))
    .filter((w) => w.to.getTime() > w.from.getTime())
    .sort((a, b) => a.from.getTime() - b.from.getTime());
}

/** The first start at or after `at` that fits `minutes` inside a window, on the grid. */
function fitInWindows(at: Date, minutes: number, wins: readonly { from: Date; to: Date }[], step: number): Date | null {
  for (const w of wins) {
    let t = Math.max(at.getTime(), w.from.getTime());
    const rem = (t - w.from.getTime()) % (step * MIN);
    if (rem) t += step * MIN - rem;
    if (t + minutes * MIN <= w.to.getTime()) return new Date(t);
  }
  return null;
}

/**
 * Every match still to play gets a court and a start. Matches already played keep their slot as a
 * constraint on the rest; byes get nothing. A court is a list of busy ranges; a pair and each of
 * its players carry the time they are free again. A match that fits nowhere is counted in
 * `unplaced`, so the organiser hears it rather than finding a match with no time on the day.
 */
export function schedule(input: ScheduleInput): Schedule {
  const rest = input.rest ?? 30;
  const step = input.step ?? 10;
  const wins = windows(input.days, input.tz);
  const all = input.matches;
  if (wins.length === 0 || input.courts.length === 0) return { slots: [], unplaced: all.filter((m) => !m.bye && !m.fixed && !m.over).length };
  const busy = new Map<string, { from: number; to: number }[]>(input.courts.map((c) => [c, []]));
  const freeAt = new Map<string, number>(); // pair or player id → when they are free again
  const endOf = new Map<string, number>(); // match id → when it ends
  const out: Slot[] = [];
  const noRoom = new Set<string>(); // match ids that fit nowhere
  const who = (pairId: string | null): string[] => (pairId ? [pairId, ...(input.playersOf?.get(pairId) ?? [])] : []);
  const courtFree = (court: string, from: number, to: number) => busy.get(court)!.every((b) => to <= b.from || from >= b.to);
  const take = (m: ScheduleMatch, court: string, from: number) => {
    const to = from + m.minutes * MIN;
    if (!busy.has(court)) busy.set(court, []);
    busy.get(court)!.push({ from, to });
    endOf.set(m.id, to);
    for (const id of [...who(m.pairA), ...who(m.pairB)]) freeAt.set(id, Math.max(freeAt.get(id) ?? 0, to + rest * MIN));
  };
  // What is fixed goes first, whatever its place in the order.
  for (const m of all) if (m.fixed && !m.bye) take(m, m.fixed.courtName, m.fixed.startsAt.getTime());
  for (const m of playingOrder(all)) {
    if (m.bye || m.fixed) continue;
    let earliest = Math.max(wins[0].from.getTime(), m.notBefore?.getTime() ?? 0);
    const deps = dependencies(m, all);
    for (const dep of deps) {
      const end = endOf.get(dep.id);
      if (end !== undefined) earliest = Math.max(earliest, end + rest * MIN);
    }
    for (const id of [...who(m.pairA), ...who(m.pairB)]) earliest = Math.max(earliest, freeAt.get(id) ?? 0);
    if (m.over) continue;
    // A match built on one with no time has no time either. A dependency with no slot has no end, so
    // this match used to take the first free court: a consolation final at noon while both of its
    // semi-finals found no room (the short-day probe, 24 September 2026).
    if (deps.some((d) => noRoom.has(d.id))) {
      noRoom.add(m.id);
      continue;
    }
    // The earliest slot on any court; ties go to the first court in the list.
    let best: { court: string; at: number } | null = null;
    for (const court of input.courts) {
      let at = fitInWindows(new Date(earliest), m.minutes, wins, step);
      for (let guard = 0; at && guard < 2000; guard++) {
        const from = at.getTime();
        const to = from + m.minutes * MIN;
        if (courtFree(court, from, to)) break;
        // Jump past the busy range that blocks this start.
        const block = busy.get(court)!.filter((b) => from < b.to && to > b.from).sort((x, y) => x.to - y.to)[0];
        at = fitInWindows(new Date(block ? block.to : from + step * MIN), m.minutes, wins, step);
      }
      if (at && (!best || at.getTime() < best.at)) best = { court, at: at.getTime() };
    }
    if (!best) {
      noRoom.add(m.id);
      continue;
    }
    take(m, best.court, best.at);
    out.push({ id: m.id, courtName: best.court, startsAt: new Date(best.at), endsAt: new Date(best.at + m.minutes * MIN) });
  }
  return { slots: out, unplaced: noRoom.size };
}

/** The phases that wait for the last day of a longer weekend. */
const KNOCKOUT: ReadonlySet<MatchPhase> = new Set(["main", "consolation"]);

/**
 * `schedule` for a weekend whose knockout waits for its last day, `from` being that day's first
 * minute (null on one day). Only a category that plays groups or a qualifying first is held back.
 * A knockout-only one has nothing to play before it: held, it left Saturday empty while Sunday had
 * no room for its later rounds, and 32 pairs on two courts lost 11 matches (review, 24 September 2026).
 * The line is a preference, never a cost: when it leaves more matches without room than the plain
 * fill, the plain fill wins. A qualifying before a big main draw on one court still fits as it did.
 */
export function scheduleWeekend(input: ScheduleInput, from: Date | null): Schedule {
  if (!from) return schedule(input);
  const early = new Set(input.matches.filter((m) => m.phase === "group" || m.phase === "qualifying").map((m) => m.categoryId));
  const held = schedule({ ...input, matches: input.matches.map((m) => (KNOCKOUT.has(m.phase) && early.has(m.categoryId) ? { ...m, notBefore: from } : m)) });
  if (held.unplaced === 0) return held;
  const plain = schedule(input);
  return plain.unplaced < held.unplaced ? plain : held;
}
