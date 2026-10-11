import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { coachStudents, lessonPackages, lessons, type Coach, type Player } from "@/db/schema";
import { addPackageAction, blockStudentAction, coachBookAction, setStudentStatusAction } from "@/actions/coach";
import { createCoach, presetHours, setStudentStatus, studentStatus } from "@/lib/domain/coaching";
import { createPlayer } from "@/lib/domain/players";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";

/**
 * The coach's screens send a student's player id back to four actions: accept or pause, block or
 * unblock, a package, a lesson. Anybody can open a coach's book, and until 11 October 2026 every
 * started match page showed the ids of the people seated in it. So the id alone must not name a
 * stranger: each action takes only somebody on this coach's list (`onCoachList` in src/actions/coach.ts).
 */
describe("a coach's actions take only the people on the coach's list", () => {
  let db: Db;
  let coachPlayer: Player;
  let coach: Coach;
  let stranger: Player;
  let asker: Player;
  beforeAll(async () => {
    db = await getDb();
    coachPlayer = await createPlayer(db, { displayName: "Nadia", locale: "en" });
    coach = await createCoach(db, { playerId: coachPlayer.id, displayName: "Nadia", tz: "Asia/Bangkok", hours: presetHours("both"), clubNames: ["Warehaus"] });
    stranger = await createPlayer(db, { displayName: "Vic", locale: "en" });
    asker = await createPlayer(db, { displayName: "Ana", locale: "en" });
    // On the list already, paused by the coach: the row the students screen shows with an "Accept" tap.
    await setStudentStatus(db, coach.id, asker.id, "paused");
  });

  const asCoach = <T>(fn: () => Promise<T>) => asAction({ [PLAYER_COOKIE]: sealPlayerId(coachPlayer.id) }, fn);
  const rowsFor = async (playerId: string) => ({
    listed: (await db.select().from(coachStudents).where(and(eq(coachStudents.coachId, coach.id), eq(coachStudents.playerId, playerId)))).length,
    packages: (await db.select().from(lessonPackages).where(and(eq(lessonPackages.coachId, coach.id), eq(lessonPackages.studentPlayerId, playerId)))).length,
    lessons: (await db.select().from(lessons).where(and(eq(lessons.coachId, coach.id), eq(lessons.studentPlayerId, playerId)))).length,
  });
  const nextWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

  it("refuses a stranger's id in every one of the four, and writes nothing", async () => {
    const tries: (() => Promise<{ ok: boolean }>)[] = [
      () => setStudentStatusAction(stranger.id, "accepted"),
      () => blockStudentAction(stranger.id, false),
      () => blockStudentAction(stranger.id, true),
      () => addPackageAction({ studentPlayerId: stranger.id, size: 5, validDays: 30, amount: 100, paid: false }),
      () => coachBookAction({ studentPlayerId: stranger.id, startsAt: nextWeek() }),
    ];
    for (const t of tries) {
      const { result } = await asCoach(t);
      expect(result, String(t)).toEqual({ ok: false, error: "not_found" });
    }
    expect(await rowsFor(stranger.id)).toEqual({ listed: 0, packages: 0, lessons: 0 });
    expect(await studentStatus(db, coach.id, stranger.id)).toBe("none");
  });

  it("refuses an id that is not a player id at all", async () => {
    for (const bad of ["", "x", null, 42, { id: stranger.id }]) {
      const { result } = await asCoach(() => setStudentStatusAction(bad as string, "accepted"));
      expect(result).toEqual({ ok: false, error: "invalid" });
    }
  });

  it("still accepts somebody on the list, as the screen's tap does", async () => {
    expect(await studentStatus(db, coach.id, asker.id)).toBe("paused");
    const { result } = await asCoach(() => setStudentStatusAction(asker.id, "accepted"));
    expect(result).toEqual({ ok: true, data: null });
    expect(await studentStatus(db, coach.id, asker.id)).toBe("accepted");
    const pkg = await asCoach(() => addPackageAction({ studentPlayerId: asker.id, size: 5, validDays: 30, amount: 100, paid: false }));
    expect(pkg.result.ok).toBe(true);
    expect((await rowsFor(asker.id)).packages).toBe(1);
  });
});
