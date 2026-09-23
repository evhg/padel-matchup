import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { clubs } from "@/db/schema";
import { bookLesson, cleanClubNames, coachClubSlugs, coachesAtClub, coachingAtClub, createCoach, CLUBS_MAX, presetHours, setStudentStatus, updateCoach } from "@/lib/domain/coaching";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

/**
 * A club could not be shown who teaches on its courts, for two reasons that were nothing to do with
 * the query. A coach's clubs were free text — the two real coaches typed "warehaus" and "Warehaus"
 * for the same place — and a lesson never recorded where it happened at all. These are both rules.
 */
describe("what a club can see of the coaching on its courts", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const TZ = "Asia/Bangkok";
  // A Monday 07:00 in Bangkok as UTC; every time comes off it, never off today (rule 11).
  const monday07 = new Date("2026-09-14T00:00:00.000Z");
  const at = (h: number) => new Date(monday07.getTime() + h * HOUR);
  const now = at(-24);

  it("makes one key out of the many ways people write a club's name", () => {
    expect(coachClubSlugs("Warehaus")).toEqual(["warehaus"]);
    expect(coachClubSlugs("warehaus")).toEqual(["warehaus"]);
    expect(coachClubSlugs("  Warehaus  Padel ")).toEqual(["warehaus-padel"]);
    // A club whose page is "warehaus" may be named "Warehaus Padel Phuket": the picked slug is kept
    // as well as the derived one, and first, or that club would never be found.
    expect(coachClubSlugs("Warehaus Padel Phuket", ["warehaus"])).toEqual(["warehaus", "warehaus-padel-phuket"]);
    expect(coachClubSlugs(["Rawai Padel", "rawai padel"])).toEqual(["rawai-padel"]);
    expect(coachClubSlugs("")).toEqual([]);
    expect(coachClubSlugs(null)).toEqual([]);
    // Never unbounded, and never longer than the list of names it came from: one constant caps both.
    expect(coachClubSlugs(Array.from({ length: 20 }, (_, i) => `club ${i}`)).length).toBe(CLUBS_MAX);
    expect(coachClubSlugs(Array.from({ length: 20 }, (_, i) => `club ${i}`)).length).toBe(cleanClubNames(Array.from({ length: 20 }, (_, i) => `club ${i}`)).length);
  });

  it("a coach who types a name gets the slug, and changing the name changes it", async () => {
    const p = await makePlayer(db, "Nadia");
    const coach = await createCoach(db, { playerId: p.id, displayName: "Nadia", tz: TZ, hours: presetHours("both"), clubNames: ["Warehaus"] });
    expect(coach.clubSlugs).toEqual(["warehaus"]);
    const moved = await updateCoach(db, coach.id, { clubNames: ["Rawai Padel"] });
    expect(moved.clubSlugs).toEqual(["rawai-padel"]);
    expect(moved.clubNames).toEqual(["Rawai Padel"]);
  });

  it("two coaches who spell it differently are the same club's coaches", async () => {
    const a = await makePlayer(db, "Cath");
    const b = await makePlayer(db, "Ricardo");
    const one = await createCoach(db, { playerId: a.id, displayName: "Cath", tz: TZ, hours: presetHours("both"), clubNames: ["warehaus"] });
    const two = await createCoach(db, { playerId: b.id, displayName: "Ricardo", tz: TZ, hours: presetHours("both"), clubNames: ["Warehaus"] });
    await updateCoach(db, one.id, { isPublic: true });
    await updateCoach(db, two.id, { isPublic: true });
    const here = await coachesAtClub(db, "warehaus");
    expect(here.map((c) => c.id).sort()).toEqual([one.id, two.id].sort());
    // And the club page may ask by name or by slug; both answer the same.
    expect((await coachesAtClub(db, "Warehaus")).length).toBe(2);
    expect(await coachesAtClub(db, "")).toEqual([]);
  });

  it("a coach who types the club's full name is found where the club actually is", async () => {
    // WAREHAUS.club lives at `warehaus`: that is the slug its matches carry. venueSlug() of its name
    // is "warehaus-club", a page nobody plays on, so a coach saved under that slug would be invisible
    // to their own club and to the players whose matches are there.
    await db.insert(clubs).values({ slug: "warehaus", name: "WAREHAUS.club", source: "directory", manageToken: "tok-coach-name", country: "TH", province: "Phuket", tz: TZ });
    const p = await makePlayer(db, "Bee");
    const coach = await createCoach(db, { playerId: p.id, displayName: "Bee", tz: TZ, hours: presetHours("both"), clubNames: ["WAREHAUS.club"] });
    expect(coach.clubSlugs).toEqual(["warehaus"]);
    expect(coach.clubNames).toEqual(["WAREHAUS.club"]);
    await updateCoach(db, coach.id, { isPublic: true });
    expect((await coachesAtClub(db, "warehaus")).map((c) => c.id)).toContain(coach.id);
  });

  it("a lesson remembers its club, and a coach at two clubs records none", async () => {
    const one = await makePlayer(db, "Solo");
    const solo = await createCoach(db, { playerId: one.id, displayName: "Solo", tz: TZ, hours: presetHours("both"), clubNames: ["Rawai Padel"] });
    const student = await makePlayer(db, "Anna");
    await setStudentStatus(db, solo.id, student.id, "accepted");
    const booked = await bookLesson(db, { coach: solo, studentPlayerId: student.id, startsAt: at(2), byCoach: true }, now);
    expect(booked.lesson.venueSlug).toBe("rawai-padel");

    const two = await makePlayer(db, "Both");
    const roaming = await createCoach(db, { playerId: two.id, displayName: "Both", tz: TZ, hours: presetHours("both"), clubNames: ["Rawai Padel", "Warehaus"] });
    await setStudentStatus(db, roaming.id, student.id, "accepted");
    const guessed = await bookLesson(db, { coach: roaming, studentPlayerId: student.id, startsAt: at(4), byCoach: true }, now);
    // Null, not a guess: a lesson on the wrong club's page is worse than a lesson on nobody's.
    expect(guessed.lesson.venueSlug).toBeNull();
  });

  it("a lesson carries the coach's court, under the same rule as its club", async () => {
    // A court name without a club says nothing, so the court follows venue_slug exactly: it is copied
    // for a coach at one club and dropped for a coach at two. It is the coach's own answer as well —
    // nothing here reads a court off a match, a name or a habit.
    const one = await makePlayer(db, "Court Solo");
    const solo = await createCoach(db, { playerId: one.id, displayName: "Court Solo", tz: TZ, hours: presetHours("both"), clubNames: ["Rawai Padel"] });
    const student = await makePlayer(db, "Lek");
    await setStudentStatus(db, solo.id, student.id, "accepted");

    // Until the coach says, a lesson names no court. The club's day then files it under "no court".
    const unsaid = await bookLesson(db, { coach: solo, studentPlayerId: student.id, startsAt: at(2), byCoach: true }, now);
    expect(unsaid.lesson.court).toBeNull();

    // The name is cleaned the way a club's own court rows are, so both sides of sameCourt() match.
    const said = await updateCoach(db, solo.id, { court: "  Court   3  " });
    expect(said.court).toBe("Court 3");
    const booked = await bookLesson(db, { coach: said, studentPlayerId: student.id, startsAt: at(4), byCoach: true }, now);
    expect(booked.lesson.court).toBe("Court 3");

    const two = await makePlayer(db, "Court Both");
    const roaming = await updateCoach(db, (await createCoach(db, { playerId: two.id, displayName: "Court Both", tz: TZ, hours: presetHours("both"), clubNames: ["Rawai Padel", "Warehaus"] })).id, { court: "Court 3" });
    await setStudentStatus(db, roaming.id, student.id, "accepted");
    const guessed = await bookLesson(db, { coach: roaming, studentPlayerId: student.id, startsAt: at(6), byCoach: true }, now);
    expect(guessed.lesson.venueSlug).toBeNull();
    expect(guessed.lesson.court).toBeNull();

    // And a blank answer takes the court away again.
    const cleared = await updateCoach(db, solo.id, { court: "   " });
    expect(cleared.court).toBeNull();
  });

  it("counts the lessons in the window, names no student, and keeps a quiet coach on the list", async () => {
    const cp = await makePlayer(db, "Busy");
    const coach = await createCoach(db, { playerId: cp.id, displayName: "Busy", tz: TZ, hours: presetHours("both"), clubNames: ["Kathu Padel"] });
    await updateCoach(db, coach.id, { isPublic: true });
    const quietP = await makePlayer(db, "Quiet");
    const quiet = await createCoach(db, { playerId: quietP.id, displayName: "Quiet", tz: TZ, hours: presetHours("both"), clubNames: ["Kathu Padel"] });
    await updateCoach(db, quiet.id, { isPublic: true });

    const anna = await makePlayer(db, "Anna K");
    const ben = await makePlayer(db, "Ben");
    for (const s of [anna, ben]) await setStudentStatus(db, coach.id, s.id, "accepted");
    await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(2), byCoach: true }, now);
    await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(3), byCoach: true }, now);
    await bookLesson(db, { coach, studentPlayerId: ben.id, startsAt: at(5), byCoach: true }, now);
    // Outside the window, and it must not be counted.
    await bookLesson(db, { coach, studentPlayerId: ben.id, startsAt: at(24 * 30), byCoach: true }, now);

    const rows = await coachingAtClub(db, "Kathu Padel", at(0), at(24));
    expect(rows.map((r) => r.displayName)).toEqual(["Busy", "Quiet"]);
    expect(rows[0]).toMatchObject({ lessons: 3, students: 2, handle: coach.handle });
    // A coach who taught nothing here is still one of this club's coaches.
    expect(rows[1]).toMatchObject({ lessons: 0, students: 0 });
    // Nothing about money and nobody's student named: the club watches.
    expect(Object.keys(rows[0]).sort()).toEqual(["coachId", "displayName", "handle", "lessons", "students"]);
    // A club nobody teaches at gets an empty list, not every coach.
    expect(await coachingAtClub(db, "Nowhere Padel", at(0), at(24))).toEqual([]);
  });
});
