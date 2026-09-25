import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { eq, sql } from "drizzle-orm";
import { clubCourts, clubs, clubSlots, type Club } from "@/db/schema";
import { claimClub, clubStatus, decideClub, getClub, getClubByToken, isClubListed, isClubLive, listClubsForPicking, listLiveClubs, listPendingClubs, listShownClubs } from "@/lib/domain/clubs";
import { addClubSlot } from "@/lib/domain/clubWeek";
import { replaceCourts } from "@/lib/domain/courts";
import { directoryListing } from "@/lib/domain/directory";
import { venueSlug } from "@/lib/domain/venueBoard";
import { createTestDb, makePlayer } from "./helpers/db";

const root = (p: string) => path.resolve(process.cwd(), p);
type Row = { slug: string; name: string; country: string; province: string; city: string | null; tz: string; courts: number | null; courtsIndoor: number | null; courtsOutdoor: number | null; website: string | null; sources: string[] };
const file = JSON.parse(readFileSync(root("data/clubs.json"), "utf8")) as { clubs: Row[] };

/**
 * Kicksmash knew one club: the one its two coaches typed by hand, two different ways. The directory
 * is every padel club in Thailand and Singapore that a public source names, so a player picks by
 * name instead of spelling. These are the rules that keep it honest.
 */
