import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { availableSlots, blockTime, closeHour, createCoach, openHour, openSlots, openingsBetween, presetHours } from "@/lib/domain/coaching";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";

/**
 * The weekly template says what a normal week looks like. A block takes one hour of one date back; an
 * opening adds one. Between the two a coach shapes any single date without moving the week that
 * everybody else's Tuesdays depend on.
 */
describe("an hour opened on one date", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const TZ = "Asia/Bangkok";
  // A Monday 00:00 UTC, so every time below is counted from it and never from today (rule 11).
  const monday = new Date("2026-10-05T00:00:00.000Z");
  const at = (hoursFromMidnightUtc: number) => new Date(monday.getTime() + hoursFromMidnightUtc * HOUR);

  const aCoach = async (name: string) => {
    const p = await makePlayer(db, name);
    // Mornings only: 07:00–12:00 Bangkok, which is 00:00–05:00 UTC.
    return createCoach(db, { playerId: p.id, displayName: name, tz: TZ, hours: presetHours("mornings") });
  };

  it("offers an hour the weekly template does not, on that date only", async () => {
    const coach = await aCoach("Nina");
    // 13:00 Bangkok on the Monday: outside the morning template, which stops at 12:00.
    const wanted = at(6);
    const before = await availableSlots(db, coach, monday, new Date(monday.getTime() + 8 * DAY), monday);
    expect(before.some((d) => d.getTime() === wanted.getTime())).toBe(false);

    await openHour(db, coach.id, wanted, coach.lessonMinutes);
    const after = await availableSlots(db, coach, monday, new Date(monday.getTime() + 8 * DAY), monday);
    expect(after.some((d) => d.getTime() === wanted.getTime())).toBe(true);
    // The following Monday is untouched: one date opened, not a change to the week.
    expect(after.some((d) => d.getTime() === wanted.getTime() + 7 * DAY)).toBe(false);
  });

  it("gives the hour back to the template when the coach undoes it", async () => {
    const coach = await aCoach("Omar");
    const wanted = at(6);
    await openHour(db, coach.id, wanted, coach.lessonMinutes);
    await closeHour(db, coach.id, wanted);
    const slots = await availableSlots(db, coach, monday, new Date(monday.getTime() + 2 * DAY), monday);
    expect(slots.some((d) => d.getTime() === wanted.getTime())).toBe(false);
  });

  it("opens an hour once, however many times the coach taps", async () => {
    const coach = await aCoach("Pia");
    const wanted = at(6);
    await openHour(db, coach.id, wanted, coach.lessonMinutes);
    await openHour(db, coach.id, wanted, coach.lessonMinutes);
    expect(await openingsBetween(db, coach.id, monday, new Date(monday.getTime() + 2 * DAY))).toHaveLength(1);
  });

  it("does not beat a block: taking an hour back still wins", async () => {
    const coach = await aCoach("Quinn");
    const wanted = at(6);
    await openHour(db, coach.id, wanted, coach.lessonMinutes);
    await blockTime(db, { coachId: coach.id, startsAt: wanted, minutes: coach.lessonMinutes, reason: null });
    const slots = await availableSlots(db, coach, monday, new Date(monday.getTime() + 2 * DAY), monday);
    expect(slots.some((d) => d.getTime() === wanted.getTime())).toBe(false);
  });

  it("shows an hour once when the opening lands inside the template it repeats", () => {
    const coach = { hours: presetHours("mornings"), tz: TZ, lessonMinutes: 60, minNoticeHours: 0 };
    const inside = at(1); // 08:00 Bangkok: the template already offers it.
    const slots = openSlots({ coach, from: monday, to: new Date(monday.getTime() + DAY), busy: [], now: monday, openings: [{ startsAt: inside, endsAt: new Date(inside.getTime() + HOUR) }] });
    expect(slots.filter((d) => d.getTime() === inside.getTime())).toHaveLength(1);
    // And the whole list is in order, which the de-duplication must not disturb.
    expect(slots.map((d) => d.getTime())).toEqual([...slots.map((d) => d.getTime())].sort((a, b) => a - b));
  });
});
