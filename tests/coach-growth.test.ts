import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { coaches } from "@/db/schema";
import { createCoach, FOUNDING_COACHES, isFoundingCoach, listedCount, presetHours, updateCoach } from "@/lib/domain/coaching";
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
