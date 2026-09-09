import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { acceptByInvite, createCoach, inviteCode, inviteMatches, presetHours, requestStudent, setStudentStatus, studentLink, studentStatus } from "@/lib/domain/coaching";
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
    const code = await inviteCode(db, coach.id);
    expect(code).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(await inviteCode(db, coach.id)).toBe(code);
    expect(studentLink("https://kicksma.sh", coach.handle, code)).toBe(`https://kicksma.sh/c/${coach.handle}?i=${code}`);
    expect(inviteMatches({ inviteCode: code }, code)).toBe(true);
    expect(inviteMatches({ inviteCode: code }, code.toLowerCase() === code ? "xxxxxxxx" : code.toLowerCase())).toBe(false);
    expect(inviteMatches({ inviteCode: code }, null)).toBe(false);
    expect(inviteMatches({ inviteCode: null }, code)).toBe(false);
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
