import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { addCategory, createCompetition, enterPair } from "@/lib/domain/competitions";
import { makeDraw, publishDraw } from "@/lib/domain/competitionDraw";
import { daysOf, matchRemindersDue, moveMatch, orderOfPlay, scheduleCompetition, setCourts } from "@/lib/domain/competitionSchedule";
import { DomainError } from "@/lib/domain/errors";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer } from "./helpers/db";

/** Tuesday 8 September 2026, 16:00 in Phuket; the competition is on the weekend of 10–11 October. */
const NOW = new Date("2026-09-08T09:00:00Z");
freezeClock(NOW);
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
    const { slots } = await scheduleCompetition(db, { competitionId: c.id, organizerPlayerId: org.id, now: NOW });
    expect(slots).toHaveLength(18);
    const play = await orderOfPlay(db, c.id);
    expect(play).toHaveLength(18);
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
});
