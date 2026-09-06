import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { clubToPublic } from "@/lib/api/serialize";
import { freeSlotsFromBookings, localDay, parseDuration, parseFreeJson, parseIcs, refreshAllAvailability, refreshClubAvailability } from "@/lib/booking/availability";
import { cleanUrl, detectPlatform } from "@/lib/booking/platforms";
import { CLUB_LIMITS, claimClub, clubStatus, decideClub, freeCourtHours, getClub, getClubByToken, guessCity, listClubsClaimedBy, listLiveClubs, updateClub } from "@/lib/domain/clubs";
import { handleTelegramUpdate } from "@/lib/telegram/bot";
import { askOwnerAboutClub } from "@/lib/telegram/clubs";
import { createTestDb, makePlayer } from "./helpers/db";

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:1",
  "DTSTART;TZID=Asia/Bangkok:20260906T080000",
  "DTEND;TZID=Asia/Bangkok:20260906T090000",
  "SUMMARY:Court 1 - Somchai\\, booked",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:2",
  "DTSTART:20260906T010000Z",
  "DTEND:20260906T020000Z",
  "SUMMARY:Court 2 with a long",
  "  folded summary",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:3",
  "DTSTART:20260906T083000",
  "DURATION:PT1H",
  "SUMMARY:Court 3 floating",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:4",
  "DTSTART;VALUE=DATE:20260906",
  "DTEND;VALUE=DATE:20260907",
  "SUMMARY:All day (skipped)",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:5",
  "DTSTART:20260906T090000Z",
  "DTEND:20260906T100000Z",
  "STATUS:CANCELLED",
  "SUMMARY:Cancelled",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("booking platforms and links", () => {
  it("recognises platforms by host and leaves a club's own page alone", () => {
    expect(detectPlatform("https://playtomic.io/tenant/abc")?.id).toBe("playtomic");
    expect(detectPlatform("https://app.playtomic.io/clubs/x")?.id).toBe("playtomic");
    expect(detectPlatform("https://www.matchi.se/facilities/padelclub")?.name).toBe("MATCHi");
    expect(detectPlatform("https://rawaipadel.com/book")).toBeNull();
    expect(detectPlatform("not a url")).toBeNull();
    expect(detectPlatform(null)).toBeNull();
  });
  it("cleans links: adds https, keeps http(s) only, bounds length", () => {
    expect(cleanUrl(" playtomic.io/x ")).toBe("https://playtomic.io/x");
    expect(cleanUrl("javascript:alert(1)")).toBeNull();
    expect(cleanUrl("")).toBeNull();
    expect(cleanUrl(42)).toBeNull();
    expect(cleanUrl(`https://a.b/${"x".repeat(900)}`)!.length).toBe(500);
  });
});

describe("availability feeds", () => {
  const tz = "Asia/Bangkok";
  it("parses calendars: TZID, UTC, floating in the club zone, durations, folded lines; skips all-day and cancelled", () => {
    const b = parseIcs(ICS, tz);
    expect(b).toHaveLength(3);
    expect(b[0].start.toISOString()).toBe("2026-09-06T01:00:00.000Z");
    expect(b[0].summary).toBe("Court 1 - Somchai, booked");
    expect(b[1].summary).toBe("Court 2 with a long folded summary");
    expect(b[2].start.toISOString()).toBe("2026-09-06T01:30:00.000Z");
    expect(b[2].end.toISOString()).toBe("2026-09-06T02:30:00.000Z");
    expect(parseDuration("PT90M")).toBe(90 * 60_000);
    expect(parseDuration("P1DT2H")).toBe(26 * 3600_000);
    expect(parseDuration("nope")).toBeNull();
    expect(parseIcs("garbage", tz)).toEqual([]);
  });
  it("free courts hour by hour inside opening hours, past hours dropped", () => {
    const bookings = parseIcs(ICS, tz);
    const slots = freeSlotsFromBookings(bookings, { courts: 3, opensAt: "07:00", closesAt: "10:00", tz, day: "2026-09-06" });
    expect(slots.map((s) => [s.start, s.free])).toEqual([
      ["2026-09-06T00:00:00.000Z", 3],
      ["2026-09-06T02:00:00.000Z", 2],
    ]);
    const later = freeSlotsFromBookings(bookings, { courts: 3, opensAt: "07:00", closesAt: "10:00", tz, day: "2026-09-06", now: new Date("2026-09-06T01:30:00Z") });
    expect(later.map((s) => s.start)).toEqual(["2026-09-06T02:00:00.000Z"]);
    expect(freeSlotsFromBookings([], { courts: 2, tz, day: "2026-09-06" })).toHaveLength(16);
    expect(localDay(new Date("2026-09-06T18:30:00Z"), tz)).toBe("2026-09-07");
  });
  it("reads a JSON list of free slots for today only", () => {
    const now = new Date("2026-09-06T02:00:00Z");
    const slots = parseFreeJson({ slots: [{ start: "2026-09-06T03:00:00Z", end: "2026-09-06T04:00:00Z", free: 2 }, { start: "2026-09-06T00:00:00Z", end: "2026-09-06T01:00:00Z" }, { start: "2026-09-07T03:00:00Z" }, { start: "junk" }] }, { day: "2026-09-06", tz, now });
    expect(slots).toEqual([{ start: "2026-09-06T03:00:00.000Z", end: "2026-09-06T04:00:00.000Z", free: 2 }]);
    expect(parseFreeJson([{ start: "2026-09-06T05:00:00Z" }], { day: "2026-09-06", tz })).toHaveLength(1);
    expect(parseFreeJson("nope", { day: "2026-09-06", tz })).toEqual([]);
  });
});

