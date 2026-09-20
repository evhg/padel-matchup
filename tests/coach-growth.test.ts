import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { coaches } from "@/db/schema";
import { claimClub } from "@/lib/domain/clubs";
import { coachCity, createCoach, FOUNDING_COACHES, isFoundingCoach, listedCount, presetHours, updateCoach } from "@/lib/domain/coaching";
import { createTestDb, makePlayer } from "./helpers/db";

/** The first ten listed coaches of a city are founding coaches; private, archived and other cities do not count. */
describe("founding coaches", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  it("ranks listed coaches per city by creation and stops at ten", async () => {
    const made: { id: string; tz: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const p = await makePlayer(db, `Coach ${i}`);
      const c = await createCoach(db, { playerId: p.id, displayName: p.displayName, clubNames: "Warehaus", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Bangkok", languages: ["en"] });
      made.push({ id: c.id, tz: c.tz });
    }
    const sg = await makePlayer(db, "Singapore coach");
    const sgCoach = await createCoach(db, { playerId: sg.id, displayName: sg.displayName, clubNames: "MBP", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Singapore", languages: ["en"] });
    const rows = await db.select().from(coaches);
    const byId = (id: string) => rows.find((r) => r.id === id)!;
    // The first ten listed in the city earned their place when they arrived; the eleventh did not.
    expect(isFoundingCoach(byId(made[0].id))).toBe(true);
    expect(isFoundingCoach(byId(made[9].id))).toBe(true);
    expect(isFoundingCoach(byId(made[10].id))).toBe(false);
    expect(isFoundingCoach(byId(made[11].id))).toBe(false);
    expect(FOUNDING_COACHES).toBe(10);
    expect(await listedCount(db, byId(made[0].id).tz)).toBe(made.length);
    // Another city starts its own count.
    expect(isFoundingCoach(byId(sgCoach.id))).toBe(true);
    // Unlisting hides the badge but keeps the place; a place freed this way is not handed to the eleventh, who came too late.
    const hidden = await updateCoach(db, made[3].id, { isPublic: false });
    expect(isFoundingCoach(hidden)).toBe(false);
    expect(hidden.foundingAt).not.toBeNull();
    await updateCoach(db, made[10].id, { isPublic: false });
    expect((await updateCoach(db, made[10].id, { isPublic: true })).foundingAt).toBeNull();
    expect(isFoundingCoach(await updateCoach(db, made[3].id, { isPublic: true }))).toBe(true);
    // An archived coach carries no badge.
    await db.update(coaches).set({ archivedAt: new Date() }).where(eq(coaches.id, made[0].id));
    expect(isFoundingCoach((await db.select().from(coaches).where(eq(coaches.id, made[0].id)))[0])).toBe(false);
  });
});

/** The badge's city comes from the coach's clubs. A time zone is not a city: Bangkok and Phuket share one. */
describe("the founding badge's city", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  const coach = async (name: string, clubNames: string, tz: string) => {
    const p = await makePlayer(db, name);
    return createCoach(db, { playerId: p.id, displayName: name, clubNames, lessonMinutes: 60, hours: presetHours("both"), tz, languages: ["en"] });
  };

  it("names the city from a club the city knows, from the club's row, or from a zone one city owns, and otherwise stays silent", async () => {
    // A Bangkok club in Asia/Bangkok: nothing says Phuket, so nothing is said.
    expect(await coachCity(db, await coach("Nok", "Bangkok Padel Arena", "Asia/Bangkok"))).toBeNull();
    // A slug the city's needles know.
    expect((await coachCity(db, await coach("Ploy", "Rawai Padel", "Asia/Bangkok")))?.slug).toBe("phuket");
    // A slug the needles do not know, but the club's own row names the city.
    const owner = await makePlayer(db, "Owner");
    await claimClub(db, { name: "Warehaus", playerId: owner.id, city: "phuket", tz: "Asia/Bangkok" });
    expect((await coachCity(db, await coach("Ricardo", "Warehaus", "Asia/Bangkok")))?.slug).toBe("phuket");
    // One city owns Asia/Singapore, so the zone is enough there.
    expect((await coachCity(db, await coach("Sam", "MBP", "Asia/Singapore")))?.slug).toBe("singapore");
  });
});
