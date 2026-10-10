import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectPlatform } from "@/lib/booking/platforms";
import { DEEP_LINK, prepareBooking } from "@/lib/booking/prepare";

/**
 * Where "Book this court" sends a player, prepared as far as a platform's public pages allow: the
 * club's page open on the match's day ("slot") for Playtomic and MATCHi, the club's own booking page
 * ("club") for everyone else. Never a platform's internal route, and no "checkout" today: no platform
 * documents one. Pure, so every case is a table row.
 *
 * The match is on Monday 12 October 2026 at 18:00 in Bangkok (11:00 UTC), 90 minutes, court 2.
 */
const SLOT = { start: new Date("2026-10-12T11:00:00Z"), minutes: 90, tz: "Asia/Bangkok", court: "2" };
const club = (o: { bookingUrl?: string | null; bookingPlatform?: string | null; website?: string | null; tz?: string | null }) => ({ bookingUrl: null, bookingPlatform: null, website: null, tz: "Asia/Bangkok", ...o });

describe("prepareBooking", () => {
  it.each([
    ["Playtomic: the club's page on the day, for padel", club({ bookingUrl: "https://playtomic.com/clubs/sensei-padel-phuket" }), { url: "https://playtomic.com/clubs/sensei-padel-phuket?date=2026-10-12&sport=PADEL", prepared: "slot", platform: "playtomic" }],
    ["Playtomic's old playtomic.io/{slug}/{tenant} link finds the same page", club({ bookingUrl: "https://playtomic.io/baan-padel/0f8a2b3c-1111-2222-3333-444455556666" }), { url: "https://playtomic.com/clubs/baan-padel?date=2026-10-12&sport=PADEL", prepared: "slot", platform: "playtomic" }],
    ["a Playtomic page given as the website only", club({ website: "https://playtomic.com/clubs/padel-cnx" }), { url: "https://playtomic.com/clubs/padel-cnx?date=2026-10-12&sport=PADEL", prepared: "slot", platform: "playtomic" }],
    ["Playtomic's embed link (wl) is no club page: the link as it is", club({ bookingUrl: "https://playtomic.io/wl/0f8a2b3c" }), { url: "https://playtomic.io/wl/0f8a2b3c", prepared: "club", platform: "playtomic" }],
    ["a slug outside the strict shape: the link as it is", club({ bookingUrl: "https://playtomic.com/clubs/Bad_Slug" }), { url: "https://playtomic.com/clubs/Bad_Slug", prepared: "club", platform: "playtomic" }],
    ["MATCHi: the facility on the day, sport 5 (padel)", club({ bookingUrl: "https://www.matchi.se/facilities/bluetree" }), { url: "https://www.matchi.se/facilities/bluetree?date=2026-10-12&sport=5", prepared: "slot", platform: "matchi" }],
    ["a club's own word beats its host: Pop Padel's domain is Playbypoint", club({ bookingUrl: "https://book.pop-padel.com/", bookingPlatform: "playbypoint" }), { url: "https://book.pop-padel.com/", prepared: "club", platform: "playbypoint" }],
    ["a club on Playtomic whose link is its own site: the site", club({ website: "https://www.mandala.club/mandalaracquetclub", bookingPlatform: "playtomic" }), { url: "https://www.mandala.club/mandalaracquetclub", prepared: "club", platform: "playtomic" }],
    ["Book & Go and PodPlay: the club's booking page", club({ bookingUrl: "https://ricochet.podify.club/book/laguna-venue" }), { url: "https://ricochet.podify.club/book/laguna-venue", prepared: "club", platform: "podplay" }],
    ["no platform at all: the club's own booking page", club({ bookingUrl: "https://nodramapadel.com/" }), { url: "https://nodramapadel.com/", prepared: "club", platform: null }],
  ] as const)("%s", (_why, c, want) => {
    expect(prepareBooking(c, SLOT)).toEqual(want);
  });

  it("takes the club's own day: 01:30 on Tuesday in Bangkok is Monday in UTC", () => {
    const late = { ...SLOT, start: new Date("2026-10-12T18:30:00Z") };
    expect(prepareBooking(club({ bookingUrl: "https://playtomic.com/clubs/baan-padel" }), late)?.url).toBe("https://playtomic.com/clubs/baan-padel?date=2026-10-13&sport=PADEL");
    // A club with no zone of its own takes the match's.
    expect(prepareBooking(club({ bookingUrl: "https://playtomic.com/clubs/baan-padel", tz: null }), late)?.url).toContain("date=2026-10-13");
  });

  it("gives nothing for a club with no link, and refuses a link that is not http(s)", () => {
    expect(prepareBooking(club({}), SLOT)).toBeNull();
    expect(prepareBooking(club({ bookingUrl: "javascript:alert(1)" }), SLOT)).toBeNull();
  });

  it("each day link has its own switch, and off is the club's page", () => {
    const sw = DEEP_LINK.playtomic as { on: boolean };
    sw.on = false;
    try {
      expect(prepareBooking(club({ bookingUrl: "https://playtomic.com/clubs/baan-padel" }), SLOT)).toEqual({ url: "https://playtomic.com/clubs/baan-padel", prepared: "club", platform: "playtomic" });
      expect(prepareBooking(club({ bookingUrl: "https://www.matchi.se/facilities/bluetree" }), SLOT)?.prepared).toBe("slot");
    } finally {
      sw.on = true;
    }
  });

  it("over the whole directory: a day link for every Playtomic and MATCHi club page, and never a checkout", () => {
    const { clubs } = JSON.parse(readFileSync(path.resolve(process.cwd(), "data/clubs.json"), "utf8")) as { clubs: { slug: string; bookingUrl?: string | null; bookingPlatform?: string | null; website: string | null; tz: string }[] };
    const prepared = clubs.map((c) => ({ c, p: prepareBooking({ bookingUrl: c.bookingUrl ?? null, bookingPlatform: c.bookingPlatform ?? null, website: c.website, tz: c.tz }, SLOT) }));
    expect(prepared.some(({ p }) => p?.prepared === "checkout")).toBe(false);
    const days = prepared.filter(({ p }) => p?.prepared === "slot");
    expect(days.length).toBeGreaterThanOrEqual(22);
    for (const { c, p } of days) expect(["playtomic", "matchi"], c.slug).toContain(detectPlatform(p!.url)?.id);
  });
});
