import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { acceptByInvite, createCoach, earnedInvite, inviteCode, inviteMatches, presetHours, requestStudent, setStudentStatus, studentLink, studentStatus } from "@/lib/domain/coaching";
import { claimManager, managerCode } from "@/lib/coach/chains";
import { createTestDb, makePlayer } from "./helpers/db";

/** The link a coach forwards puts a student on the list; the public page without it still asks. */
describe("the coach's student link", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  it("mints one code per coach, keeps it, and builds the link", async () => {
    const p = await makePlayer(db, "Coach Ana");
    const coach = await createCoach(db, { playerId: p.id, displayName: "Ana", clubNames: "Warehaus", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Bangkok" });
    expect(coach.inviteCode).toBeNull();
    // Two renders at the same moment mint once: the claim is atomic and the second read returns the winner.
    const [code, again] = await Promise.all([inviteCode(db, coach), inviteCode(db, coach)]);
    expect(code).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(again).toBe(code);
    expect(await inviteCode(db, { ...coach, inviteCode: null })).toBe(code);
    expect(await inviteCode(db, { ...coach, inviteCode: code })).toBe(code);
    expect(studentLink("https://kicksma.sh", coach.handle, code)).toBe(`https://kicksma.sh/c/${coach.handle}?i=${code}`);
    expect(inviteMatches({ inviteCode: code }, code)).toBe(true);
    expect(inviteMatches({ inviteCode: code }, code.toLowerCase() === code ? "xxxxxxxx" : code.toLowerCase())).toBe(false);
    expect(inviteMatches({ inviteCode: code }, null)).toBe(false);
    expect(inviteMatches({ inviteCode: null }, code)).toBe(false);
    // A repeated ?i= arrives as an array; a page must not crash on it.
    expect(inviteMatches({ inviteCode: code }, [code, code])).toBe(false);
    expect(inviteMatches({ inviteCode: code }, 12345678)).toBe(false);
  });

  it("does not make the coach or their manager a student of their own book", async () => {
    const p = await makePlayer(db, "Coach Cy");
    const coach = await createCoach(db, { playerId: p.id, displayName: "Cy", clubNames: "DPC", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Bangkok" });
    expect(await acceptByInvite(db, coach.id, p.id)).toBe("none");
    expect(await studentStatus(db, coach.id, p.id)).toBe("none");
    const helper = await makePlayer(db, "Mia");
    await claimManager(db, await managerCode(db, coach.id), helper.id);
    expect(await acceptByInvite(db, coach.id, helper.id)).toBe("none");
    // Another coach's link still works for them.
    const other = await createCoach(db, { playerId: (await makePlayer(db, "Coach Di")).id, displayName: "Di", clubNames: "DPC", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Bangkok" });
    expect(await acceptByInvite(db, other.id, p.id)).toBe("accepted");
  });

  it("offers the coach invitation once the book has earned it, counted over all time", () => {
    const row = (status: "accepted" | "requested" | "paused", lessonsDone: number) => ({ status, lessonsDone });
    expect(earnedInvite([])).toBe(false);
    expect(earnedInvite([row("accepted", 2), row("requested", 0)])).toBe(false);
    expect(earnedInvite([row("accepted", 0), row("accepted", 0), row("accepted", 0)])).toBe(true);
    expect(earnedInvite([row("accepted", 3), row("paused", 2)])).toBe(true);
    expect(earnedInvite([row("requested", 5)])).toBe(true);
  });

  it("accepts on open; a pending ask becomes accepted; paused and accepted stay as they are", async () => {
    const p = await makePlayer(db, "Coach Bo");
    const coach = await createCoach(db, { playerId: p.id, displayName: "Bo", clubNames: "DPC", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Bangkok" });
    const fresh = await makePlayer(db, "Dasha");
    expect(await acceptByInvite(db, coach.id, fresh.id)).toBe("accepted");
    expect(await studentStatus(db, coach.id, fresh.id)).toBe("accepted");
    const asked = await makePlayer(db, "Ivan");
    expect(await requestStudent(db, coach.id, asked.id)).toBe("requested");
    expect(await acceptByInvite(db, coach.id, asked.id)).toBe("accepted");
    const paused = await makePlayer(db, "Lev");
    await setStudentStatus(db, coach.id, paused.id, "paused");
    expect(await acceptByInvite(db, coach.id, paused.id)).toBe("paused");
    // Twice is still once.
    expect(await acceptByInvite(db, coach.id, fresh.id)).toBe("accepted");
  });
});
