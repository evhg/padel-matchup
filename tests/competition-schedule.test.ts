import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { addCategory, createCompetition, enterPair } from "@/lib/domain/competitions";
import { makeDraw, publishDraw } from "@/lib/domain/competitionDraw";
import { daysOf, isDayOfPlay, knockoutFrom, matchRemindersDue, moveMatch, orderOfPlay, scheduleCompetition, setCourts } from "@/lib/domain/competitionSchedule";
import { DomainError } from "@/lib/domain/errors";
import { utcToZonedParts } from "@/lib/dates";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer } from "./helpers/db";

/** Tuesday 8 September 2026, 16:00 in Phuket; the competition is on the weekend of 10–11 October. */
const NOW = new Date("2026-09-08T09:00:00Z");
freezeClock(NOW);
const TZ = "Asia/Bangkok";
/** The local date a match is played on, where the competition is. */
const dayOf = (at: Date | null) => (at ? utcToZonedParts(at, TZ).date : null);
const isKnockout = (m: { phase: string }) => m.phase === "main" || m.phase === "consolation";
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DomainError ? `${e.code}:${e.message === e.code ? "" : e.message}` : String(e);
  }
};

describe("courts and times in the database", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  it("takes the courts and the window, schedules the drawn categories, moves a match, and reminds once", async () => {
    const org = await makePlayer(db, "Org");
    const c = await createCompetition(db, { organizerPlayerId: org.id, name: "Times Open", tz: "Asia/Bangkok", startsOn: "2026-10-10", endsOn: "2026-10-11" });
    expect(daysOf(c).map((d) => d.date)).toEqual(["2026-10-10", "2026-10-11"]);
    const gold = await addCategory(db, { competitionId: c.id, organizerPlayerId: org.id, name: "Gold", maxPairs: 8 });
    for (let i = 1; i <= 8; i++) {
      const p = await makePlayer(db, `T${i}`);
      await enterPair(db, { categoryId: gold.id, playerId: p.id, partner: { name: `TM${i}` }, locale: "en", byOrganizer: true });
    }
    expect(await code(scheduleCompetition(db, { competitionId: c.id, organizerPlayerId: org.id }))).toBe("invalid:courts");
    expect(await code(setCourts(db, { competitionId: c.id, organizerPlayerId: org.id, courtNames: ["Court 1"], dayStart: "10:00", dayEnd: "09:00" }))).toBe("invalid:window");
    const withCourts = await setCourts(db, { competitionId: c.id, organizerPlayerId: org.id, courtNames: [" Court 1 ", "Court 2", "Court 2", ""], dayStart: "09:00", dayEnd: "20:00" });
    expect(withCourts.courtNames).toEqual(["Court 1", "Court 2"]);
    expect(await code(scheduleCompetition(db, { competitionId: c.id, organizerPlayerId: org.id }))).toBe("invalid:no_draw");
    await makeDraw(db, { categoryId: gold.id, organizerPlayerId: org.id, now: NOW });
    await publishDraw(db, { categoryId: gold.id, organizerPlayerId: org.id });
    const { slots, unplaced } = await scheduleCompetition(db, { competitionId: c.id, organizerPlayerId: org.id, now: NOW });
    expect(slots).toHaveLength(18);
    expect(unplaced).toBe(0);
    const play = await orderOfPlay(db, c.id);
    expect(play).toHaveLength(18);
    // Two days: the groups on Saturday, the whole knockout, main and consolation, on Sunday from 09:00.
    expect(knockoutFrom(c)?.toISOString()).toBe("2026-10-11T02:00:00.000Z");
    expect(play.filter((m) => !isKnockout(m)).every((m) => dayOf(m.scheduledAt) === "2026-10-10")).toBe(true);
    expect(play.filter(isKnockout).every((m) => dayOf(m.scheduledAt) === "2026-10-11")).toBe(true);
    expect(Math.min(...play.filter(isKnockout).map((m) => m.scheduledAt!.getTime()))).toBe(new Date("2026-10-11T02:00:00Z").getTime());
    expect(play[0].scheduledAt?.toISOString()).toBe("2026-10-10T02:00:00.000Z"); // 09:00 in Phuket
    expect(play[0].status).toBe("scheduled");
    expect(play[0].aName).toMatch(/ & /);
    expect(play.every((m) => m.courtName === "Court 1" || m.courtName === "Court 2")).toBe(true);
    // The final is last, and nothing runs past the window.
    const final = play.find((m) => m.phase === "main" && m.round === 2)!;
    expect(final.scheduledAt!.getTime()).toBeGreaterThan(play[0].scheduledAt!.getTime());
    expect(play.every((m) => m.scheduledAt!.getTime() + 75 * 60_000 <= new Date("2026-10-11T13:00:00Z").getTime())).toBe(true);

    // The organiser moves a group match to Sunday morning on Court 2.
    const moved = await moveMatch(db, { matchId: play[1].id, organizerPlayerId: org.id, courtName: "Court 2", scheduledAt: new Date("2026-10-11T02:00:00Z") });
    expect(moved.courtName).toBe("Court 2");
    expect(await code(moveMatch(db, { matchId: play[1].id, organizerPlayerId: org.id, courtName: "Court 9", scheduledAt: new Date("2026-10-11T02:00:00Z") }))).toBe("invalid:court");
    expect(await code(moveMatch(db, { matchId: play[1].id, organizerPlayerId: (await makePlayer(db, "Nobody")).id, courtName: "Court 2", scheduledAt: NOW }))).toBe("forbidden:organizer");

    // Fifteen minutes before 09:00 on Saturday, the two first matches are due, once.
    const before = new Date("2026-10-10T01:50:00Z");
    expect(await matchRemindersDue(db, new Date("2026-10-10T01:00:00Z"))).toEqual([]);
    // The Court 2 match of nine o'clock moved to Sunday above, so one match is due.
    const due = await matchRemindersDue(db, before);
    expect(due.map((d) => d.match.courtName)).toEqual(["Court 1"]);
    expect(due[0].competition.id).toBe(c.id);
    expect(due[0].category.name).toBe("Gold");
    expect(await matchRemindersDue(db, before)).toEqual([]);
  });

  it("plays a one-day competition on its day, the knockout after the groups as before", async () => {
    const org = await makePlayer(db, "Org One");
    const c = await createCompetition(db, { organizerPlayerId: org.id, name: "One Day Open", tz: TZ, startsOn: "2026-10-17", endsOn: "2026-10-17" });
    expect(knockoutFrom(c)).toBeNull();
    const gold = await addCategory(db, { competitionId: c.id, organizerPlayerId: org.id, name: "Gold", maxPairs: 8 });
    for (let i = 1; i <= 8; i++) {
      const p = await makePlayer(db, `O${i}`);
      await enterPair(db, { categoryId: gold.id, playerId: p.id, partner: { name: `OM${i}` }, locale: "en", byOrganizer: true });
    }
    await setCourts(db, { competitionId: c.id, organizerPlayerId: org.id, courtNames: ["Court 1", "Court 2"], dayStart: "09:00", dayEnd: "20:00" });
    await makeDraw(db, { categoryId: gold.id, organizerPlayerId: org.id, now: NOW });
    await publishDraw(db, { categoryId: gold.id, organizerPlayerId: org.id });
    const { slots, unplaced } = await scheduleCompetition(db, { competitionId: c.id, organizerPlayerId: org.id, now: NOW });
    expect(slots).toHaveLength(18);
    expect(unplaced).toBe(0);
    const play = await orderOfPlay(db, c.id);
    expect(play.every((m) => dayOf(m.scheduledAt) === "2026-10-17")).toBe(true);
    // The first semi-final follows the last group match with the thirty-minute rest, the same Saturday.
    const lastGroupEnd = Math.max(...play.filter((m) => m.phase === "group").map((m) => m.scheduledAt!.getTime() + 30 * 60_000));
    const firstKnockout = Math.min(...play.filter(isKnockout).map((m) => m.scheduledAt!.getTime()));
    expect(firstKnockout).toBe(lastGroupEnd + 30 * 60_000);
  });
});