describe("the club directory as a file", () => {
  it("is every row usable, with no two clubs answering to one slug", () => {
    expect(file.clubs.length).toBeGreaterThan(50);
    const slugs = file.clubs.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const c of file.clubs) {
      // The slug is the key a match, a coach's clubs and a club page all share. A row whose slug is
      // not what venueSlug() would make is a row nothing can ever match.
      expect(venueSlug(c.slug), c.slug).toBe(c.slug);
      expect(c.name.trim(), c.slug).not.toBe("");
      expect(c.country, c.slug).toMatch(/^[A-Z]{2}$/);
      expect(c.province.trim(), c.slug).not.toBe("");
      expect(c.tz, c.slug).toMatch(/^[A-Za-z]+\/[A-Za-z_]+$/);
      expect(c.sources.length, c.slug).toBeGreaterThan(0);
    }
  });

  it("never claims more than a source said", () => {
    for (const c of file.clubs) {
      // A split that exceeds the total is a number somebody invented. Either may be null: a source
      // that said "6 courts, 4 covered" leaves the outdoor count unsaid, and unsaid stays unsaid.
      if (c.courts !== null && c.courtsIndoor !== null) expect(c.courtsIndoor, c.slug).toBeLessThanOrEqual(c.courts);
      if (c.courts !== null && c.courtsOutdoor !== null) expect(c.courtsOutdoor, c.slug).toBeLessThanOrEqual(c.courts);
      for (const n of [c.courts, c.courtsIndoor, c.courtsOutdoor]) if (n !== null) expect(Number.isInteger(n) && n >= 0, c.slug).toBe(true);
      if (c.website !== null) expect(c.website, c.slug).toMatch(/^https?:\/\//);
    }
  });

  it("keeps the slug the live data already carries", () => {
    // Production keys on "warehaus": eight matches and both coaches' clubs. One match is at
    // "blue-tree", one at "sterling". A tidier "warehaus-club" here would be a second page for the
    // same club, with all of the history on the other one. The name is what the club calls itself;
    // the slug is its address.
    const bySlug = new Map(file.clubs.map((c) => [c.slug, c]));
    expect(bySlug.get("warehaus")?.name).toBe("WAREHAUS.club");
    expect(bySlug.get("blue-tree")?.name).toBe("Padel Phuket @ Blue Tree");
    expect(bySlug.get("sterling")?.name).toBe("Sterling Sport & Wellness");
  });

  it("turns into one statement that only ever touches the directory's own rows", () => {
    const sql = execFileSync("node", [root("scripts/import-clubs.mjs"), "--sql"], { encoding: "utf8" });
    // One upsert over a VALUES list: one row per club, and one guard to read rather than sixty-three.
    expect((sql.match(/insert into clubs/g) ?? []).length).toBe(1);
    expect((sql.match(/^ {2}\('/gm) ?? []).length).toBe(file.clubs.length);
    // Without this a re-run would overwrite a club owner's own edits with whatever the file still said.
    expect(sql).toContain("where clubs.source = 'directory' and clubs.claimed_by is null;");
    // Every club in the file reaches the statement, by the slug everything else keys on.
    for (const c of file.clubs) expect(sql, c.slug).toContain(`('${c.slug}', `);
  });
});

describe("the club directory in the database", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(async () => {
    await db.delete(clubs);
  });

  const listed = async (slug: string, name: string, extra: Partial<typeof clubs.$inferInsert> = {}) =>
    (await db.insert(clubs).values({ slug, name, source: "directory", manageToken: `tok-${slug}`, country: "TH", province: "Phuket", ...extra }).returning())[0];

  it("lists a club nobody has claimed, without saying anybody runs it", async () => {
    const row = await listed("warehaus", "WAREHAUS.club");
    expect(row.claimedBy).toBeNull();
    expect(row.approvedAt).toBeNull();
    // Not "live": live means a club owner claimed it and the owner approved. A directory row is neither.
    expect(await listLiveClubs(db)).toEqual([]);
    // But pickable, which is the whole point of it.
    expect((await listClubsForPicking(db)).map((c) => c.slug)).toEqual(["warehaus"]);
  });

  it("shows a club nobody has claimed, and never says the club runs it", async () => {
    // Sixty-six clubs held a name, a province, a court count and a booking link, and every page hid
    // all of it behind a claim nobody had made — so a club owner hunting for their own club found
    // nothing, and a player looking for a club found an empty list.
    await listed("warehaus", "WAREHAUS.club", { city: "phuket", courts: 5 });
    const own = await listed("baan-padel", "Baan Padel", { province: "Bangkok" });
    expect(await listLiveClubs(db)).toEqual([]);
    expect((await listShownClubs(db)).map((c) => c.slug).sort()).toEqual(["baan-padel", "warehaus"]);
    // Shown is not run-by-anybody: the page reads one to print the facts and the other to decide
    // what the club manages.
    expect([isClubListed(own), isClubLive(own)]).toEqual([true, false]);
    // A city asks for its own, and the one outside it does not come along.
    expect((await listShownClubs(db, "phuket")).map((c) => c.slug)).toEqual(["warehaus"]);
  });

  it("stops showing a club whose claim was rejected, even though it is still a directory row", async () => {
    // The row stays `directory`, so the only thing keeping it off every page is the rejection. An
    // earlier version of this test also flipped `source`, which made it pass for the wrong reason:
    // it went green with the rejection check deleted.
    const row = await listed("ghost-padel", "Ghost Padel");
    await db.update(clubs).set({ rejectedAt: new Date() }).where(eq(clubs.slug, row.slug));
    const [after] = await db.select().from(clubs).where(eq(clubs.slug, row.slug));
    expect(after.source).toBe("directory");
    expect(isClubListed(after)).toBe(false);
    expect(await listShownClubs(db)).toEqual([]);
    expect(await listClubsForPicking(db)).toEqual([]);
  });

  it("lets the real owner claim it — the bug that would have made the directory a trap", async () => {
    await listed("warehaus", "WAREHAUS.club");
    const owner = await makePlayer(db, "Nok");
    // Before the null check in claimClub, `null !== owner.id` threw already_claimed here, and every
    // club in the directory would have told its own owner that somebody else had it.
    const claimed = await claimClub(db, { playerId: owner.id, name: "WAREHAUS.club", tz: "Asia/Bangkok" });
    expect(claimed.claimedBy).toBe(owner.id);
    expect(claimed.source).toBe("claim");
    expect(clubStatus(claimed)).toBe("pending");
    // What the directory knew is still there for the owner to correct rather than retype.
    expect(claimed.country).toBe("TH");
    expect(claimed.province).toBe("Phuket");
    // And it is the listing, not a second page: venueSlug("WAREHAUS.club") is "warehaus-club", and
    // claiming under that slug would have left the club's eight matches on the page nobody manages.
    expect(claimed.slug).toBe("warehaus");
    expect(await db.select().from(clubs)).toHaveLength(1);
  });

  it("still stops somebody claiming a club another person holds", async () => {
    const first = await makePlayer(db, "First");
    const second = await makePlayer(db, "Second");
    await claimClub(db, { playerId: first.id, name: "Rawai Padel", tz: "Asia/Bangkok" });
    await expect(claimClub(db, { playerId: second.id, name: "Rawai Padel", tz: "Asia/Bangkok" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("orders a picker's list by country, then province, then name", async () => {
    await listed("b-thai", "B Thai", { country: "TH", province: "Bangkok" });
    await listed("a-thai", "A Thai", { country: "TH", province: "Phuket" });
    await listed("z-sing", "Z Singapore", { country: "SG", province: "Singapore" });
    await listed("a-sing", "A Singapore", { country: "SG", province: "Singapore" });
    expect((await listClubsForPicking(db)).map((c) => c.slug)).toEqual(["a-sing", "z-sing", "b-thai", "a-thai"]);
  });
});

/**
 * Erik plays at Warehaus and claimed it once as a test, on 20 September 2026. The claim wrote
 * `source: "claim"` over the directory's row and the refusal left it refused, so the court with the
 * most matches in the app fell off `/clubs`, the Phuket page, the venue picker and the claim form.
 *
 * The rows here come from the import script's own statement, the way production's did, and the
 * times are production's: listed on 16 September at 02:21 UTC, refused on the 20th at 09:45.
 */
describe("a refused claim on a club the directory listed", () => {
  let db: Db;
  let close: () => Promise<void>;
  const LISTED_AT = new Date("2026-09-16T02:21:17.265Z");
  const REFUSED_AT = new Date("2026-09-20T09:45:55.953Z");
  const importSql = execFileSync("node", [root("scripts/import-clubs.mjs"), "--sql"], { encoding: "utf8" });
  const migration = readFileSync(root(`drizzle/${readdirSync(root("drizzle")).find((f) => f.endsWith("_warehaus_listed_again.sql"))}`), "utf8");
  const importDirectory = async () => {
    await db.execute(sql.raw(importSql));
    // The import writes both from the database's clock, in one statement; production's are the 16th.
    await db.update(clubs).set({ createdAt: LISTED_AT, claimedAt: LISTED_AT });
  };

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(async () => {
    await db.delete(clubs);
    await importDirectory();
  });

  /** Every column but the two a hand-back renews: the manage link and the edit time. */
  const facts = (c: Club) => {
    const { manageToken, updatedAt, ...rest } = c;
    void manageToken;
    void updatedAt;
    return rest;
  };

  /** Erik's claim, with everything a claimant can type, the courts by name and a week on top. */
  const claimAsErik = async () => {
    const erik = await makePlayer(db, "Erik");
    const claimed = await claimClub(db, {
      playerId: erik.id,
      name: "Warehaus",
      tz: "Asia/Bangkok",
      place: "Cherngtalay",
      website: "https://warehaus.example",
      bookingUrl: "https://playtomic.io/warehaus",
      mapUrl: "https://maps.example/warehaus",
      courts: 5,
      courtsIndoor: 5,
      courtsOutdoor: "",
      about: "",
      opensAt: "07:00",
      closesAt: "22:00",
      availabilityUrl: "https://warehaus.example/free.json",
      availabilityKind: "json_free",
      claimRole: "owner",
      claimContact: "erik@warehaus.example",
    });
    await replaceCourts(db, claimed.manageToken, [{ name: "Centre", kind: "indoor" }, { name: "Court 2", kind: "indoor" }]);
    await addClubSlot(db, claimed.slug, { dow: 2, time: "18:00", type: "match" });
    return claimed;
  };

  it("hands the listing back as the directory has it when the refusal is about the claimant", async () => {
    const listed = (await getClub(db, "warehaus"))!;
    expect(isClubListed(listed)).toBe(true);
    const claimed = await claimAsErik();
    // The claim is on the listing itself, not a second page, and it took the listing off the lists.
    expect(claimed.slug).toBe("warehaus");
    expect(claimed.courts).toBe(5);
    expect(claimed.about).toBeNull();

    const refused = (await decideClub(db, "warehaus", false, REFUSED_AT, "unconfirmed"))!;
    // Every column is what the directory import wrote: the name, the place, the description the claim
    // cleared, no courts because no source said, and nobody's claim, link or hours.
    expect(facts(refused)).toEqual(facts(listed));
    expect(refused.source).toBe("directory");
    expect(refused.claimedBy).toBeNull();
    expect(refused.about).toBe("WAREHAUS.club, Cherngtalay, Thalang.");
    // The courts it named and the week it set were the claim's, and went with it.
    expect(await db.select().from(clubCourts).where(eq(clubCourts.clubSlug, "warehaus"))).toEqual([]);
    expect(await db.select().from(clubSlots).where(eq(clubSlots.clubSlug, "warehaus"))).toEqual([]);
    // The refused claimant's manage link edits nothing any more.
    expect(refused.manageToken).not.toBe(claimed.manageToken);
    expect(await getClubByToken(db, claimed.manageToken)).toBeNull();
    // Back on every list a player reads, and not a claim waiting for the owner.
    expect(isClubListed(refused)).toBe(true);
    expect((await listShownClubs(db, "phuket")).map((c) => c.slug)).toContain("warehaus");
    expect((await listClubsForPicking(db)).map((c) => c.slug)).toContain("warehaus");
    expect(await listPendingClubs(db)).toEqual([]);
    // And the club's real owner can still claim it.
    const owner = await makePlayer(db, "Nok");
    expect((await claimClub(db, { playerId: owner.id, name: "WAREHAUS.club", tz: "Asia/Bangkok" })).claimedBy).toBe(owner.id);
  });

  it("does the same when the refusal gives no reason, as Erik's did", async () => {
    await claimAsErik();
    const refused = (await decideClub(db, "warehaus", false, REFUSED_AT))!;
    expect(isClubListed(refused)).toBe(true);
    expect(refused.courts).toBeNull();
  });

  it("keeps it off every list when the refusal says the page should not exist", async () => {
    for (const reason of ["not_a_club", "duplicate"] as const) {
      await claimAsErik();
      const refused = (await decideClub(db, "warehaus", false, REFUSED_AT, reason))!;
      expect(refused.claimDecision, reason).toBe(reason);
      expect(isClubListed(refused), reason).toBe(false);
      expect((await listShownClubs(db)).map((c) => c.slug), reason).not.toContain("warehaus");
      expect((await listClubsForPicking(db)).map((c) => c.slug), reason).not.toContain("warehaus");
      await db.delete(clubs);
      await importDirectory();
    }
  });

  it("leaves a refused claim refused when the claim made the row itself", async () => {
    const ghost = await makePlayer(db, "Ghost");
    const claimed = await claimClub(db, { playerId: ghost.id, name: "Ghost Courts", tz: "Asia/Bangkok", courts: 2 });
    const refused = (await decideClub(db, claimed.slug, false, REFUSED_AT, "unconfirmed"))!;
    expect(clubStatus(refused)).toBe("rejected");
    expect(refused.manageToken).toBe(claimed.manageToken);
    expect(isClubListed(refused)).toBe(false);
    // Even under a slug the directory knows: on a database the directory never reached, the claim
    // made the row, so there is no listing to hand back.
    await db.delete(clubs);
    const first = await claimClub(db, { playerId: ghost.id, name: "Warehaus", tz: "Asia/Bangkok", courts: 5 });
    expect(first.slug).toBe("warehaus");
    const alone = (await decideClub(db, "warehaus", false, REFUSED_AT, "unconfirmed"))!;
    expect([clubStatus(alone), alone.source, alone.courts]).toEqual(["rejected", "claim", 5]);
  });

  it("reads the directory the way the import script writes it, club by club", async () => {
    const rows = await db.select().from(clubs);
    expect(rows).toHaveLength(file.clubs.length);
    for (const r of rows) {
      const { name, country, province, city, tz, courts, courtsIndoor, courtsOutdoor, website, about } = r;
      expect({ name, country, province, city, tz, courts, courtsIndoor, courtsOutdoor, website, about }, r.slug).toEqual(directoryListing(r.slug));
    }
    expect(directoryListing("warehaus-club")).toBeNull();
  });

  it("repairs production's row with the migration exactly as a refusal now would", async () => {
    const listed = (await getClub(db, "warehaus"))!;
    const claimed = await claimAsErik();
    // Refused the old way, which is how production holds it: the hour, and nothing handed back.
    await db.update(clubs).set({ rejectedAt: REFUSED_AT, approvedAt: null, founding: false, notifyMessageId: 4242 }).where(eq(clubs.slug, "warehaus"));
    for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
    const repaired = (await getClub(db, "warehaus"))!;
    expect(facts(repaired)).toEqual(facts(listed));
    expect(repaired.manageToken).not.toBe(claimed.manageToken);
    expect(repaired.manageToken).toMatch(/^[A-Za-z0-9_-]{16,40}$/);
    expect(await db.select().from(clubCourts).where(eq(clubCourts.clubSlug, "warehaus"))).toEqual([]);
    expect(await db.select().from(clubSlots).where(eq(clubSlots.clubSlug, "warehaus"))).toEqual([]);
    expect(isClubListed(repaired)).toBe(true);
  });

  it("repairs nothing when the row is in any other state", async () => {
    await claimAsErik();
    const live = (await decideClub(db, "warehaus", true, REFUSED_AT))!;
    for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
    expect(await getClub(db, "warehaus")).toEqual(live);
    expect(await db.select().from(clubCourts).where(eq(clubCourts.clubSlug, "warehaus"))).toHaveLength(2);
  });
});
