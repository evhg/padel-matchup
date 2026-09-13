import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { clubs, coachManagers, coaches } from "@/db/schema";
import { createCoach, setStudentStatus } from "@/lib/domain/coaching";
import { NO_ROLES, roleCount, rolesFor } from "@/lib/domain/roles";
import { createTestDb, makePlayer } from "./helpers/db";

/**
 * The role set is what replaced the browser cookie that told a player they were a coach.
 * These are the cases that cookie got wrong.
 */
describe("the role set", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const TZ = "Asia/Bangkok";

  it("gives a visitor with no identity nothing, without asking the database", async () => {
    expect(await rolesFor(db, null)).toEqual(NO_ROLES);
    expect(await rolesFor(db, undefined)).toEqual(NO_ROLES);
    expect(roleCount(NO_ROLES)).toBe(0);
  });

  it("gives a plain player nothing but Play", async () => {
    const p = await makePlayer(db, "Erik");
    const roles = await rolesFor(db, p.id);
    expect(roles).toEqual(NO_ROLES);
    expect(roleCount(roles)).toBe(0);
  });

  it("finds the coach's own book, and the book of a coach they only run", async () => {
    const anna = await makePlayer(db, "Anna");
    const annaCoach = await createCoach(db, { playerId: anna.id, displayName: "Anna", clubNames: ["Warehaus"], tz: TZ });
    expect(await rolesFor(db, anna.id)).toMatchObject({ coach: { handle: annaCoach.handle, as: "coach" } });

    const bee = await makePlayer(db, "Bee");
    await db.insert(coachManagers).values({ coachId: annaCoach.id, playerId: bee.id });
    const managed = await rolesFor(db, bee.id);
    expect(managed.coach).toEqual({ handle: annaCoach.handle, as: "manager" });
    expect(roleCount(managed)).toBe(1);
  });

  it("lists the clubs a person claimed, by name, and counts the coaches they study under", async () => {
    const sam = await makePlayer(db, "Sam");
    await db.insert(clubs).values([
      { slug: "rawai-padel", name: "Rawai Padel", city: "Phuket", claimedBy: sam.id, manageToken: "tok-rawai-000000" },
      { slug: "aonang-padel", name: "Ao Nang Padel", city: "Krabi", claimedBy: sam.id, manageToken: "tok-aonang-00000" },
    ]);
    const nokPlayer = await makePlayer(db, "Nok");
    const nok = await createCoach(db, { playerId: nokPlayer.id, displayName: "Nok", tz: TZ });
    await setStudentStatus(db, nok.id, sam.id, "accepted");

    const roles = await rolesFor(db, sam.id);
    expect(roles.clubs).toEqual([
      { slug: "aonang-padel", name: "Ao Nang Padel" },
      { slug: "rawai-padel", name: "Rawai Padel" },
    ]);
    expect(roles.studentOf).toBe(1);
    // Studying under a coach is not a door in the header; it is a block inside My matches.
    expect(roleCount(roles)).toBe(2);
  });

  it("does not count a student who only asked, or one the coach paused", async () => {
    const asker = await makePlayer(db, "Asker");
    const cp = await makePlayer(db, "Coach Two");
    const coach = await createCoach(db, { playerId: cp.id, displayName: "Coach Two", tz: TZ });
    await setStudentStatus(db, coach.id, asker.id, "requested");
    expect((await rolesFor(db, asker.id)).studentOf).toBe(0);
    await setStudentStatus(db, coach.id, asker.id, "paused");
    expect((await rolesFor(db, asker.id)).studentOf).toBe(0);
    await setStudentStatus(db, coach.id, asker.id, "accepted");
    expect((await rolesFor(db, asker.id)).studentOf).toBe(1);
  });

  it("stops calling someone a coach the moment the book is archived", async () => {
    const gone = await makePlayer(db, "Gone");
    const coach = await createCoach(db, { playerId: gone.id, displayName: "Gone", tz: TZ });
    expect((await rolesFor(db, gone.id)).coach).not.toBeNull();
    await db.update(coaches).set({ archivedAt: new Date() }).where(eq(coaches.id, coach.id));
    // This is the case the cookie could never see: the role ended, the browser did not hear.
    expect((await rolesFor(db, gone.id)).coach).toBeNull();
  });
});