describe("the days of play", () => {
  // NOW is Tuesday 8 September, 16:00 in Phuket. The public page used to take yesterday in UTC,
  // 7 September, and so stayed still on a first day and refreshed on the day after the last.
  const on = (startsOn: string, endsOn: string) => isDayOfPlay({ startsOn, endsOn, tz: TZ });

  it("counts the first day and the last where the competition is played, and not the day after", () => {
    expect(on("2026-09-08", "2026-09-09")).toBe(true); // the first day
    expect(on("2026-09-07", "2026-09-08")).toBe(true); // the last day
    expect(on("2026-09-08", "2026-09-08")).toBe(true); // one day
    expect(on("2026-09-06", "2026-09-07")).toBe(false); // the day after
    expect(on("2026-09-09", "2026-09-10")).toBe(false); // tomorrow
  });

  it("reads the date where the competition is played", () => {
    // 20:00 UTC is 03:00 on Wednesday in Phuket and 14:00 on Tuesday in Mexico City.
    const evening = new Date("2026-09-08T20:00:00Z");
    expect(isDayOfPlay({ startsOn: "2026-09-09", endsOn: "2026-09-10", tz: TZ }, evening)).toBe(true);
    expect(isDayOfPlay({ startsOn: "2026-09-09", endsOn: "2026-09-10", tz: "America/Mexico_City" }, evening)).toBe(false);
  });
});
