import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events } from "@/db/schema";
import { madeToShare } from "@/lib/booking/platforms";
import { bookingHref, readBooking } from "@/lib/domain/bookingPaste";
import { readCreateLink } from "@/lib/domain/createPrefill";
import { bookingLinkFor, copiedBookingLink, createEvent, duplicateEvent } from "@/lib/domain/events";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer } from "./helpers/db";

/**
 * Made-to-share invitations on the match (the owner, 11 October 2026: "Only made-to-share links"): a
 * Padel Society invitation, a Playtomic match or a MATCHi share is shown as "Join this booking on …",
 * with no query string; a PodPlay invitation, an email's link, or any other host or path never is.
 * NOW is Sunday 11 October 2026, 13:00 in Phuket; the match is Monday 12 October at 18:00 there.
 */
const NOW = new Date("2026-10-11T06:00:00Z");
freezeClock(NOW);
const MONDAY_18 = new Date("2026-10-12T11:00:00Z");
const PS = "https://thepadelsociety.app.link/AbCdEf12345";
const PT = "https://app.playtomic.io/matches/1b9e8c3a-0f5e-4d2a-9b7a-3f0c2b1d4e5f";

describe("the made-to-share allowlist", () => {
  it("takes each made-to-share form, and names its platform", () => {
    expect(madeToShare(PS)).toEqual({ url: PS, platform: expect.objectContaining({ id: "padelsociety", name: "The Padel Society" }) });
    for (const host of ["playtomic.io", "playtomic.com", "app.playtomic.io", "app.playtomic.com"]) {
      const url = `https://${host}/matches/1b9e8c3a-0f5e-4d2a-9b7a-3f0c2b1d4e5f`;
      expect(madeToShare(url)).toEqual({ url, platform: expect.objectContaining({ id: "playtomic", name: "Playtomic" }) });
    }
    expect(madeToShare("https://share.matchi.com/bookings/8f1c2d3e-aaaa-4bbb-8ccc-123456789abc")?.platform.name).toBe("MATCHi");
    // Six to twenty letters and figures for a Padel Society code, both ends.
    expect(madeToShare("https://thepadelsociety.app.link/AbC123")?.url).toBe("https://thepadelsociety.app.link/AbC123");
    expect(madeToShare("https://thepadelsociety.app.link/A1234567890123456789")?.url).toBe("https://thepadelsociety.app.link/A1234567890123456789");
    // The host's case and a trailing slash or port 443 change nothing.
    expect(madeToShare("https://ThePadelSociety.App.Link:443/AbCdEf12345/")?.url).toBe(PS);
  });

  it("removes the query string and the fragment", () => {
    expect(madeToShare(`${PS}?_p=c21%26token%3Dsecret&utm_source=wa#x`)?.url).toBe(PS);
    expect(madeToShare(`${PT}?share=1`)?.url).toBe(PT);
  });

  it("refuses everything else: PodPlay, an email's link, another path, another host, http, a user name, a port", () => {
    for (const url of [
      // A PodPlay invitation can make the booker pay; an email's link can carry a token.
      "https://kata.podplay.app/invite/8f1c2d3e?token=abc",
      "https://podplay.app/invitations/AbCdEf12345",
      "https://click.playtomic.io/ls/click?upn=abcdef",
      "https://playtomic.io/verify-email?token=abcdef",
      // Another path on an allowed host.
      "https://playtomic.com/clubs/rawai-padel",
      "https://playtomic.io/matches/not-a-uuid",
      "https://playtomic.io/matches/1b9e8c3a-0f5e-4d2a-9b7a-3f0c2b1d4e5f/pay",
      "https://thepadelsociety.app.link/s/AbCdEf12345",
      "https://thepadelsociety.app.link/AbC12",
      "https://thepadelsociety.app.link/A12345678901234567890",
      "https://thepadelsociety.app.link/AbCd-Ef1234",
      "https://thepadelsociety.app.link/AbCd%2FEf1234",
      "https://thepadelsociety.app.link/",
      "https://share.matchi.com/match/8f1c2d3e-aaaa",
      "https://share.matchi.com/bookings/by-id/12345678",
      "https://www.matchi.se/facilities/kata",
      // Another host: a look-alike, a subdomain of the code host, the app's site.
      "https://thepadelsociety.app.link.evil.example/AbCdEf12345",
      "https://evil.thepadelsociety.app.link/AbCdEf12345",
      "https://thepadelsociety.co/AbCdEf12345",
      "https://app.link/AbCdEf12345",
      // Not https, a user name, another port, not a link at all.
      "http://thepadelsociety.app.link/AbCdEf12345",
      "https://user@thepadelsociety.app.link/AbCdEf12345",
      "https://thepadelsociety.app.link:8443/AbCdEf12345",
      "javascript:alert(1)",
      "thepadelsociety.app.link/AbCdEf12345",
      "",
      `${PS}${"x".repeat(500)}`,
    ])
      expect([url, madeToShare(url)]).toEqual([url, null]);
    expect(madeToShare(null)).toBeNull();
    expect(madeToShare(42)).toBeNull();
  });
});

