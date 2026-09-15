import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { demandSignals, pushSubscriptions, type Player } from "@/db/schema";
import { createEvent, type CreateEventInput } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { dropWant, listWants, markWantsNotified, matchingWants, parseWantLine, pruneWants, recordWant, resolvePlace, wantAudience, WANT_COOLDOWN_MS, WANT_MAX_PER_PLAYER, weekdayOf } from "@/lib/domain/demand";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * The app records supply and waits for somebody to post a match. This is the other half: a player
 * says what they want, and a match that answers it finds them.
 *
 * NOW is Monday 14 September 2026, 09:00 UTC — 16:00 in Bangkok. Every date below comes off it,
 * never off today (rule 11). Bangkok is UTC+7, so a Tuesday 14:00 local start is 07:00 UTC.
 */
const NOW = new Date("2026-09-14T09:00:00.000Z");
freezeClock(NOW);
const TUE_14_LOCAL = new Date("2026-09-15T07:00:00.000Z");

describe("what a player wants", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  // Files share one database and one worker (rule 11), so wants outlive the test that made them and
  // every later "expect nothing" would see them. Each case starts with an empty table of its own.
  beforeEach(async () => {
    await db.delete(demandSignals);
  });

  const withPush = async (name: string, extra: Record<string, unknown> = {}) => {
    const p = await makePlayer(db, name, extra);
    await db.insert(pushSubscriptions).values({ playerId: p.id, endpoint: `https://push.example/${p.id}-${Math.random()}`, p256dh: "key", auth: "auth" });
    return p;
  };
  const aMatch = async (creator: Player, over: Partial<CreateEventInput> = {}) =>
    createEvent(db, { creatorPlayerId: creator.id, type: "match", startsAt: TUE_14_LOCAL, tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist", ...over });

  it("reads the weekday off a date rather than off a zone", () => {
    expect(weekdayOf("2026-09-14")).toBe(1);
    expect(weekdayOf("2026-09-15")).toBe(2);
    expect(weekdayOf("2026-09-13")).toBe(0);
  });

  it("needs a place, because a want with none would match a match on another continent", async () => {
    const p = await makePlayer(db, "Placeless");
    await expect(recordWant(db, { playerId: p.id, weekday: 2 }, NOW)).rejects.toMatchObject({ code: "invalid" });
  });

  it("refuses a window that ends before it starts", async () => {
    const p = await makePlayer(db, "Backwards");
    await expect(recordWant(db, { playerId: p.id, citySlug: "phuket", fromTime: "18:00", toTime: "09:00" }, NOW)).rejects.toMatchObject({ code: "invalid" });
  });

  it("treats the same want said twice as one want with a later expiry", async () => {
    const p = await makePlayer(db, "Repeater");
    const first = await recordWant(db, { playerId: p.id, citySlug: "phuket", weekday: 2, fromTime: "14:00" }, NOW);
    const later = new Date(NOW.getTime() + 3 * HOUR);
    const again = await recordWant(db, { playerId: p.id, citySlug: "phuket", weekday: 2, fromTime: "14:00" }, later);
    expect(again.id).toBe(first.id);
    expect(again.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime());
    expect(await listWants(db, p.id, NOW)).toHaveLength(1);
  });

  it("stops one player collecting a subscription to everything", async () => {
    const p = await makePlayer(db, "Collector");
    for (let i = 0; i < WANT_MAX_PER_PLAYER; i++) await recordWant(db, { playerId: p.id, citySlug: "phuket", weekday: i % 7, fromTime: `${String(8 + i).padStart(2, "0")}:00` }, NOW);
    await expect(recordWant(db, { playerId: p.id, citySlug: "phuket", weekday: 3, fromTime: "23:00" }, NOW)).rejects.toMatchObject({ code: "too_many" });
    expect(await listWants(db, p.id, NOW)).toHaveLength(WANT_MAX_PER_PLAYER);
  });

  it("drops one only for the player who owns it", async () => {
    const mine = await makePlayer(db, "Owner");
    const other = await makePlayer(db, "Stranger");
    const w = await recordWant(db, { playerId: mine.id, citySlug: "phuket" }, NOW);
    expect(await dropWant(db, w.id, other.id)).toBe(false);
    expect(await dropWant(db, w.id, mine.id)).toBe(true);
    expect(await listWants(db, mine.id, NOW)).toHaveLength(0);
  });

  it("matches a Tuesday-at-two want to a Tuesday-at-two match, by city and by court", async () => {
    const org = await makePlayer(db, "Organiser A");
    const ev = await aMatch(org, { venueName: "Rawai Padel" });
    const byCity = await withPush("By city");
    const byVenue = await withPush("By court");
    await recordWant(db, { playerId: byCity.id, citySlug: "phuket", weekday: 2, fromTime: "13:00", toTime: "15:00" }, NOW);
    await recordWant(db, { playerId: byVenue.id, venueSlug: ev.venueSlug, weekday: 2 }, NOW);
    const names = (await wantAudience(db, ev, NOW)).players.map((p) => p.displayName).sort();
    expect(names).toEqual(["By city", "By court"]);
  });

  it("ignores the wrong day, the wrong hour, and a want that has expired", async () => {
    const org = await makePlayer(db, "Organiser B");
    const ev = await aMatch(org);
    const wrongDay = await withPush("Wrong day");
    const wrongHour = await withPush("Wrong hour");
    const expired = await withPush("Expired");
    await recordWant(db, { playerId: wrongDay.id, citySlug: "phuket", weekday: 4 }, NOW);
    await recordWant(db, { playerId: wrongHour.id, citySlug: "phuket", weekday: 2, fromTime: "07:00", toTime: "09:00" }, NOW);
    const dead = await recordWant(db, { playerId: expired.id, citySlug: "phuket", weekday: 2 }, NOW);
    await db.update(demandSignals).set({ expiresAt: new Date(NOW.getTime() - HOUR) }).where(eq(demandSignals.id, dead.id));
    expect((await wantAudience(db, ev, NOW)).players).toEqual([]);
  });

  it("answers a want for one named date, and lets it die with the day", async () => {
    const org = await makePlayer(db, "Organiser C");
    const ev = await aMatch(org);
    const dated = await withPush("That Tuesday");
    await recordWant(db, { playerId: dated.id, citySlug: "phuket", onDate: "2026-09-15" }, NOW);
    expect((await wantAudience(db, ev, NOW)).players.map((p) => p.id)).toEqual([dated.id]);
    // Two days after the date it named, the row is gone rather than sitting in the index for a month.
    const after = new Date("2026-09-17T09:00:00.000Z");
    expect(await pruneWants(db, after)).toBeGreaterThanOrEqual(1);
    expect(await listWants(db, dated.id, after)).toHaveLength(0);
  });

  it("does not chase the organiser, anyone already in the match, or a player the level range excludes", async () => {
    const org = await withPush("Organiser D");
    const inAlready = await withPush("Already in");
    const tooLow = await withPush("Too low", { level: 1.5 });
    const admitted = await withPush("Admitted", { level: 3.5 });
    const ev = await aMatch(org, { levelMin: 3, levelMax: 4 });
    await joinEvent(db, { eventId: ev.id, playerId: inAlready.id });
    for (const p of [org, inAlready, tooLow, admitted]) await recordWant(db, { playerId: p.id, citySlug: "phuket", weekday: 2 }, NOW);
    expect((await wantAudience(db, ev, NOW)).players.map((p) => p.id)).toEqual([admitted.id]);
  });

  it("stays quiet for six hours after it has answered a want, then speaks again", async () => {
    const org = await makePlayer(db, "Organiser E");
    const ev = await aMatch(org);
    const keen = await withPush("Keen");
    await recordWant(db, { playerId: keen.id, citySlug: "phuket", weekday: 2 }, NOW);
    const first = await wantAudience(db, ev, NOW);
    expect(first.players.map((p) => p.id)).toEqual([keen.id]);
    await markWantsNotified(db, first.signalIds, NOW);

    const soon = new Date(NOW.getTime() + WANT_COOLDOWN_MS - 1000);
    expect((await wantAudience(db, ev, soon)).players).toEqual([]);
    const later = new Date(NOW.getTime() + WANT_COOLDOWN_MS + 1000);
    expect((await wantAudience(db, ev, later)).players.map((p) => p.id)).toEqual([keen.id]);
  });

  it("puts whoever asked for this hour ahead of the crew when a seat opens", async () => {
    const { refillAudience } = await import("@/lib/domain/refill");
    const org = await makePlayer(db, "Organiser G");
    const asked = await withPush("Asked for it");
    const ev = await aMatch(org, { publicListing: true });
    await recordWant(db, { playerId: asked.id, venueSlug: ev.venueSlug, weekday: 2, fromTime: "13:00", toTime: "15:00" }, NOW);
    // Nobody is in the crew and nobody is a regular here, so this player is in the list only because
    // they said they wanted exactly this — which is the point of the whole table.
    const audience = await refillAudience(db, ev, NOW);
    expect(audience.map((p) => p.id)).toContain(asked.id);
    expect(audience[0].id).toBe(asked.id);
  });

  it("does not tell somebody it has no way to reach", async () => {
    const org = await makePlayer(db, "Organiser F");
    const ev = await aMatch(org);
    const silent = await makePlayer(db, "No channel", { emailNotifications: false });
    await recordWant(db, { playerId: silent.id, citySlug: "phuket", weekday: 2 }, NOW);
    expect((await wantAudience(db, ev, NOW)).players).toEqual([]);
    // The matcher still found the want; it is the delivery that is missing, and the two are separate.
    expect((await matchingWants(db, ev, NOW)).some((w) => w.playerId === silent.id)).toBe(true);
  });
});


describe("a want, typed", () => {
  const TODAY = "2026-09-14";

  it("reads a weekday, an hour and a place in any order, in three languages", () => {
    expect(parseWantLine("want tue 14 Rawai Padel", TODAY)).toEqual({ weekday: 2, onDate: null, fromTime: "13:00", toTime: "15:00", place: "Rawai Padel" });
    expect(parseWantLine("хочу играть вт 14 Равай", TODAY)).toMatchObject({ weekday: 2, fromTime: "13:00", toTime: "15:00", place: "Равай" });
    expect(parseWantLine("quiero jugar mar 14 en Rawai", TODAY)).toMatchObject({ weekday: 2, place: "Rawai" });
  });

  it("takes a single time as around that hour, and a range as exactly the range", () => {
    expect(parseWantLine("fri 18 phuket", TODAY)).toMatchObject({ fromTime: "17:00", toTime: "19:00" });
    expect(parseWantLine("fri 18-21 phuket", TODAY)).toMatchObject({ fromTime: "18:00", toTime: "21:00" });
    // Never past the ends of the day.
    expect(parseWantLine("sat 23:30 phuket", TODAY)).toMatchObject({ fromTime: "22:30", toTime: "23:59" });
    expect(parseWantLine("sat 00:15 phuket", TODAY)).toMatchObject({ fromTime: "00:00", toTime: "01:15" });
  });

  it("reads a named date, and prefers it over a weekday", () => {
    expect(parseWantLine("15.09 phuket", TODAY)).toMatchObject({ onDate: "2026-09-15", weekday: null });
    expect(parseWantLine("tomorrow phuket", TODAY)).toMatchObject({ onDate: "2026-09-15" });
    expect(parseWantLine("today phuket", TODAY)).toMatchObject({ onDate: "2026-09-14" });
    // A date already past this year means next year's.
    expect(parseWantLine("01.02 phuket", TODAY)).toMatchObject({ onDate: "2027-02-01" });
  });

  it("leaves everything it did not understand as the place, and nothing more", () => {
    expect(parseWantLine("want to play near Rawai Padel Club", TODAY).place).toBe("Rawai Padel Club");
    expect(parseWantLine("tue", TODAY).place).toBe("");
  });
});

describe("where a want points", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  it("takes a court only when somebody has played there, and otherwise a city it knows", async () => {
    const org = await makePlayer(db, "Venue owner");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: TUE_14_LOCAL, tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    expect(await resolvePlace(db, "Rawai Padel")).toEqual({ venueSlug: ev.venueSlug, citySlug: "phuket" });
    // A court nobody has ever used is a want that can never be answered, so it is refused as a court…
    expect(await resolvePlace(db, "Somewhere Nobody Plays")).toBe(null);
    // …while a city the app knows is a perfectly good answer on its own.
    expect(await resolvePlace(db, "phuket")).toEqual({ venueSlug: null, citySlug: "phuket" });
  });
});
