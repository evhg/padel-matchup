import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freezeClock } from "./helpers/clock";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events } from "@/db/schema";
import { claimClub, decideClub, updateClub } from "@/lib/domain/clubs";
import { addClubSlot, autoCreateClubEvents, cleanSlotInput, clubDay, clubWeek, listClubSlots, removeClubSlot, slotDue, updateClubSlot, upcomingBySlot } from "@/lib/domain/clubWeek";
import { createEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";

/** Tuesday 8 September 2026, 16:00 in Phuket. */
const NOW = new Date("2026-09-08T09:00:00Z");
freezeClock(NOW);

describe("the club programme", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  it("cleans a slot: weekday, time, format defaults, capacity in fours, level range, lead days", () => {
    const s = cleanSlotInput({ dow: 4, time: "19:00", type: "tournament", format: "mexicano", capacity: 12, levelMin: 3, levelMax: 4.5, title: "  Gold night ", leadDays: 30 });
    // A weekly slot looks one occurrence ahead, so the lead tops out at seven days.
    expect(s).toMatchObject({ dow: 4, time: "19:00", type: "tournament", format: "mexicano", capacity: 12, levelMin: 3, levelMax: 4.5, title: "Gold night", leadDays: 7, whenFull: "waitlist" });
    expect(cleanSlotInput({ dow: 0, time: "07:30" })).toMatchObject({ type: "match", format: null, capacity: 4, levelMin: null, levelMax: null, leadDays: 6 });
    // A match is four people whatever was typed: the slot and the event it becomes agree.
    expect(cleanSlotInput({ dow: 0, time: "07:30", type: "match", capacity: 8 }).capacity).toBe(4);
    expect(() => cleanSlotInput({ dow: 7, time: "19:00" })).toThrow();
    expect(() => cleanSlotInput({ dow: 1, time: "25:00" })).toThrow();
    expect(() => cleanSlotInput({ dow: 1, time: "19:00", type: "tournament", capacity: 6 })).toThrow();
  });

  it("turns a live club's due slots into public matches on its board, once each, and shows the week and the day", async () => {
    const nok = await makePlayer(db, "Nok");
    const club = await claimClub(db, { name: "Week Padel Club", playerId: nok.id, tz: "Asia/Bangkok" });
    // Not approved yet: nothing is created even with a due slot.
    const early = await addClubSlot(db, club.slug, { dow: 4, time: "19:00", type: "tournament", format: "americano", capacity: 8, levelMin: 3, levelMax: 4.5, title: "Gold night" });
    expect(slotDue(early, "Asia/Bangkok", NOW)?.toISOString()).toBe("2026-09-10T12:00:00.000Z");
    expect((await autoCreateClubEvents(db, NOW)).created.filter((c) => c.club.slug === club.slug)).toHaveLength(0);

    await decideClub(db, club.slug, true, NOW);
    await addClubSlot(db, club.slug, { dow: 6, time: "09:00", capacity: 4 });
    const paused = await addClubSlot(db, club.slug, { dow: 3, time: "18:00", capacity: 8, type: "tournament", format: "king" });
    await updateClubSlot(db, club.slug, paused.id, { active: false });
    expect(await listClubSlots(db, club.slug)).toHaveLength(3);

    const run = await autoCreateClubEvents(db, NOW);
    expect(run.errors).toEqual([]);
    const created = run.created.filter((c) => c.club.slug === club.slug);
    expect(created.map((c) => c.slot.id).sort()).toEqual([early.id, (await listClubSlots(db, club.slug)).find((s) => s.dow === 6)!.id].sort());
    const gold = created.find((c) => c.slot.id === early.id)!.event;
    expect(gold.creatorPlayerId).toBe(nok.id);
    expect(gold.type).toBe("tournament");
    expect(gold.format).toBe("americano");
    expect(gold.capacity).toBe(8);
    expect(gold.levelMin).toBe(3);
    expect(gold.levelMax).toBe(4.5);
    expect(gold.title).toBe("Gold night");
    expect(gold.publicListing).toBe(true);
    expect(gold.venueSlug).toBe(club.slug);
    expect(gold.startsAt.toISOString()).toBe("2026-09-10T12:00:00.000Z");
    const [stored] = await db.select().from(events).where(eq(events.id, gold.id));
    expect(stored.clubSlotId).toBe(early.id);
    // An hour later: nothing new. A week later: the next Thursday.
    expect((await autoCreateClubEvents(db, new Date(NOW.getTime() + HOUR))).created.filter((c) => c.club.slug === club.slug)).toHaveLength(0);
    const nextWeek = (await autoCreateClubEvents(db, new Date(NOW.getTime() + 7 * DAY))).created.filter((c) => c.club.slug === club.slug && c.slot.id === early.id);
    expect(nextWeek).toHaveLength(1);
    expect(nextWeek[0].event.startsAt.toISOString()).toBe("2026-09-17T12:00:00.000Z");

    // A social earlier today (09:00 local, it is 16:00): gone from the public week, still on the staff's day.
    const morning = await createEvent(db, { creatorPlayerId: nok.id, type: "match", startsAt: new Date("2026-09-08T02:00:00Z"), tz: "Asia/Bangkok", venueName: club.name, whenFull: "waitlist", publicListing: true });
    // The week as players see it: seven local days from Tuesday, Thursday carrying the gold night with eight open seats.
    const week = await clubWeek(db, club, NOW);
    expect(week[0].events.map((b) => b.event.id)).not.toContain(morning.id);
    expect((await clubDay(db, club, NOW)).events.map((b) => b.event.id)).toContain(morning.id);
    expect(week.map((d) => d.date)).toEqual(["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"]);
    const thu = week.find((d) => d.date === "2026-09-10")!;
    expect(thu.events).toHaveLength(1);
    expect(thu.events[0].occupied).toBe(0);
    expect(thu.events[0].spotsLeft).toBe(8);
    expect(week.find((d) => d.date === "2026-09-12")!.events).toHaveLength(1);

    // Staff view on Thursday: who is in, who waits.
    const ana = await makePlayer(db, "Ana");
    await joinEvent(db, { eventId: gold.id, playerId: ana.id, now: NOW });
    const day = await clubDay(db, club, new Date("2026-09-10T02:00:00Z"));
    expect(day.date).toBe("2026-09-10");
    expect(day.events).toHaveLength(1);
    expect(day.events[0].names).toEqual(["Ana"]);
    expect(day.events[0].occupied).toBe(1);
    expect(day.events[0].waiting).toBe(0);
    expect((await upcomingBySlot(db, club.slug, NOW)).get(early.id)?.id).toBe(gold.id);
    expect((await upcomingBySlot(db, club.slug, new Date("2026-09-11T00:00:00Z"))).get(early.id)?.id).toBe(nextWeek[0].event.id);

    // Moving a slot forgets the guard; removing it keeps the matches already on the page.
    const moved = await updateClubSlot(db, club.slug, early.id, { time: "20:00" });
    expect(moved?.lastCreatedFor).toBeNull();
    expect(moved?.time).toBe("20:00");
    expect(await removeClubSlot(db, club.slug, early.id)).toBe(true);
    const [kept] = await db.select().from(events).where(eq(events.id, gold.id));
    expect(kept.status).not.toBe("cancelled");
    expect(kept.clubSlotId).toBeNull();
    expect(await removeClubSlot(db, "another-club", paused.id)).toBe(false);
  });

  it("a club claimed without a zone takes its city's, at the claim or when the city is set later", async () => {
    const owner = await makePlayer(db, "Somchai");
    const fromCity = await claimClub(db, { name: "Kata Padel", playerId: owner.id, tz: null, city: "phuket" });
    expect(fromCity.tz).toBe("Asia/Bangkok");
    const owner2 = await makePlayer(db, "Lin");
    const bare = await claimClub(db, { name: "Nowhere Courts", playerId: owner2.id, tz: null });
    expect(bare.tz).toBeNull();
    const later = await updateClub(db, bare.manageToken, { city: "singapore" });
    expect(later?.tz).toBe("Asia/Singapore");
  });

  it("keeps a whole local day on a clock-change day", async () => {
    const owner = await makePlayer(db, "Marta");
    const club = await claimClub(db, { name: "Madrid Padel Norte", playerId: owner.id, tz: "Europe/Madrid" });
    await decideClub(db, club.slug, true, NOW);
    // Sunday 25 October 2026 has 25 hours in Madrid; a 23:00 match is 22:00Z after the clocks go back.
    const late = await createEvent(db, { creatorPlayerId: owner.id, type: "match", startsAt: new Date("2026-10-25T22:00:00Z"), tz: "Europe/Madrid", venueName: club.name, whenFull: "waitlist", publicListing: true });
    const day = await clubDay(db, club, new Date("2026-10-25T08:00:00Z"));
    expect(day.date).toBe("2026-10-25");
    expect(day.events.map((b) => b.event.id)).toContain(late.id);
    const week = await clubWeek(db, club, new Date("2026-10-25T08:00:00Z"));
    expect(week.map((d) => d.date)).toEqual(["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"]);
  });
});
