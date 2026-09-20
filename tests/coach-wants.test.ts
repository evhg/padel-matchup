import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import type { Player } from "@/db/schema";
import { claimClub } from "@/lib/domain/clubs";
import { COACH_WANT_FANOUT_MAX, COACH_WANT_QUIET_MS, COACH_WANT_TTL_MS, coachListedText, coachWantsToTell, countCoachWants, dropCoachWantsFor, pruneCoachWants, recordCoachWant, tellCoachListed, waitingToldText } from "@/lib/domain/coachWants";
import { createCoach, presetHours, updateCoach } from "@/lib/domain/coaching";
import { createTestDb, makePlayer } from "./helpers/db";

/** "I want a coach": one row per person per city, the count on the door, the first coach who lists hears it, and it dies in time. */
describe("coach wants", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());
  const NOW = new Date("2026-09-20T09:00:00.000Z");

  it("records one want per person per city, cleans the level and the note, refuses a city without a page", async () => {
    const ana = await makePlayer(db, "Ana");
    const w = await recordCoachWant(db, { playerId: ana.id, citySlug: "singapore", level: 1.5, whenNote: "  evenings,   weekends " }, NOW);
    expect(w).toMatchObject({ citySlug: "singapore", level: 1.5, whenNote: "evenings, weekends" });
    expect(w.expiresAt.getTime()).toBe(NOW.getTime() + COACH_WANT_TTL_MS);
    // Saying it again refreshes the row rather than adding one; a level off the scale is dropped.
    const again = await recordCoachWant(db, { playerId: ana.id, citySlug: "singapore", level: 1.7, whenNote: "mornings" }, new Date(NOW.getTime() + 1000));
    expect(again.id).toBe(w.id);
    expect(again.level).toBeNull();
    expect(again.whenNote).toBe("mornings");
    expect(await countCoachWants(db, "singapore", NOW)).toBe(1);
    await expect(recordCoachWant(db, { playerId: ana.id, citySlug: "bangkok" }, NOW)).rejects.toMatchObject({ code: "invalid", message: "city" });
    // Deletion takes the want with it; the prune takes the expired ones.
    expect(await dropCoachWantsFor(db, ana.id)).toBe(1);
    expect(await countCoachWants(db, "singapore", NOW)).toBe(0);
    const bo = await makePlayer(db, "Bo");
    await recordCoachWant(db, { playerId: bo.id, citySlug: "phuket" }, new Date(NOW.getTime() - COACH_WANT_TTL_MS - 1000));
    expect(await pruneCoachWants(db, NOW)).toBe(1);
  });

  it("tells the people who asked when a coach lists in their city, at most twenty, none twice in a week, and tells the coach how many", async () => {
    const told: { to: string; text: string }[] = [];
    const fakeTell = async (_db: Db, p: Player | null | undefined, text: string) => {
      if (p) told.push({ to: p.displayName, text });
    };
    // Twenty-two wants in Phuket, one in Singapore.
    const wanters: Player[] = [];
    for (let i = 0; i < 22; i++) {
      const p = await makePlayer(db, `Wanter ${i}`, { locale: i % 2 ? "ru" : "en" });
      wanters.push(p);
      await recordCoachWant(db, { playerId: p.id, citySlug: "phuket", level: 2 }, NOW);
    }
    const sg = await makePlayer(db, "Sam");
    await recordCoachWant(db, { playerId: sg.id, citySlug: "singapore" }, NOW);
    // A coach at a Phuket club lists: the club's row names the city.
    const owner = await makePlayer(db, "Owner");
    await claimClub(db, { name: "Rawai Padel Club", playerId: owner.id, place: "Rawai, Phuket", tz: "Asia/Bangkok" });
    const cp = await makePlayer(db, "Olga", { locale: "es" });
    const olga = await createCoach(db, { playerId: cp.id, displayName: "Olga", clubNames: "Rawai Padel Club", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Bangkok", languages: ["en"] });
    const listed = await updateCoach(db, olga.id, { isPublic: true });
    const r = await tellCoachListed(db, listed, NOW, fakeTell as never);
    expect(r).toEqual({ city: "phuket", told: COACH_WANT_FANOUT_MAX });
    expect(told.filter((t) => t.to.startsWith("Wanter")).length).toBe(COACH_WANT_FANOUT_MAX);
    expect(told.some((t) => t.text.includes("Тренер появился"))).toBe(true);
    expect(told.some((t) => t.text.includes("A coach listed in Phuket"))).toBe(true);
    expect(told.find((t) => t.to === "Olga")?.text).toContain("20 personas");
    expect(told.some((t) => t.to === "Sam")).toBe(false);
    // The same day, a second coach: the twenty told wait a week; the two left hear now.
    told.length = 0;
    const cq = await makePlayer(db, "Pavel");
    const pavel = await createCoach(db, { playerId: cq.id, displayName: "Pavel", clubNames: "Rawai Padel Club", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Bangkok", languages: ["ru"] });
    expect((await tellCoachListed(db, await updateCoach(db, pavel.id, { isPublic: true }), new Date(NOW.getTime() + 3600_000), fakeTell as never)).told).toBe(2);
    // A week on, the first twenty are due again.
    expect((await coachWantsToTell(db, "phuket", new Date(NOW.getTime() + COACH_WANT_QUIET_MS + 1000))).length).toBe(COACH_WANT_FANOUT_MAX);
    // A coach whose clubs name no city tells nobody.
    const cr = await makePlayer(db, "Nok");
    const nok = await createCoach(db, { playerId: cr.id, displayName: "Nok", clubNames: "Bangkok Padel Arena", lessonMinutes: 60, hours: presetHours("both"), tz: "Asia/Bangkok", languages: ["en"] });
    expect(await tellCoachListed(db, await updateCoach(db, nok.id, { isPublic: true }), NOW, fakeTell as never)).toEqual({ city: null, told: 0 });
    // The words, in three languages.
    const city = { slug: "phuket", name: "Phuket", tz: "Asia/Bangkok", needles: [], venueSlugs: [] };
    expect(coachListedText("es", olga, city)).toContain("Hay un entrenador en Phuket");
    expect(waitingToldText("en", 1, city)).toContain("1 person in Phuket");
  });
});
