import { and, asc, eq, inArray, isNotNull, isNull, lte, gt, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import { competitionCategories, competitionMatches, competitionPairs, competitions, players, type Competition, type CompetitionCategory, type CompetitionMatch } from "@/db/schema";
import { schedule, type DayWindow, type ScheduleMatch, type Slot } from "./courtSchedule";
import { isOrganizer } from "./competitions";
import { SCORING, scoringOfMatch } from "./draw";
import { DomainError } from "./errors";
import { bumpMetric } from "./metrics";

/**
 * Courts and times in the database: the court list and the day's window on the competition, the
 * schedule written onto the matches, a match moved by the organiser, the order of play for the
 * pages, and the fifteen-minute reminders the cron sends.
 */

export const COURTS = { max: 16, nameMax: 24, defaultStart: "09:00", defaultEnd: "21:00", remindMinutes: 15 } as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

async function own(db: Db, competitionId: string, organizerPlayerId: string): Promise<Competition> {
  const [c] = await db.select().from(competitions).where(eq(competitions.id, competitionId)).limit(1);
  if (!c) throw new DomainError("not_found", "competition");
  if (!isOrganizer(c, organizerPlayerId)) throw new DomainError("forbidden", "organizer");
  return c;
}

/** The courts by name and the window of play, the same for every day of the competition. */
export async function setCourts(db: Db, input: { competitionId: string; organizerPlayerId: string; courtNames: string[]; dayStart?: string | null; dayEnd?: string | null }): Promise<Competition> {
  await own(db, input.competitionId, input.organizerPlayerId);
  const names = [...new Set(input.courtNames.map((n) => n.replace(/\s+/g, " ").trim().slice(0, COURTS.nameMax)).filter(Boolean))];
  if (names.length > COURTS.max) throw new DomainError("invalid", "courts");
  const dayStart = input.dayStart ?? COURTS.defaultStart;
  const dayEnd = input.dayEnd ?? COURTS.defaultEnd;
  if (!TIME.test(dayStart) || !TIME.test(dayEnd) || dayStart >= dayEnd) throw new DomainError("invalid", "window");
  const [c] = await db.update(competitions).set({ courtNames: names, dayStart, dayEnd, updatedAt: new Date() }).where(eq(competitions.id, input.competitionId)).returning();
  return c;
}

/** Every local date from the first day to the last. */
export function daysOf(c: Pick<Competition, "startsOn" | "endsOn" | "dayStart" | "dayEnd">): DayWindow[] {
  const out: DayWindow[] = [];
  const start = new Date(`${c.startsOn}T00:00:00Z`);
  const end = new Date(`${c.endsOn}T00:00:00Z`);
  for (let d = start; d.getTime() <= end.getTime() && out.length < 14; d = new Date(d.getTime() + 86_400_000)) {
    out.push({ date: d.toISOString().slice(0, 10), start: c.dayStart ?? COURTS.defaultStart, end: c.dayEnd ?? COURTS.defaultEnd });
  }
  return out;
}

const isOver = (m: CompetitionMatch) => m.status === "done" || m.status === "walkover";

/**
 * Every match of every drawn category gets a court and a time, played ones keeping theirs. The
 * whole competition at once, so a player in two categories is never on two courts together.
 */
export async function scheduleCompetition(db: Db, input: { competitionId: string; organizerPlayerId: string; now?: Date }): Promise<{ slots: Slot[]; matches: CompetitionMatch[] }> {
  const c = await own(db, input.competitionId, input.organizerPlayerId);
  if (!c.courtNames || c.courtNames.length === 0) throw new DomainError("invalid", "courts");
  const categories = await db
    .select()
    .from(competitionCategories)
    .where(and(eq(competitionCategories.competitionId, c.id), inArray(competitionCategories.drawStatus, ["drawn", "published", "done"])));
  if (categories.length === 0) throw new DomainError("invalid", "no_draw");
  const rows = await db
    .select()
    .from(competitionMatches)
    .where(eq(competitionMatches.competitionId, c.id))
    .orderBy(asc(competitionMatches.round), asc(competitionMatches.position));
  const pairs = await db
    .select({ id: competitionPairs.id, p1: competitionPairs.p1PlayerId, p2: competitionPairs.p2PlayerId })
    .from(competitionPairs)
    .where(eq(competitionPairs.competitionId, c.id));
  const playersOf = new Map(pairs.map((p) => [p.id, [p.p1, p.p2]]));
  const byCategory = new Map(categories.map((k) => [k.id, k]));
  const rounds = new Map(categories.map((k) => [k.id, Math.max(0, ...rows.filter((m) => m.categoryId === k.id && m.phase === "main").map((m) => m.round))]));
  const input2: ScheduleMatch[] = rows
    .filter((m) => byCategory.has(m.categoryId))
    .map((m) => ({
      id: m.id,
      categoryId: m.categoryId,
      phase: m.phase,
      groupLabel: m.groupLabel,
      round: m.round,
      position: m.position,
      pairA: m.pairAId,
      pairB: m.pairBId,
      sourceA: m.sourceA,
      sourceB: m.sourceB,
      bye: m.bye,
      over: isOver(m),
      minutes: SCORING[scoringOfMatch(m, rounds.get(m.categoryId) ?? 0, byCategory.get(m.categoryId)!)].minutes,
      fixed: isOver(m) && m.scheduledAt && m.courtName ? { courtName: m.courtName, startsAt: m.scheduledAt } : null,
    }));
  const slots = schedule({ matches: input2, courts: c.courtNames, days: daysOf(c), tz: c.tz, playersOf });
  for (const s of slots) {
    await db
      .update(competitionMatches)
      .set({ courtName: s.courtName, scheduledAt: s.startsAt, remindedAt: null, status: "scheduled", updatedAt: input.now ?? new Date() })
      .where(and(eq(competitionMatches.id, s.id), inArray(competitionMatches.status, ["pending", "scheduled"])));
  }
  await bumpMetric(db, "schedule_made");
  return { slots, matches: await db.select().from(competitionMatches).where(eq(competitionMatches.competitionId, c.id)) };
}

/** One match to another court or time, by the organiser; the reminder is armed again. */
export async function moveMatch(db: Db, input: { matchId: string; organizerPlayerId: string; courtName: string; scheduledAt: Date }): Promise<CompetitionMatch> {
  const [m] = await db.select().from(competitionMatches).where(eq(competitionMatches.id, input.matchId)).limit(1);
  if (!m) throw new DomainError("not_found", "match");
  const c = await own(db, m.competitionId, input.organizerPlayerId);
  if (!c.courtNames?.includes(input.courtName)) throw new DomainError("invalid", "court");
  if (Number.isNaN(input.scheduledAt.getTime())) throw new DomainError("invalid", "time");
  if (isOver(m)) throw new DomainError("invalid", "over");
  const [updated] = await db
    .update(competitionMatches)
    .set({ courtName: input.courtName, scheduledAt: input.scheduledAt, remindedAt: null, status: "scheduled", updatedAt: new Date() })
    .where(eq(competitionMatches.id, m.id))
    .returning();
  return updated;
}

export type PlayRow = CompetitionMatch & { categoryName: string; aName: string | null; bName: string | null; aPlayers: string[]; bPlayers: string[] };

/** The matches with a time, soonest first, with names: the order of play for the page, the TV and the notices. */
export async function orderOfPlay(db: Db, competitionId: string): Promise<PlayRow[]> {
  const rows = await db
    .select({ m: competitionMatches, categoryName: competitionCategories.name })
    .from(competitionMatches)
    .innerJoin(competitionCategories, eq(competitionCategories.id, competitionMatches.categoryId))
    .where(and(eq(competitionMatches.competitionId, competitionId), isNotNull(competitionMatches.scheduledAt)))
    .orderBy(asc(competitionMatches.scheduledAt), asc(competitionMatches.courtName));
  if (rows.length === 0) return [];
  const p1 = alias(players, "p1");
  const p2 = alias(players, "p2");
  const pairRows = await db
    .select({ id: competitionPairs.id, p1: competitionPairs.p1PlayerId, p2: competitionPairs.p2PlayerId, n1: p1.displayName, n2: p2.displayName })
    .from(competitionPairs)
    .innerJoin(p1, eq(p1.id, competitionPairs.p1PlayerId))
    .innerJoin(p2, eq(p2.id, competitionPairs.p2PlayerId))
    .where(eq(competitionPairs.competitionId, competitionId));
  const byPair = new Map(pairRows.map((p) => [p.id, p]));
  return rows.map(({ m, categoryName }) => {
    const a = m.pairAId ? byPair.get(m.pairAId) : undefined;
    const b = m.pairBId ? byPair.get(m.pairBId) : undefined;
    return { ...m, categoryName, aName: a ? `${a.n1} & ${a.n2}` : null, bName: b ? `${b.n1} & ${b.n2}` : null, aPlayers: a ? [a.p1, a.p2] : [], bPlayers: b ? [b.p1, b.p2] : [] };
  });
}

/** Matches starting within the next fifteen minutes with both pairs known, claimed once each. */
export async function matchRemindersDue(db: Db, now = new Date()): Promise<{ competition: Competition; category: CompetitionCategory; match: CompetitionMatch }[]> {
  const horizon = new Date(now.getTime() + COURTS.remindMinutes * 60_000);
  const rows = await db
    .select({ m: competitionMatches, competition: competitions, category: competitionCategories })
    .from(competitionMatches)
    .innerJoin(competitions, eq(competitions.id, competitionMatches.competitionId))
    .innerJoin(competitionCategories, eq(competitionCategories.id, competitionMatches.categoryId))
    .where(
      and(
        isNotNull(competitionMatches.scheduledAt),
        isNull(competitionMatches.remindedAt),
        isNotNull(competitionMatches.pairAId),
        isNotNull(competitionMatches.pairBId),
        ne(competitionMatches.status, "done"),
        ne(competitionMatches.status, "walkover"),
        gt(competitionMatches.scheduledAt, now),
        lte(competitionMatches.scheduledAt, horizon),
      ),
    )
    .limit(200);
  const out: { competition: Competition; category: CompetitionCategory; match: CompetitionMatch }[] = [];
  for (const r of rows) {
    const [claimed] = await db.update(competitionMatches).set({ remindedAt: now }).where(and(eq(competitionMatches.id, r.m.id), isNull(competitionMatches.remindedAt))).returning();
    if (claimed) out.push({ competition: r.competition, category: r.category, match: claimed });
  }
  return out;
}
