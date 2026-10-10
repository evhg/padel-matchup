import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, events, groups, type ClubAvailability, type ClubFreeSlot, type Player } from "@/db/schema";
import { zonedTimeToUtc } from "@/lib/dates";
import { cityBySlug } from "@/lib/domain/cities";
import { claimClub, decideClub, venuesForPicking } from "@/lib/domain/clubs";
import { createEvent } from "@/lib/domain/events";
import { bestTimesForChat, clubFeedColumns, courtsFreeInCity } from "@/lib/domain/freeCourts";
import { createGroup } from "@/lib/domain/groups";
import { freezeClock } from "./helpers/clock";
import { createTestDb, HOUR, makePlayer } from "./helpers/db";

/**
 * Where the best times come from: the clubs' cached free times (one read, never a fetch), the clubs a
 * person or a crew plays at, and the city's clubs after them. The create form, /play and the chat
 * each read it once.
 *
 * NOW is Saturday 10 October 2026, 05:00 UTC, 12:00 in Bangkok. Every hour below is Bangkok's:
 *   Rawai Padel Club (Phuket, where Nok plays on Thursdays at 19:00): Sat 15:00, 16:00; Thu 15 19:00, 20:00
 *   Chalong Padel Club (Phuket): Sun 11 09:00, 10:00
 *   Sukhumvit Padel Club (Bangkok, the same zone, another city): Sat 14:00, 15:00, the soonest of all
 *   Kata Padel Club (Phuket): a feed read four hours ago, too old to trust
 */
const NOW = new Date("2026-10-10T05:00:00Z");
freezeClock(NOW);
const TZ = "Asia/Bangkok";
const at = (date: string, time: string) => zonedTimeToUtc(date, time, TZ);
const hour = (date: string, time: string, free = 1): ClubFreeSlot => {
  const start = at(date, time);
  return { start: start.toISOString(), end: new Date(start.getTime() + HOUR).toISOString(), free };
};
const feed = (slots: ClubFreeSlot[]): ClubAvailability => ({ fetchedAt: NOW.toISOString(), day: "2026-10-10", tz: TZ, slots, error: null, source: "scrape:playtomic" });
const phuket = cityBySlug("phuket")!;
const said = (r: { name: string; date: string; time: string; usual: boolean }[]) => r.map((b) => `${b.name} ${b.date} ${b.time}${b.usual ? " *" : ""}`);

