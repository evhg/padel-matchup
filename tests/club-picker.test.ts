import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { clubs, coaches, events, venues } from "@/db/schema";
import { unlistedVenues, venuesForPicking } from "@/lib/domain/clubs";
import { createEvent, updateEvent } from "@/lib/domain/events";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

/**
 * Picking where you play. Kicksmash lists 63 clubs, which is far more than anybody scrolls, so the
 * order carries the answer: the courts you use, then the clubs where you are, then everywhere else
 * by country and province. And whatever a person picks has to land on the club's own page.
 */
describe("picking a club", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(async () => {
    await db.delete(events);
    await db.delete(venues);
    await db.delete(coaches);
    await db.delete(clubs);
  });

  const listed = async (slug: string, name: string, extra: Partial<typeof clubs.$inferInsert> = {}) =>
    (await db.insert(clubs).values({ slug, name, source: "directory", manageToken: `tok-${slug}`, country: "TH", province: "Phuket", tz: "Asia/Bangkok", ...extra }).returning())[0];

  it("puts your own courts first, then where you are, then everywhere else", async () => {
    const me = await makePlayer(db, "Cath");
    await listed("warehaus", "WAREHAUS.club");
    await listed("kross-padel-asoke", "Kross Padel Asoke", { province: "Bangkok" });
    await listed("pop-padel", "Pop Padel", { country: "SG", province: "Singapore", tz: "Asia/Singapore" });
    await db.insert(venues).values({ creatorPlayerId: me.id, name: "Warehaus", lastUsedAt: new Date() });

    const list = await venuesForPicking(db, me.id, { tz: "Asia/Bangkok", city: "Bangkok" });
    expect(list.map((v) => `${v.where}:${v.name}`)).toEqual(["yours:Warehaus", "here:Kross Padel Asoke", "elsewhere:Pop Padel"]);
    // "Warehaus" on their own list and "WAREHAUS.club" in the directory are one club, and their own
    // name for it is the one their matches already say.
    expect(list[0].slug).toBe("warehaus");
    expect(list.filter((v) => v.slug === "warehaus")).toHaveLength(1);
  });

  it("shows the whole directory to somebody the app has never seen", async () => {
    await listed("warehaus", "WAREHAUS.club");
    await listed("pop-padel", "Pop Padel", { country: "SG", province: "Singapore", tz: "Asia/Singapore" });
    // No player, no time zone: still a list to pick from, ordered country, province, name.
    const list = await venuesForPicking(db, null, null);
    expect(list.map((v) => v.name)).toEqual(["Pop Padel", "WAREHAUS.club"]);
    expect(list.every((v) => v.where === "elsewhere")).toBe(true);
  });

  it("orders the rest by country, then province, then name", async () => {
    await listed("b-bkk", "B Bangkok", { province: "Bangkok" });
    await listed("a-bkk", "A Bangkok", { province: "Bangkok" });
    await listed("z-phuket", "Z Phuket");
    await listed("a-sing", "A Singapore", { country: "SG", province: "Singapore", tz: "Asia/Singapore" });
    // A time zone alone is still the coarse fallback: everything in it comes before everything else.
    const list = await venuesForPicking(db, null, "Asia/Singapore");
    expect(list.map((v) => v.name)).toEqual(["A Singapore", "A Bangkok", "B Bangkok", "Z Phuket"]);
    expect(list[0].where).toBe("nearby");
  });

  it("starts where the person actually is, not where the alphabet does", async () => {
    // Bangkok has sixteen clubs to Phuket's eight and sorts first, and both are Asia/Bangkok — so a
    // Phuket player looking at six rows saw six Bangkok clubs and none of their own. The time zone
    // cannot tell one Thai province from another; the city the edge reports can.
    await listed("a-bkk", "A Bangkok", { province: "Bangkok" });
    await listed("b-bkk", "B Bangkok", { province: "Bangkok" });
    await listed("z-phuket", "Z Phuket", { province: "Phuket" });
    await listed("a-sing", "A Singapore", { country: "SG", province: "Singapore", tz: "Asia/Singapore" });
    const list = await venuesForPicking(db, null, { tz: "Asia/Bangkok", city: "Phuket" });
    expect(list.map((v) => `${v.where}:${v.name}`)).toEqual(["here:Z Phuket", "nearby:A Bangkok", "nearby:B Bangkok", "elsewhere:A Singapore"]);
  });

  it("counts the clubs a coach teaches at as their own", async () => {
    const p = await makePlayer(db, "Bee");
    await listed("warehaus", "WAREHAUS.club");
    await listed("a-bkk", "A Bangkok", { province: "Bangkok" });
    await db.insert(coaches).values({ playerId: p.id, handle: "bee", displayName: "Bee", tz: "Asia/Bangkok", clubNames: ["WAREHAUS.club"], clubSlugs: ["warehaus"], hours: {} });
    const list = await venuesForPicking(db, p.id, { tz: "Asia/Bangkok", city: "Bangkok" });
    // Where they teach comes first even though they have never made a match there.
    expect(list[0]).toMatchObject({ name: "WAREHAUS.club", slug: "warehaus", where: "yours" });
    expect(list.filter((v) => v.slug === "warehaus")).toHaveLength(1);
  });

  it("hands every club a map link, its own or a search for it", async () => {
    await listed("rawai-padel", "Rawai Padel", { about: "Rawai Padel, 83/105 Rawai." });
    await listed("mine-club", "Mine Club", { mapUrl: "https://maps.app.goo.gl/real" });
    const byName = new Map((await venuesForPicking(db, null, null)).map((v) => [v.name, v.mapUrl]));
    // A club that published a link keeps it; one that has not gets a search for itself, so picking it
    // fills the map field rather than leaving it empty.
    expect(byName.get("Mine Club")).toBe("https://maps.app.goo.gl/real");
    expect(byName.get("Rawai Padel")).toBe(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("Rawai Padel, 83/105 Rawai")}`);
  });

  it("names the courts people played at that nobody lists, commonest first", async () => {
    const me = await makePlayer(db, "Cath");
    await listed("warehaus", "WAREHAUS.club");
    const since = new Date(Date.now() - 7 * 24 * HOUR);
    const at = async (name: string) => createEvent(db, { creatorPlayerId: me.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "Asia/Bangkok", venueName: name, whenFull: "closed" });
    await at("WAREHAUS.club");
    await at("Sigma Padel");
    await at("Sigma Padel");
    await at("Pista Padel");
    // A club that opened last month is on nobody's list yet, and the first people to play there type
    // its name on the day it opens. The club we do list is not news.
    expect(await unlistedVenues(db, since)).toEqual([
      { slug: "sigma-padel", name: "Sigma Padel", matches: 2 },
      { slug: "pista-padel", name: "Pista Padel", matches: 1 },
    ]);
  });

  it("lands a match on the club's own page, not on a second one made from its name", async () => {
    const me = await makePlayer(db, "Cath");
    await listed("warehaus", "WAREHAUS.club");
    // venueSlug("WAREHAUS.club") is "warehaus-club". A match there would have been the club's first
    // match on a page with none of its history, and its eight real ones would stay where they were.
    const ev = await createEvent(db, { creatorPlayerId: me.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "Asia/Bangkok", venueName: "WAREHAUS.club", whenFull: "closed" });
    expect(ev.venueSlug).toBe("warehaus");
    // Moving it to a club nobody lists still makes the slug from the name, exactly as before.
    const moved = await updateEvent(db, ev.id, me.id, { venueName: "Some Other Court" });
    expect(moved.event.venueSlug).toBe("some-other-court");
  });
});
