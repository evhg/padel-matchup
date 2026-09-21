import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { clubs } from "@/db/schema";
import { DomainError } from "@/lib/domain/errors";
import { addClub, claimClub, clubsAddedSince, decideClub, isClubListed, listShownClubs } from "@/lib/domain/clubs";
import { createTestDb, makePlayer } from "./helpers/db";

/**
 * Anybody lists a club; only its owner or manager claims one.
 *
 * Every club on Kicksmash came from Thailand or Singapore, so a player anywhere else had no way to
 * put their own club on the map. Listing is the way in, and the court split is the price of it.
 */
describe("a club a player listed", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  it("appears at once, run by nobody, credited to the person who listed it", async () => {
    const aisha = await makePlayer(db, "Aisha");
    const club = await addClub(db, { name: "KL Padel Club", playerId: aisha.id, place: "Kuala Lumpur", country: "MY", courts: 6, courtsIndoor: 4, courtsOutdoor: 2 });
    expect(club.source).toBe("player");
    expect(club.addedBy).toBe(aisha.id);
    expect(club.claimedBy).toBeNull();
    expect(club.approvedAt).toBeNull();
    expect(club.courtsIndoor).toBe(4);
    expect(club.courtsOutdoor).toBe(2);
    // Shown on /clubs, the city pages and the sitemap, exactly like a directory row.
    expect(isClubListed(club)).toBe(true);
    expect((await listShownClubs(db)).map((c) => c.slug)).toContain("kl-padel-club");
  });

  it("refuses a second listing of a club that already has a page", async () => {
    const ben = await makePlayer(db, "Ben");
    await addClub(db, { name: "Berlin Padel", playerId: ben.id, place: "Berlin", country: "DE", courts: 4, courtsIndoor: 4, courtsOutdoor: 0 });
    const again = await makePlayer(db, "Bea");
    await expect(addClub(db, { name: "Berlin Padel", playerId: again.id, courts: 2, courtsIndoor: 2, courtsOutdoor: 0 })).rejects.toThrow(DomainError);
  });

  it("lets the real club claim the page a player listed, keeping one page and its history", async () => {
    const carl = await makePlayer(db, "Carl");
    const listed = await addClub(db, { name: "Madrid Padel Indoor", playerId: carl.id, place: "Madrid", country: "ES", courts: 8, courtsIndoor: 8, courtsOutdoor: 0 });
    const manager = await makePlayer(db, "Nuria");
    const claimed = await claimClub(db, { name: "Madrid Padel Indoor", playerId: manager.id, claimRole: "manager", claimContact: "nuria@madridpadel.es" });
    // The same row, not a second page: the matches already on that slug stay with it.
    expect(claimed.slug).toBe(listed.slug);
    expect(claimed.source).toBe("claim");
    expect(claimed.claimedBy).toBe(manager.id);
    // The person who put it on the map keeps the credit.
    expect(claimed.addedBy).toBe(carl.id);
  });

  it("counts what one person listed today, for the day limit", async () => {
    const dee = await makePlayer(db, "Dee");
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(await clubsAddedSince(db, dee.id, since)).toBe(0);
    await addClub(db, { name: "Dee Padel One", playerId: dee.id, courts: 2, courtsIndoor: 2, courtsOutdoor: 0 });
    await addClub(db, { name: "Dee Padel Two", playerId: dee.id, courts: 2, courtsIndoor: 0, courtsOutdoor: 2 });
    expect(await clubsAddedSince(db, dee.id, since)).toBe(2);
  });

  it("comes off every list when the owner takes it down, with the reason kept", async () => {
    const eve = await makePlayer(db, "Eve");
    const club = await addClub(db, { name: "Not A Padel Club", playerId: eve.id, courts: 1, courtsIndoor: 1, courtsOutdoor: 0 });
    const down = await decideClub(db, club.slug, false, new Date("2026-09-21T10:00:00Z"), "not_a_club");
    expect(down?.claimDecision).toBe("not_a_club");
    expect(isClubListed(down!)).toBe(false);
    expect((await listShownClubs(db)).map((c) => c.slug)).not.toContain(club.slug);
  });

  it("clears a stale reason when a page is approved later", async () => {
    const fay = await makePlayer(db, "Fay");
    const club = await claimClub(db, { name: "Second Chance Padel", playerId: fay.id, claimRole: "owner", claimContact: "fay@secondchance.example" });
    await decideClub(db, club.slug, false, new Date("2026-09-21T10:00:00Z"), "unconfirmed");
    const live = await decideClub(db, club.slug, true, new Date("2026-09-21T11:00:00Z"));
    expect(live?.claimDecision).toBeNull();
    expect(live?.rejectedAt).toBeNull();
    expect(live?.approvedAt).not.toBeNull();
  });

  it("keeps an unknown reason out of the column", async () => {
    const gus = await makePlayer(db, "Gus");
    const club = await addClub(db, { name: "Gus Padel", playerId: gus.id, courts: 2, courtsIndoor: 2, courtsOutdoor: 0 });
    // @ts-expect-error a reason that is not one of the four must not be stored
    const down = await decideClub(db, club.slug, false, new Date(), "because-i-said-so");
    expect(down?.claimDecision).toBeNull();
    expect(down?.rejectedAt).not.toBeNull();
    await db.delete(clubs).where(eq(clubs.slug, club.slug));
  });
});