describe("the best times, read from the clubs' cache", () => {
  let db: Db;
  let close: () => Promise<void>;
  let nok: Player;
  const slug: Record<string, string> = {};

  async function club(name: string, slots: ClubFreeSlot[] | null, readAt = NOW) {
    const owner = await makePlayer(db, `Owner of ${name}`);
    const c = await claimClub(db, { name, playerId: owner.id, tz: TZ, courts: 4 });
    await decideClub(db, c.slug, true, NOW);
    if (slots) await db.update(clubs).set({ availability: { ...feed(slots), fetchedAt: readAt.toISOString() }, availabilityAt: readAt }).where(eq(clubs.slug, c.slug));
    slug[name] = c.slug;
    return c;
  }

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(async () => {
    await db.delete(events);
    await db.delete(groups);
    await db.delete(clubs);
    await club("Rawai Padel Club", [hour("2026-10-10", "15:00"), hour("2026-10-10", "16:00"), hour("2026-10-15", "19:00", 2), hour("2026-10-15", "20:00", 2)]);
    await club("Chalong Padel Club", [hour("2026-10-11", "09:00"), hour("2026-10-11", "10:00")]);
    await club("Sukhumvit Padel Club", [hour("2026-10-10", "14:00"), hour("2026-10-10", "15:00")]);
    await club("Kata Padel Club", [hour("2026-10-10", "15:00"), hour("2026-10-10", "16:00")], new Date(NOW.getTime() - 4 * HOUR));
    await club("Patong Padel Club", null);
    nok = await makePlayer(db, "Nok");
    // Nok played at Rawai last Thursday at 19:00, for 90 minutes: her usual club, day, hour and length.
    await createEvent(db, { creatorPlayerId: nok.id, type: "match", startsAt: at("2026-10-01", "19:00"), tz: TZ, venueName: "Rawai Padel Club", whenFull: "waitlist" });
  });

  it("the create form: each club near the person carries its free courts, and none from a stale feed", async () => {
    const venues = await venuesForPicking(db, nok.id, { tz: TZ }, NOW);
    const by = new Map(venues.map((v) => [v.slug, v]));
    expect(by.get(slug["Rawai Padel Club"])?.where).toBe("yours");
    // Touching hours with the same count read as one stretch.
    expect(by.get(slug["Rawai Padel Club"])?.free?.slots.map((s) => `${s.start} ${s.end}`)).toEqual([`${hour("2026-10-10", "15:00").start} ${hour("2026-10-10", "16:00").end}`, `${hour("2026-10-15", "19:00").start} ${hour("2026-10-15", "20:00").end}`]);
    expect(by.get(slug["Chalong Padel Club"])?.free?.tz).toBe(TZ);
    expect(by.get(slug["Kata Padel Club"])?.free).toBeNull();
    expect(by.get(slug["Patong Padel Club"])?.free).toBeNull();
  });

  it("/play: Nok's club at her usual time first, then the soonest, only clubs of the city", async () => {
    expect(said(await courtsFreeInCity(db, phuket, nok.id, NOW))).toEqual(["Rawai Padel Club 2026-10-15 19:00 *", "Rawai Padel Club 2026-10-10 15:00", "Chalong Padel Club 2026-10-11 09:00"]);
    // Anybody else gets the soonest; Bangkok's free court at 14:00 is in the same zone and never on Phuket's list.
    expect(said(await courtsFreeInCity(db, phuket, null, NOW))).toEqual(["Rawai Padel Club 2026-10-10 15:00", "Chalong Padel Club 2026-10-11 09:00", "Rawai Padel Club 2026-10-15 19:00"]);
  });

  it("/play: nothing at all when no club of the city shows a free court", async () => {
    await db.update(clubs).set({ availability: feed([]) }).where(eq(clubs.slug, slug["Rawai Padel Club"]));
    await db.update(clubs).set({ availability: { ...feed([]), error: "HTTP 500" } }).where(eq(clubs.slug, slug["Chalong Padel Club"]));
    expect(await courtsFreeInCity(db, phuket, nok.id, NOW)).toEqual([]);
  });

  it("a crew's chat: its usual court and its weekly slot first, then the city's other clubs", async () => {
    const crew = await createGroup(db, { name: "Thursday crew", creatorPlayerId: nok.id, tz: TZ, venueName: "Rawai Padel Club" });
    await db.update(groups).set({ recurDow: 4, recurTime: "19:00" }).where(eq(groups.id, crew.id));
    const r = await bestTimesForChat(db, { groupId: crew.id, playerId: null, venueName: null, tz: TZ }, NOW);
    expect(said(r.times)).toEqual(["Rawai Padel Club 2026-10-15 19:00 *", "Rawai Padel Club 2026-10-10 15:00", "Chalong Padel Club 2026-10-11 09:00"]);
    expect(r.lengthMinutes).toBe(90);
  });

  it("a player's private chat: their own history, and the chat's usual court", async () => {
    const mine = await bestTimesForChat(db, { groupId: null, playerId: nok.id, venueName: null, tz: TZ }, NOW);
    expect(said(mine.times)[0]).toBe("Rawai Padel Club 2026-10-15 19:00 *");
    // A stranger with no history in a chat whose usual court is Chalong: Chalong is theirs, and first when it is the soonest.
    const stranger = await bestTimesForChat(db, { groupId: null, playerId: null, venueName: "Chalong Padel Club", tz: TZ }, NOW);
    expect(said(stranger.times)).toEqual(["Rawai Padel Club 2026-10-10 15:00", "Chalong Padel Club 2026-10-11 09:00", "Rawai Padel Club 2026-10-15 19:00"]);
    // Nobody and nowhere: nothing to offer.
    expect((await bestTimesForChat(db, { groupId: null, playerId: null, venueName: null, tz: null }, NOW)).times).toEqual([]);
  });
});

