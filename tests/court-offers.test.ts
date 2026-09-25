import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, demandSignals, events, facts, type ClubAvailability, type Player } from "@/db/schema";
import { claimClub, decideClub } from "@/lib/domain/clubs";
import { COURT_OFFERS, offerableHours, wantFitsHour } from "@/lib/domain/courtOffers";
import { recordWant } from "@/lib/domain/demand";
import { createEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { offerFreeCourts } from "@/lib/notify";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * The club's promise is an off-peak court hour filled from Kicksmash. A club's feed says which courts
 * are free today; a player said when and where they want to play. When the two meet, the player hears
 * once, with one button to the match form at that club and that hour.
 *
 * NOW is Tuesday 15 September 2026, 03:00 UTC — 10:00 in Bangkok (UTC+7). The club's feed has three
 * free hours, and every date below comes off NOW, never off today (rule 11):
 *   05:00 UTC = 12:00 Bangkok, two hours ahead (the nearest an offer goes)
 *   07:00 UTC = 14:00 Bangkok, four hours ahead
 *   11:00 UTC = 18:00 Bangkok, eight hours ahead (past the six an offer looks)
 */
const NOW = new Date("2026-09-15T03:00:00.000Z");
freezeClock(NOW);
const at = (ms: number) => new Date(NOW.getTime() + ms);
const FEED: ClubAvailability = {
  fetchedAt: NOW.toISOString(),
  day: "2026-09-15",
  tz: "Asia/Bangkok",
  slots: [
    { start: "2026-09-15T05:00:00.000Z", end: "2026-09-15T06:00:00.000Z", free: 1 },
    { start: "2026-09-15T07:00:00.000Z", end: "2026-09-15T08:00:00.000Z", free: 2 },
    { start: "2026-09-15T11:00:00.000Z", end: "2026-09-15T12:00:00.000Z", free: 3 },
  ],
  error: null,
  source: "json_free",
};

describe("which free hour answers which want", () => {
  it("reads the day, then the hour inside the window, as a match is read", () => {
    const tue14 = { date: "2026-09-15", time: "14:00" };
    expect(wantFitsHour({ onDate: null, weekday: 2, fromTime: "13:00", toTime: "15:00" }, tue14)).toBe(true);
    expect(wantFitsHour({ onDate: null, weekday: null, fromTime: null, toTime: null }, tue14)).toBe(true);
    expect(wantFitsHour({ onDate: "2026-09-15", weekday: null, fromTime: "14:00", toTime: "14:00" }, tue14)).toBe(true);
    expect(wantFitsHour({ onDate: null, weekday: 3, fromTime: "13:00", toTime: "15:00" }, tue14)).toBe(false);
    expect(wantFitsHour({ onDate: "2026-09-16", weekday: null, fromTime: null, toTime: null }, tue14)).toBe(false);
    expect(wantFitsHour({ onDate: null, weekday: 2, fromTime: "14:30", toTime: "16:00" }, tue14)).toBe(false);
    expect(wantFitsHour({ onDate: null, weekday: 2, fromTime: "12:00", toTime: "13:30" }, tue14)).toBe(false);
  });

  it("offers only the hours people could still get to, and nothing from a feed that failed", () => {
    expect(offerableHours(FEED, NOW).map((h) => [h.date, h.time, h.free])).toEqual([
      ["2026-09-15", "12:00", 1],
      ["2026-09-15", "14:00", 2],
    ]);
    // An hour later the noon court is too close, and the six o'clock one is still too far.
    expect(offerableHours(FEED, at(HOUR)).map((h) => h.time)).toEqual(["14:00"]);
    expect(offerableHours({ ...FEED, error: "HTTP 500" }, NOW)).toEqual([]);
    expect(offerableHours({ ...FEED, slots: [{ ...FEED.slots[1], free: 0 }] }, NOW)).toEqual([]);
    expect(offerableHours(null, NOW)).toEqual([]);
    expect(COURT_OFFERS.maxLeadMs).toBeLessThanOrEqual(6 * HOUR);
  });
});

describe("a free court offered to the players who asked for that hour", () => {
  let db: Db;
  let close: () => Promise<void>;
  let slug: string;
  let told: { to: Player; text: string; url: string; buttons: number; label?: string }[] = [];
  const say = async (_db: Db, p: Player | null | undefined, text: string, keyboard?: { inline_keyboard: { text: string; url?: string }[][] }, o?: { label?: string }) => {
    if (p) told.push({ to: p, text, url: keyboard?.inline_keyboard[0]?.[0]?.url ?? "", buttons: keyboard?.inline_keyboard.flat().length ?? 0, label: o?.label });
  };
  const offer = async (when: Date) => {
    told = [];
    return (await offerFreeCourts(db, when, say as never)).offered;
  };
  let seq = 0;
  const player = async (name: string, extra: Partial<Player> = {}) => makePlayer(db, name, { telegramId: 7000 + seq++, ...extra });
  const want = async (p: Player, over: Parameters<typeof recordWant>[1] extends infer I ? Partial<I> : never = {}) =>
    recordWant(db, { playerId: p.id, venueSlug: slug, weekday: 2, fromTime: "13:00", toTime: "15:00", ...over }, NOW);

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
    const owner = await makePlayer(db, "Owner");
    const club = await claimClub(db, { name: "Rawai Padel Club", playerId: owner.id, tz: "Asia/Bangkok", courts: 4 });
    await decideClub(db, club.slug, true, NOW);
    slug = club.slug;
  });
  afterAll(async () => close());
  beforeEach(async () => {
    await db.delete(demandSignals);
    await db.delete(facts);
    await db.delete(events);
    await db.update(clubs).set({ availability: FEED, availabilityAt: NOW }).where(eq(clubs.slug, slug));
  });

  it("tells the player once, on their channel, with one button to the match form at that club and hour", async () => {
    const nok = await player("Nok");
    await want(nok);
    expect(await offer(NOW)).toBe(1);
    expect(told).toHaveLength(1);
    expect(told[0].to.id).toBe(nok.id);
    expect(told[0].text).toContain("A court is free at Rawai Padel Club today at 14:00");
    expect(told[0].buttons).toBe(1);
    expect(told[0].label).toBe("Make the match");
    // The form's own door, with the day, the time and the club's zone, and the chat's ticket so the
    // card of the match comes back to this chat.
    const link = new URL(told[0].url);
    expect(link.pathname).toBe("/");
    expect(Object.fromEntries([...link.searchParams].filter(([k]) => k !== "tg"))).toEqual({ venue: "Rawai Padel Club", date: "2026-09-15", time: "14:00", tz: "Asia/Bangkok" });
    expect(link.searchParams.get("tg")).toMatch(new RegExp(`^${nok.telegramId}\\.`));
    // The fact log counts it, and the want is quiet from now.
    const [fact] = await db.select().from(facts).where(eq(facts.kind, "demand.court_offered"));
    expect(fact).toMatchObject({ venueSlug: slug, channel: "cron" });
    expect((await db.select().from(demandSignals))[0].notifiedAt).toEqual(NOW);
  });

  it("never tells the same want about the same court twice", async () => {
    await want(await player("Once"));
    expect(await offer(NOW)).toBe(1);
    // The next run finds the want quiet.
    expect(await offer(at(HOUR))).toBe(0);
    // By the time it may hear again, the court it heard about has begun, though the feed still lists it.
    await db.update(clubs).set({ availabilityAt: at(6 * HOUR + 60_000) }).where(eq(clubs.slug, slug));
    expect(await offer(at(6 * HOUR + 60_000))).toBe(0);
  });

  it("offers a want one court a day, however broad it is", async () => {
    // "Any day, any hour at the club": the want production holds, at Warehaus.
    await want(await player("Any"), { weekday: null, fromTime: null, toTime: null });
    expect(await offer(NOW)).toBe(1);
    // Seven hours on the cooldown is over and 20:00 Bangkok is free, but the want heard today.
    const evening = { start: "2026-09-15T13:00:00.000Z", end: "2026-09-15T14:00:00.000Z", free: 2 };
    await db.update(clubs).set({ availability: { ...FEED, slots: [evening] }, availabilityAt: at(7 * HOUR) }).where(eq(clubs.slug, slug));
    expect(await offer(at(7 * HOUR))).toBe(0);
    // The next day's two o'clock court is a new day.
    const tomorrow = { start: "2026-09-16T07:00:00.000Z", end: "2026-09-16T08:00:00.000Z", free: 1 };
    await db.update(clubs).set({ availability: { ...FEED, day: "2026-09-16", slots: [tomorrow] }, availabilityAt: at(24 * HOUR + 60_000) }).where(eq(clubs.slug, slug));
    expect(await offer(at(24 * HOUR + 60_000))).toBe(1);
  });

  it("stays quiet for another day, another hour, another club, and a person nothing can reach", async () => {
    await want(await player("Wednesday"), { weekday: 3 });
    await want(await player("Tomorrow"), { weekday: null, onDate: "2026-09-16" });
    await want(await player("Later"), { fromTime: "15:00", toTime: "17:00" });
    await want(await player("Elsewhere"), { venueSlug: "blue-tree" });
    const silent = await player("Silent", { telegramId: null, email: null });
    await want(silent);
    expect(await offer(NOW)).toBe(0);
    expect(told).toEqual([]);
    // Nobody was reached, so nobody's want went quiet for nothing.
    expect((await db.select().from(demandSignals)).every((w) => w.notifiedAt === null)).toBe(true);
  });

  it("stays quiet when a club's feed is stale or the club no longer runs its page", async () => {
    await want(await player("Stale"));
    await db.update(clubs).set({ availabilityAt: at(-3 * HOUR) }).where(eq(clubs.slug, slug));
    expect(await offer(NOW)).toBe(0);
    await db.update(clubs).set({ availabilityAt: NOW, rejectedAt: NOW }).where(eq(clubs.slug, slug));
    expect(await offer(NOW)).toBe(0);
    await db.update(clubs).set({ rejectedAt: null }).where(eq(clubs.slug, slug));
    expect(await offer(NOW)).toBe(1);
  });

  it("holds the cap, and the rest hear the next hour while the court is still ahead", async () => {
    for (let i = 0; i < COURT_OFFERS.perRun + 5; i++) await want(await player(`Wanter ${i}`));
    expect(await offer(NOW)).toBe(COURT_OFFERS.perRun);
    expect(new Set(told.map((t) => t.to.id)).size).toBe(COURT_OFFERS.perRun);
    expect(await offer(at(HOUR))).toBe(5);
    expect(await offer(at(2 * HOUR))).toBe(0);
  });

  it("sends one message for two wants the same court answers", async () => {
    const two = await player("Two");
    await want(two);
    await want(two, { weekday: null, fromTime: "11:00", toTime: "16:00" });
    expect(await offer(NOW)).toBe(1);
    // The earlier hour answers the second want only, so the one message names the hour both share.
    expect(told[0].text).toContain("14:00");
    expect((await db.select().from(demandSignals)).every((w) => w.notifiedAt?.getTime() === NOW.getTime())).toBe(true);
  });

  it("leaves an hour a match already starts in to that match, and a player already playing there that day alone", async () => {
    const organiser = await makePlayer(db, "Organiser");
    // A match at the club at 14:00 Bangkok: the wants sweep tells the players about it, not about the court.
    await createEvent(db, { creatorPlayerId: organiser.id, type: "match", startsAt: new Date("2026-09-15T07:00:00.000Z"), tz: "Asia/Bangkok", venueName: "Rawai Padel Club", whenFull: "waitlist" });
    await want(await player("Taken"));
    expect(await offer(NOW)).toBe(0);
    // Somebody with a seat at the club tonight needs no court at noon.
    const busy = await player("Busy");
    const tonight = await createEvent(db, { creatorPlayerId: organiser.id, type: "match", startsAt: new Date("2026-09-15T12:00:00.000Z"), tz: "Asia/Bangkok", venueName: "Rawai Padel Club", whenFull: "waitlist" });
    await joinEvent(db, { eventId: tonight.id, playerId: busy.id });
    await want(busy, { fromTime: "11:00", toTime: "13:00" });
    expect(await offer(NOW)).toBe(0);
    // Anyone else with that want hears about the noon court.
    await want(await player("Free"), { fromTime: "11:00", toTime: "13:00" });
    expect(await offer(NOW)).toBe(1);
    expect(told[0].to.displayName).toBe("Free");
    expect(told[0].text).toContain("12:00");
  });
});
