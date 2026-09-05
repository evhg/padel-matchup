import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events } from "@/db/schema";
import { cancelEvent, createEvent, updateEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { getVenueBoard, isValidVenueSlug, setPublicListing, venueSlug } from "@/lib/domain/venueBoard";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("venue slugs", () => {
  it("normalizes names into URL keys", () => {
    expect(venueSlug("Padel Indoor BCN")).toBe("padel-indoor-bcn");
    expect(venueSlug("  Club Nine!! ")).toBe("club-nine");
    expect(venueSlug("Pádel Señorío")).toBe("padel-senorio");
    expect(venueSlug("")).toBeNull();
    expect(venueSlug("Падел")).toBeNull();
    expect(isValidVenueSlug("club-nine")).toBe(true);
    expect(isValidVenueSlug("-bad")).toBe(false);
  });
});

describe("venue board", () => {
  it("lists only opted-in, upcoming, live matches at the venue, with spot counts", async () => {
    const org = await makePlayer(db, "Host");
    const base = { creatorPlayerId: org.id, type: "match" as const, tz: "UTC", whenFull: "waitlist" as const, venueName: "Club Nine" };
    const listed = await createEvent(db, { ...base, startsAt: new Date(Date.now() + 2 * HOUR), publicListing: true });
    const unlisted = await createEvent(db, { ...base, startsAt: new Date(Date.now() + 3 * HOUR) });
    const past = await createEvent(db, { ...base, startsAt: new Date(Date.now() - 3 * HOUR), publicListing: true });
    const cancelled = await createEvent(db, { ...base, startsAt: new Date(Date.now() + 4 * HOUR), publicListing: true });
    await cancelEvent(db, cancelled.id, org.id);
    const elsewhere = await createEvent(db, { ...base, venueName: "Other Club", startsAt: new Date(Date.now() + 2 * HOUR), publicListing: true });
    await joinEvent(db, { eventId: listed.id, playerId: org.id });
    expect(listed.venueSlug).toBe("club-nine");
    expect(listed.publicListing).toBe(true);
    expect(unlisted.publicListing).toBe(false);

    const board = (await getVenueBoard(db, "club-nine"))!;
    expect(board.name).toBe("Club Nine");
    expect(board.events.map((b) => b.event.id)).toEqual([listed.id]);
    expect(board.events[0]).toMatchObject({ occupied: 1, spotsLeft: 3 });
    expect((await getVenueBoard(db, "other-club"))!.events.map((b) => b.event.id)).toEqual([elsewhere.id]);
    expect(await getVenueBoard(db, "never-used")).toBeNull();
    void past;

    // toggling on/off
    await setPublicListing(db, unlisted.id, true);
    expect((await getVenueBoard(db, "club-nine"))!.events).toHaveLength(2);
    await setPublicListing(db, unlisted.id, false);
    expect((await getVenueBoard(db, "club-nine"))!.events).toHaveLength(1);
  });
  it("renaming the venue moves the listing; removing it unlists", async () => {
    const org = await makePlayer(db, "Mover");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", tz: "UTC", whenFull: "waitlist", venueName: "Alpha Padel", startsAt: new Date(Date.now() + 2 * HOUR), publicListing: true });
    await updateEvent(db, ev.id, org.id, { venueName: "Beta Padel" });
    let [row] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(row.venueSlug).toBe("beta-padel");
    expect(row.publicListing).toBe(true);
    expect((await getVenueBoard(db, "beta-padel"))!.events).toHaveLength(1);
    await updateEvent(db, ev.id, org.id, { venueName: "" });
    [row] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(row.venueSlug).toBeNull();
    expect(row.publicListing).toBe(false);
    // listing requires a venue
    const bare = await createEvent(db, { creatorPlayerId: org.id, type: "match", tz: "UTC", whenFull: "waitlist", startsAt: new Date(Date.now() + 2 * HOUR), publicListing: true });
    expect(bare.publicListing).toBe(false);
    await updateEvent(db, bare.id, org.id, { venueName: "Gamma", publicListing: true });
    [row] = await db.select().from(events).where(eq(events.id, bare.id));
    expect(row.publicListing).toBe(true);
    expect(row.venueSlug).toBe("gamma");
  });
});