describe("who the best times read, and how much", () => {
  let db: Db;
  let close: () => Promise<void>;
  const SAT_3PM = [hour("2026-10-10", "15:00"), hour("2026-10-10", "16:00")];

  /** A club the directory lists (no owner runs it), with a platform's read of its free courts. */
  async function listed(name: string, slots: ClubFreeSlot[] | null, o: Partial<typeof clubs.$inferInsert> = {}) {
    const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await db.insert(clubs).values({ slug: s, name, source: "directory", manageToken: `tok-${s}`, country: "TH", tz: TZ, ...(slots ? { availability: feed(slots), availabilityAt: NOW } : {}), ...o });
  }

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(async () => {
    await db.delete(events);
    await db.delete(groups);
    await db.delete(clubs);
  });

  it("the directory's clubs count: a platform's read of a club nobody runs is offered, named as the platform's", async () => {
    await listed("Rawai Padel", SAT_3PM, { city: "phuket" });
    const [first] = await courtsFreeInCity(db, phuket, null, NOW);
    expect(first).toMatchObject({ slug: "rawai-padel", time: "15:00", platform: "Playtomic" });
  });

  it("a club a player listed is not offered: its links are whatever that player typed, as for 'Book this court'", async () => {
    await listed("Rawai Padel", SAT_3PM, { city: "phuket", source: "player" });
    expect(await courtsFreeInCity(db, phuket, null, NOW)).toEqual([]);
  });

  it("a club's own feed wins over a platform's read, as on its page: a feed not read yet shows nothing", async () => {
    await listed("Rawai Padel", SAT_3PM, { city: "phuket", availabilityUrl: "https://rawai.example/feed.ics", availabilityKind: "ics_bookings" });
    expect(await courtsFreeInCity(db, phuket, null, NOW)).toEqual([]);
  });

  it("a club with no zone is never offered: its hours would be read in UTC", async () => {
    await listed("Rawai Padel", SAT_3PM, { city: "phuket", tz: null });
    expect(await courtsFreeInCity(db, phuket, null, NOW)).toEqual([]);
  });

  it("the city's own clubs come first: thirty clubs of another city in the same zone never push them out", async () => {
    for (let i = 10; i < 41; i++) await listed(`Bangkok Padel ${i}`, SAT_3PM, { city: "bangkok" });
    await listed("Rawai Padel", SAT_3PM, { city: "phuket" });
    expect((await courtsFreeInCity(db, phuket, null, NOW)).map((b) => b.slug)).toEqual(["rawai-padel"]);
  });

  it("/play ranks for the form's default length, which is what its link opens: never a 60-minute gap for a 90-minute form", async () => {
    // Lek's last match was 60 minutes. Karon has one free hour at 15:00; Rawai has 90 minutes at 17:00.
    const lek = await makePlayer(db, "Lek");
    await listed("Karon Padel", [hour("2026-10-10", "15:00")], { city: "phuket" });
    await listed("Rawai Padel", [hour("2026-10-10", "17:00"), hour("2026-10-10", "18:00")], { city: "phuket" });
    await createEvent(db, { creatorPlayerId: lek.id, type: "match", startsAt: at("2026-10-01", "19:00"), tz: TZ, venueName: "Karon Padel", durationMinutes: 60, whenFull: "waitlist" });
    expect((await courtsFreeInCity(db, phuket, lek.id, NOW)).map((b) => `${b.slug} ${b.time}`)).toEqual(["rawai-padel 17:00"]);
  });

  it("the create form: free courts for the clubs near the person, none for a club far away", async () => {
    await listed("Phuket Padel 1", SAT_3PM, { province: "Phuket" });
    await listed("Phuket Padel 2", SAT_3PM, { province: "Phuket" });
    await listed("Madrid Padel", SAT_3PM, { tz: "Europe/Madrid", country: "ES", availability: { ...feed(SAT_3PM), tz: "Europe/Madrid" } });
    const venues = await venuesForPicking(db, null, { tz: TZ, city: "Phuket" }, NOW);
    expect(venues.filter((v) => v.free).map((v) => v.slug)).toEqual(["phuket-padel-1", "phuket-padel-2"]);
    expect(venues.find((v) => v.slug === "madrid-padel")?.free).toBeNull();
  });

  it("the create form: twelve clubs' free courts at most, the ones first on the person's list", async () => {
    for (let i = 10; i < 26; i++) await listed(`Phuket Padel ${i}`, SAT_3PM, { province: "Phuket" });
    const venues = await venuesForPicking(db, null, { tz: TZ, city: "Phuket" }, NOW);
    expect(venues.filter((v) => v.where === "here")).toHaveLength(16);
    expect(venues.filter((v) => v.free).map((v) => v.slug)).toEqual(venues.slice(0, 12).map((v) => v.slug));
  });

  it("a read takes the cache only for the days it can use: nothing past the seven days, nothing already over", async () => {
    await listed("Rawai Padel", [hour("2026-10-09", "15:00"), ...SAT_3PM, hour("2026-10-30", "15:00")], { city: "phuket" });
    const [row] = await db.select(clubFeedColumns(NOW)).from(clubs).where(eq(clubs.slug, "rawai-padel"));
    expect(row.availability?.slots.map((x) => x.start)).toEqual(SAT_3PM.map((x) => x.start));
  });
});