describe("a pasted invitation, from the paste to the match", () => {
  const clubs = [{ slug: "warehaus", name: "WAREHAUS.club", tz: "Asia/Bangkok" }];
  const read = (text: string) => readBooking({ text, clubs, now: NOW, tz: "Asia/Bangkok" });

  it("the paste reads the invitation and the form's address carries it, cleaned", () => {
    const r = read(`Warehaus Mon 12 Oct 18:00-19:30 court 3 with Danny, Alberto https://kata.podplay.app/invite/x ${PS}?_p=abc`);
    expect(r.invite).toBe(PS);
    const href = new URL(bookingHref(r), "https://kicksma.sh");
    expect(href.searchParams.get("invite")).toBe(PS);
    // A paste with a link that is not made to share carries none.
    expect(new URL(bookingHref(read("Warehaus Mon 12 Oct 18:00 https://kata.podplay.app/invite/x")), "https://kicksma.sh").searchParams.has("invite")).toBe(false);
  });

  it("the form's reader takes an invitation only from a paste and only when it is made to share", () => {
    expect(readCreateLink({ src: "paste", invite: `${PS}?token=x` }).invite).toEqual({ url: PS, platform: "The Padel Society" });
    expect(readCreateLink({ src: "paste", invite: "https://kata.podplay.app/invite/x" }).invite).toBeNull();
    expect(readCreateLink({ invite: PS }).invite).toBeNull();
  });
});

describe("the create keeps an invitation only after the same check", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const make = async (o: { bookingUrl?: string; invite?: string }) => {
    const cath = await makePlayer(db, "Cath");
    const ev = await createEvent(db, { creatorPlayerId: cath.id, type: "match", startsAt: MONDAY_18, durationMinutes: 90, tz: "Asia/Bangkok", venueName: "WAREHAUS.club", whenFull: "waitlist", ...o });
    const [row] = await db.select().from(events).where(eq(events.id, ev.id));
    return { cath, row };
  };

  it("stores a made-to-share invitation as the booking link, with its query string removed", async () => {
    const { row } = await make({ invite: `${PS}?_p=c21&token=secret` });
    expect(row.bookingUrl).toBe(PS);
  });

  it("refuses a crafted parameter: a PodPlay invitation, an email's link, a look-alike host", async () => {
    for (const invite of ["https://kata.podplay.app/invite/x?token=abc", "https://playtomic.io/verify-email?token=abcdef", "https://thepadelsociety.app.link.evil.example/AbCdEf12345", "javascript:alert(1)"]) {
      const { row } = await make({ invite });
      expect([invite, row.bookingUrl]).toEqual([invite, null]);
    }
  });

  it("a booking link the organiser typed wins over the invitation", async () => {
    expect(bookingLinkFor({ bookingUrl: "https://playtomic.com/clubs/rawai-padel", invite: PS })).toBe("https://playtomic.com/clubs/rawai-padel");
    const { row } = await make({ bookingUrl: "https://example.com/my-booking", invite: PS });
    expect(row.bookingUrl).toBe("https://example.com/my-booking");
  });

  it("'Play again' drops last week's invitation and keeps any other link", async () => {
    expect(copiedBookingLink(PS)).toBeNull();
    expect(copiedBookingLink("https://playtomic.com/clubs/rawai-padel")).toBe("https://playtomic.com/clubs/rawai-padel");
    const { cath, row } = await make({ invite: PS });
    const next = await duplicateEvent(db, { sourceEventId: row.id, creatorPlayerId: cath.id, now: NOW });
    expect(next.bookingUrl).toBeNull();
    const typed = await make({ bookingUrl: "https://example.com/my-booking" });
    expect((await duplicateEvent(db, { sourceEventId: typed.row.id, creatorPlayerId: typed.cath.id, now: NOW })).bookingUrl).toBe("https://example.com/my-booking");
  });
});
