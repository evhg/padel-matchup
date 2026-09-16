import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { clubs } from "@/db/schema";
import { claimClub, clubStatus, listClubsForPicking, listLiveClubs } from "@/lib/domain/clubs";
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
    // "blue-tree". A tidier "warehaus-club" here would be a second page for the same club, with all
    // of the history on the other one. The name is what the club calls itself; the slug is its address.
    const bySlug = new Map(file.clubs.map((c) => [c.slug, c]));
    expect(bySlug.get("warehaus")?.name).toBe("WAREHAUS.club");
    expect(bySlug.get("blue-tree")?.name).toBe("Padel Phuket @ Blue Tree");
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
