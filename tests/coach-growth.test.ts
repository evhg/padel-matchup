import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { coaches } from "@/db/schema";
import { createCoach, FOUNDING_COACHES, foundingRank, isFoundingCoach, presetHours } from "@/lib/domain/coaching";
import { createTestDb, makePlayer } from "./helpers/db";

/** The first ten listed coaches of a city are founding coaches; private, archived and other cities do not count. */
describe("founding coaches", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  it("ranks listed coaches per city by creation and stops at ten", async () => {
    const base = Date.UTC(2026, 8, 1, 8, 0, 0);
    const made: { id: string; tz: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const p = await makePlayer(db, `Coach ${i}`);
      const c = await createCoach(db, { playerId: p.id, displayName: p.displayName, clubNames: "Warehaus", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Bangkok", languages: ["en"] });
      await db.update(coaches).set({ createdAt: new Date(base + i * 60_000) }).where(eq(coaches.id, c.id));
      made.push({ id: c.id, tz: c.tz });
    }
    const sg = await makePlayer(db, "Singapore coach");
    const sgCoach = await createCoach(db, { playerId: sg.id, displayName: sg.displayName, clubNames: "MBP", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Singapore", languages: ["en"] });
    const rows = await db.select().from(coaches);
    const byId = (id: string) => rows.find((r) => r.id === id)!;
    expect(await foundingRank(db, byId(made[0].id))).toBe(0);
    expect(await foundingRank(db, byId(made[9].id))).toBe(9);
    expect(await foundingRank(db, byId(made[10].id))).toBe(10);
    expect(isFoundingCoach(await foundingRank(db, byId(made[9].id)))).toBe(true);
    expect(isFoundingCoach(await foundingRank(db, byId(made[10].id)))).toBe(false);
    expect(isFoundingCoach(await foundingRank(db, byId(made[11].id)))).toBe(false);
    expect(FOUNDING_COACHES).toBe(10);
    // Another city starts its own count.
    expect(await foundingRank(db, byId(sgCoach.id))).toBe(0);
    // Unlisted and archived coaches carry no badge and do not take a place.
    await db.update(coaches).set({ isPublic: false }).where(eq(coaches.id, made[3].id));
    expect(await foundingRank(db, (await db.select().from(coaches).where(eq(coaches.id, made[3].id)))[0])).toBeNull();
    expect(await foundingRank(db, byId(made[10].id))).toBe(9);
    await db.update(coaches).set({ archivedAt: new Date() }).where(eq(coaches.id, made[0].id));
    expect(await foundingRank(db, byId(made[10].id))).toBe(8);
  });
});