describe("clubs (db)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let calls: { url: string; body: Record<string, unknown> | null }[] = [];
  let feed: { status: number; body: string } = { status: 200, body: ICS };
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => {
    await close();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_OWNER_ID;
  });
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
    process.env.TELEGRAM_OWNER_ID = "4242";
    calls = [];
    feed = { status: 200, body: ICS };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
        if (u.includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true, result: { message_id: 77, chat: { id: 4242 } } }), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(feed.body, { status: feed.status, headers: { "content-type": u.endsWith(".json") ? "application/json" : "text/calendar" } });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("claims, blocks a second claimant, approves with the founding badge, edits by token, rejects", async () => {
    const nok = await makePlayer(db, "Nok");
    const club = await claimClub(db, { name: "Rawai Padel Club", playerId: nok.id, tz: "Asia/Bangkok", bookingUrl: "https://playtomic.io/rawai", courts: "4", about: "Four panoramic courts by the sea.", website: "rawaipadel.com" });
    expect(club.slug).toBe("rawai-padel-club");
    expect(club.city).toBe("phuket");
    expect(club.bookingPlatform).toBe("playtomic");
    expect(club.courts).toBe(4);
    expect(club.website).toBe("https://rawaipadel.com/");
    expect(club.manageToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(clubStatus(club)).toBe("pending");
    expect(await listLiveClubs(db, "phuket")).toHaveLength(0);

    const other = await makePlayer(db, "Somchai");
    await expect(claimClub(db, { name: "Rawai Padel Club", playerId: other.id })).rejects.toMatchObject({ code: "forbidden", message: "already_claimed" });
    // The same person can resubmit; it stays their claim.
    const again = await claimClub(db, { name: "Rawai Padel Club", playerId: nok.id, courts: 5 });
    expect(again.manageToken).toBe(club.manageToken);
    expect(again.courts).toBe(5);

    // The owner is asked on Telegram, then taps Approve.
    expect(await askOwnerAboutClub(db, again, nok)).toBe(true);
    expect((await getClub(db, club.slug))!.notifyMessageId).toBe(77);
    const msg = calls.find((c) => c.url.includes("sendMessage"))!;
    expect(String(msg.body?.text)).toContain("Rawai Padel Club");
    expect(JSON.stringify(msg.body?.reply_markup)).toContain(`ca:${club.manageToken}`);
    const stranger = await handleTelegramUpdate(db, { update_id: 1, callback_query: { id: "c1", from: { id: 999, first_name: "X" }, data: `ca:${club.manageToken}` } }, NO_SIDE_EFFECTS);
    expect(stranger).toBe("club:not_owner");
    expect(clubStatus((await getClub(db, club.slug))!)).toBe("pending");
    const approved = await handleTelegramUpdate(db, { update_id: 2, callback_query: { id: "c2", from: { id: 4242, first_name: "Owner" }, message: { message_id: 77, date: 0, chat: { id: 4242, type: "private" } }, data: `ca:${club.manageToken}` } }, NO_SIDE_EFFECTS);
    expect(approved).toBe("club:approved");
    const live = (await getClub(db, club.slug))!;
    expect(clubStatus(live)).toBe("live");
    expect(live.founding).toBe(true);
    expect((await listLiveClubs(db, "phuket")).map((c) => c.slug)).toEqual(["rawai-padel-club"]);
    expect(await listClubsClaimedBy(db, nok.id)).toHaveLength(1);

    // Edits through the manage link; a new booking link re-detects the platform; a feed change clears the cache.
    expect(await updateClub(db, "nope", { courts: 1 })).toBeNull();
    const edited = (await updateClub(db, club.manageToken, { bookingUrl: "https://www.matchi.se/facilities/rawai", opensAt: "7:00", closesAt: "23:00", availabilityUrl: "https://rawaipadel.com/bookings.ics", availabilityKind: "ics_bookings" }))!;
    expect(edited.bookingPlatform).toBe("matchi");
    expect(edited.opensAt).toBe("07:00");
    expect(edited.availability).toBeNull();

    // Public shape: no token, booking platform named, free courts null until a feed was read.
    const pub = clubToPublic(edited, "https://kicksma.sh");
    expect(JSON.stringify(pub)).not.toContain(club.manageToken);
    expect(pub.booking).toEqual({ url: "https://www.matchi.se/facilities/rawai", platform: "matchi", platformName: "MATCHi" });
    expect(pub.freeCourts).toBeNull();
    expect(pub.founding).toBe(true);

    // Reject: the page falls back to the plain board; someone else may claim afterwards.
    const rejected = (await decideClub(db, club.slug, false))!;
    expect(clubStatus(rejected)).toBe("rejected");
    expect(rejected.founding).toBe(false);
    const reclaim = await claimClub(db, { name: "Rawai Padel Club", playerId: other.id });
    expect(reclaim.claimedBy).toBe(other.id);
    expect(clubStatus(reclaim)).toBe("pending");
  });

  it("reads a club's feed into today's free courts, keeps errors honest, refreshes only live stale clubs", async () => {
    const p = await makePlayer(db, "Lin");
    const now = new Date("2026-09-06T00:30:00Z"); // 07:30 in Bangkok
    let club = await claimClub(db, { name: "Chalong Padel", playerId: p.id, tz: "Asia/Bangkok", courts: 3, opensAt: "07:00", closesAt: "10:00", availabilityUrl: "https://chalong.example/bookings.ics", availabilityKind: "ics_bookings" });
    // Pending clubs are not refreshed by the hourly job.
    expect(await refreshAllAvailability(db, now)).toEqual({ refreshed: 0, errors: 0 });
    club = (await decideClub(db, club.slug, true))!;
    expect(await refreshAllAvailability(db, now)).toEqual({ refreshed: 1, errors: 0 });
    club = (await getClub(db, club.slug))!;
    expect(club.availability?.day).toBe("2026-09-06");
    expect(club.availability?.slots.map((s) => [s.start, s.free])).toEqual([
      ["2026-09-06T00:00:00.000Z", 3],
      ["2026-09-06T02:00:00.000Z", 2],
    ]);
    expect(freeCourtHours(club, now)).toBe(5);
    expect(freeCourtHours(club, new Date("2026-09-06T01:30:00Z"))).toBe(2);
    // Fresh cache: nothing to do. Stale cache: read again.
    expect(await refreshAllAvailability(db, now)).toEqual({ refreshed: 0, errors: 0 });
    expect(await refreshAllAvailability(db, new Date(now.getTime() + 3600_000))).toEqual({ refreshed: 1, errors: 0 });

    feed = { status: 500, body: "" };
    const bad = (await refreshClubAvailability(db, club, now))!;
    expect(bad.error).toBe("HTTP 500");
    expect(freeCourtHours({ availability: bad })).toBeNull();
    expect(clubToPublic({ ...club, availability: bad }, "https://kicksma.sh").freeCourts).toBeNull();

    feed = { status: 200, body: "<html>not a calendar</html>" };
    expect((await refreshClubAvailability(db, club, now))!.error).toBe("not a calendar feed");

    const json = (await updateClub(db, club.manageToken, { availabilityUrl: "https://chalong.example/free.json", availabilityKind: "json_free" }))!;
    feed = { status: 200, body: JSON.stringify({ slots: [{ start: "2026-09-06T03:00:00Z", end: "2026-09-06T04:00:00Z", free: 2 }] }) };
    const fromJson = (await refreshClubAvailability(db, json, now))!;
    expect(fromJson.slots).toEqual([{ start: "2026-09-06T03:00:00.000Z", end: "2026-09-06T04:00:00.000Z", free: 2 }]);
    expect(fromJson.source).toBe("json_free");
  });

  it("hands out at most ten founding badges per city and guesses cities from zone and slug", async () => {
    expect(guessCity("patong-padel", "Asia/Bangkok")).toBe("phuket");
    expect(guessCity("some-club", "Asia/Bangkok")).toBeNull();
    expect(guessCity("any-club", "Asia/Singapore")).toBe("singapore");
    const p = await makePlayer(db, "Ong");
    const slugs: string[] = [];
    for (let i = 0; i < CLUB_LIMITS.foundingPerCity + 1; i++) {
      const c = await claimClub(db, { name: `Singapore Padel ${i}`, playerId: p.id, tz: "Asia/Singapore" });
      slugs.push(c.slug);
      await decideClub(db, c.slug, true);
    }
    const rows = await Promise.all(slugs.map((s) => getClub(db, s)));
    expect(rows.filter((r) => r!.founding)).toHaveLength(CLUB_LIMITS.foundingPerCity);
    expect(rows.at(-1)!.founding).toBe(false);
    const list = await listLiveClubs(db, "singapore");
    expect(list[0].founding).toBe(true);
    expect(list.at(-1)!.founding).toBe(false);
    expect(await getClubByToken(db, rows[0]!.manageToken)).toMatchObject({ slug: slugs[0] });
    const [row] = await db.select().from(clubs).where(eq(clubs.slug, slugs[0]));
    expect(row.city).toBe("singapore");
  });
});
