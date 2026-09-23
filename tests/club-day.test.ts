import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { clubCourts, clubs, events } from "@/db/schema";
import { clubBusy, courtDay, courtsInUse } from "@/lib/domain/courts";
import { bookLesson, createCoach, presetHours, setStudentStatus, updateCoach } from "@/lib/domain/coaching";
import { createEvent } from "@/lib/domain/events";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

/**
 * Roadmap item 4: a club had its courts as rows and could not see which of them were busy.
 *
 * The laying-out is proved in tests/court-day.test.ts. This proves the half that talks to the
 * database: the two reads pick up the club's matches and the lessons taught there, inside the window
 * and not outside it, and a cancelled match frees its court again.
 *
 * Every time comes off a fixed Monday, never off today (rule 11).
 */
describe("a club's day, read from its matches and its lessons", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const TZ = "Asia/Bangkok";
  const SLUG = "rawai-padel";
  /** Monday 07:00 in Bangkok, as UTC. */
  const monday07 = new Date("2026-09-14T00:00:00.000Z");
  const at = (h: number) => new Date(monday07.getTime() + h * HOUR);
  const dayFrom = at(-7); // Monday 00:00 in Bangkok
  const dayTo = new Date(dayFrom.getTime() + 24 * HOUR);

  it("reads the club's own day and nothing outside it", async () => {
    await db.insert(clubs).values({ slug: SLUG, name: "Rawai Padel", source: "directory", manageToken: "tok-day", country: "TH", province: "Phuket", tz: TZ }).onConflictDoNothing();
    for (const [i, name] of ["Centre", "Court 2", "Court 3"].entries()) {
      await db.insert(clubCourts).values({ clubSlug: SLUG, name, number: i === 0 ? null : i + 1, position: i }).onConflictDoNothing();
    }
    const organiser = await makePlayer(db, "Dao");

    // Two matches today, one of them naming the court the way a player types it, and one tomorrow.
    const today = await createEvent(db, { creatorPlayerId: organiser.id, type: "match", startsAt: at(2), tz: TZ, whenFull: "closed", venueName: "Rawai Padel", court: "2", title: "Monday social" });
    await createEvent(db, { creatorPlayerId: organiser.id, type: "match", startsAt: at(4), tz: TZ, whenFull: "closed", venueName: "Rawai Padel", court: "Centre" });
    await createEvent(db, { creatorPlayerId: organiser.id, type: "match", startsAt: at(26), tz: TZ, whenFull: "closed", venueName: "Rawai Padel", court: "Centre" });

    // A lesson taught here today. It carries the venue but no court yet, so it lands in the row for
    // whatever named none — which is the truth, not a guess about which court the coach used.
    const p = await makePlayer(db, "Nok");
    const coach = await createCoach(db, { playerId: p.id, displayName: "Nok", tz: TZ, hours: presetHours("both"), clubNames: ["Rawai Padel"] });
    const student = await makePlayer(db, "Pim");
    await setStudentStatus(db, coach.id, student.id, "accepted");
    await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: at(6), byCoach: true }, at(-2));

    const busy = await clubBusy(db, SLUG, dayFrom, dayTo);
    expect(busy).toHaveLength(3); // two matches and one lesson; tomorrow's match is outside the window
    expect(busy.filter((b) => b.kind === "lesson")).toHaveLength(1);
    // A club never reads a student's name off its own day.
    expect(JSON.stringify(busy)).not.toContain("Pim");

    const rows = courtDay(["Centre", "Court 2", "Court 3"], busy);
    expect(rows.map((r) => r.name)).toEqual(["Centre", "Court 2", "Court 3", null]);
    expect(rows[0].blocks).toHaveLength(1);
    expect(rows[1].blocks.map((b) => b.title)).toEqual(["Monday social"]); // "2" found "Court 2"
    expect(rows[2].blocks).toHaveLength(0);
    expect(rows[3].blocks.map((b) => b.kind)).toEqual(["lesson"]);
    expect(courtsInUse(rows)).toBe(2);

    // A cancelled match gives its court back.
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, today.id));
    const after = await clubBusy(db, SLUG, dayFrom, dayTo);
    expect(after).toHaveLength(2);
    expect(courtsInUse(courtDay(["Centre", "Court 2", "Court 3"], after))).toBe(1);
  });

  it("puts a lesson on the court the coach teaches on", async () => {
    // The half the first test leaves open: once the coach answers "Court 3", the club reads that
    // court as busy rather than reading "no court named" and counting one court fewer than it has.
    // A club of its own, because the first test's lesson still sits in the window on this Monday.
    const OTHER = "kathu-padel";
    await db.insert(clubs).values({ slug: OTHER, name: "Kathu Padel", source: "directory", manageToken: "tok-day-2", country: "TH", province: "Phuket", tz: TZ }).onConflictDoNothing();
    for (const [i, name] of ["Court 1", "Court 3"].entries()) {
      await db.insert(clubCourts).values({ clubSlug: OTHER, name, number: i === 0 ? 1 : 3, position: i }).onConflictDoNothing();
    }
    const p = await makePlayer(db, "Aor");
    const made = await createCoach(db, { playerId: p.id, displayName: "Aor", tz: TZ, hours: presetHours("both"), clubNames: ["Kathu Padel"] });
    const coach = await updateCoach(db, made.id, { court: "Court 3" });
    const student = await makePlayer(db, "Ben");
    await setStudentStatus(db, coach.id, student.id, "accepted");
    await bookLesson(db, { coach, studentPlayerId: student.id, startsAt: at(8), byCoach: true }, at(-2));

    const rows = courtDay(["Court 1", "Court 3"], await clubBusy(db, OTHER, dayFrom, dayTo));
    // No row for "no court named", because nothing is left unplaced. The first test has that row.
    expect(rows.map((r) => r.name)).toEqual(["Court 1", "Court 3"]);
    expect(rows[1].blocks.map((b) => b.kind)).toEqual(["lesson"]);
    expect(rows[0].blocks).toHaveLength(0);
    expect(courtsInUse(rows)).toBe(1);
    // A club still never reads a student's name off its own day.
    expect(JSON.stringify(rows)).not.toContain("Ben");
  });
});
