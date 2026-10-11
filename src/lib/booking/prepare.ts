import type { Club, ClubAvailability } from "@/db/schema";
import { isValidTimeZone, utcToZonedParts } from "@/lib/dates";
import { playtomicBookUrl } from "./adapters/playtomic";
import { linkKey, readLink } from "./linkKey";
import { offeredCourts, pickCourt } from "./offers";
import { detectPlatform, platformById } from "./platforms";

/**
 * The booking hand-off: where "Book this court" sends a player. The owner, 10 October 2026:
 * "kicksmash can do everything except the actual payment; this means create the booking and then hand
 * off to the human to complete the payment" (DECIDING rule 36). This file does less: it creates no
 * booking. It opens a page, and the player signs in, books and pays there. Kicksmash never signs in as
 * a player, never books and never pays.
 *
 * - "checkout": the platform's own payment step with the court, the time and the length filled in.
 *   The owner decided on 11 October 2026, "Playtomic checkout, filled": ""Book this court" opens
 *   Playtomic's own checkout with the court, the time and the length filled, and the player only pays.
 *   ... the link is undocumented and can change, and a rule forbids it today. The player's browser opens
 *   it, not our server." So the limit a session wrote on 10 October 2026, "never for a platform's
 *   internal routes", is gone. The link is the one Playtomic's own club page opens for "Continue"
 *   (`playtomicBookUrl`), given only when Playtomic listed exactly the match's start and length on a
 *   court in a fresh read (`checkoutFor`), and only while Playtomic's page still builds that link
 *   (`builderCheck` in `./scrape.ts`); else the day page. A player who is not signed in to Playtomic
 *   meets its sign-in first. The kind is also kept for a club-granted connector (`ClubBookingConnector`).
 * - "slot": the club's public page open on the match's day for padel. The player taps the court and
 *   the time, which every caller shows beside the button ("Sat 12 Oct, 18:00, 90 min, Court 2"), so
 *   a parameter the platform stops reading costs one tap and nothing else.
 * - "club": the club's booking page as it is (else its website).
 *
 * Pure: no network. Kicksmash's server never opens a "Book this court" link, the checkout included,
 * and never starts or completes a booking; the player's browser opens the link. A chat message that ever
 * carries one turns its link preview off, because a preview is a fetch. The server opens a booking link
 * in one case only: a person pasted it, and it is read once, as a chat app's preview robot reads it
 * (`readLinkPreview` in `./unfurl.ts`, DECIDING rule 35).
 */
export type Prepared = "checkout" | "slot" | "club";
export type BookingSlot = { start: Date; minutes: number; tz: string; court?: string | null };
/** `court`: for a checkout, the court the link books (the match's own when listed, else another), so the page names it. */
export type PreparedBooking = { url: string; prepared: Prepared; platform: string | null; court?: string | null };

/**
 * The checkout switches, one a platform, beside the code's own "observed" date: off gives the day page.
 * The row `checkout_off_<platform>` (or `checkout_off_all`) through `POST /api/admin/metrics` turns one
 * off with no deploy: the reader then keeps no offers, and within one read of each club (15 minutes)
 * no match page has one to fill a checkout with. Playtomic's link was read from its club page's own
 * script on 11 October 2026 (`/_next/static/chunks/7105-b679921c03870a3f.js`).
 */
export const CHECKOUT: Record<string, { on: boolean; observed: string; builder: string } | undefined> = {
  /** `builder`: the club page's script that built the link when it was observed, until a read finds another (`builderCheck`). */
  playtomic: { on: true, observed: "2026-10-11", builder: "/_next/static/chunks/7105-b679921c03870a3f.js" },
};
export const checkoutOn = (platform: string): boolean => Boolean(CHECKOUT[platform]?.on);
/** A listed start is trusted this long after the read that saw it: today's read is 15 minutes old at most, a later day's about 88. */
export const CHECKOUT_FRESH_MS = 90 * 60_000;
const SKEW_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The part of the club's cache a checkout needs: the header and the offers, never the slots. */
export type CheckoutCache = Pick<ClubAvailability, "fetchedAt" | "day" | "tz" | "source" | "error"> & Partial<Pick<ClubAvailability, "days" | "fullAt" | "ref" | "linkKey" | "offers">>;

/**
 * Playtomic's checkout for this match, or null. Only when all of these hold: the switch is on; the cache
 * is a clean read of Playtomic from the link the club has now (`linkKey`), with the club's id (`ref`);
 * the match is still to come; the read of its day is `CHECKOUT_FRESH_MS` old or less (today's read for
 * today, the last full read for a later day); and a court was listed at exactly the match's start with
 * exactly its length. The match's own court first, else another listed court, named beside the button.
 * Pure.
 */
export function checkoutFor(club: Pick<Club, "bookingUrl" | "website">, cache: CheckoutCache | null | undefined, slot: BookingSlot, now: Date): { url: string; court: string | null } | null {
  if (!checkoutOn("playtomic") || !cache || cache.error || cache.source !== "scrape:playtomic" || !cache.offers) return null;
  const link = readLink(club);
  if (!link || cache.linkKey !== linkKey(link) || !cache.ref || !UUID.test(cache.ref) || !isValidTimeZone(cache.tz)) return null;
  const t = slot.start.getTime();
  if (!Number.isFinite(t) || t <= now.getTime()) return null;
  const day = utcToZonedParts(slot.start, cache.tz).date;
  const readAt = Date.parse((day === cache.day ? cache.fetchedAt : Array.isArray(cache.days) && cache.days.includes(day) ? cache.fullAt : null) ?? "");
  if (!Number.isFinite(readAt) || now.getTime() - readAt > CHECKOUT_FRESH_MS || readAt - now.getTime() > SKEW_MS) return null;
  const court = pickCourt(
    offeredCourts(cache.offers, cache.tz, slot.start, slot.minutes).filter((c) => UUID.test(c.id)),
    slot.court,
  );
  return court ? { url: playtomicBookUrl(cache.ref.toLowerCase(), court.id.toLowerCase(), slot.start, slot.minutes), court: court.name } : null;
}

/**
 * The day links, one switch each. Neither platform documents them; both were seen working on the
 * date given, opening the club's own public page on that day for padel. Off returns the club's page.
 *   Playtomic: https://playtomic.com/clubs/{slug}?date=YYYY-MM-DD&sport=PADEL (the club page reads
 *   "date" and "sport"; the old playtomic.io/{slug}/{tenant} links redirect to /clubs/{slug}).
 *   MATCHi: https://www.matchi.se/facilities/{slug}?date=YYYY-MM-DD&sport=5 (5 is padel in its picker).
 * Checked against the platforms' own documentation on 10 October 2026: Skedda's embed article lists
 * only embedded, viewmapid and viewtype; Playtomic's manager help only the playtomic.io/wl/{tenant}
 * embed; nothing was found for the others. The only checkout link is Playtomic's own (`CHECKOUT`).
 */
export const DEEP_LINK = {
  playtomic: { on: true, observed: "2026-10-10" },
  matchi: { on: true, observed: "2026-10-10" },
} as const;

/** A slug the day links may carry: anything else falls back to the club's page. */
const SLUG = /^[a-z0-9-]{1,80}$/;

/** https only: a player is never handed to a plain-http page on the way to paying. */
const parse = (u: string | null | undefined): URL | null => {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

/** The host is the platform's own or a subdomain of it, as `detectPlatform` reads it: evilplaytomic.com is not Playtomic. */
const onHost = (u: URL, host: string) => {
  const h = u.hostname.toLowerCase();
  return h === host || h.endsWith(`.${host}`);
};

/** playtomic.com/clubs/{slug}, or the old playtomic.io/{slug}/{tenant}. */
function playtomicSlug(u: URL): string | null {
  const parts = u.pathname.split("/").filter(Boolean);
  const slug = onHost(u, "playtomic.com") && parts[0] === "clubs" ? parts[1] : onHost(u, "playtomic.io") && parts.length === 2 && parts[0] !== "wl" ? parts[0] : null;
  return slug && SLUG.test(slug) ? slug : null;
}

/** matchi.se/facilities/{slug}. */
function matchiSlug(u: URL): string | null {
  const parts = u.pathname.split("/").filter(Boolean);
  const slug = onHost(u, "matchi.se") && parts[0] === "facilities" ? parts[1] : null;
  return slug && SLUG.test(slug) ? slug : null;
}

/**
 * May this club's links become "Book this court"? Only a row somebody vetted: a club that runs its
 * page (claimed and approved) or the directory's own row, read from public sources. A club any player
 * listed carries whatever website that player typed, and a claim still waiting or a refused row
 * carries what its claimant typed: a link on a club's page is the thing the owner's tap guards.
 */
export const mayPrepareFor = (c: Pick<Club, "source" | "approvedAt" | "rejectedAt">): boolean => !c.rejectedAt && (Boolean(c.approvedAt) || c.source === "directory");

/**
 * Where "Book this court" goes for this club and this match, and how far it is prepared; null when the
 * club has no https link, or its links were never vetted (`mayPrepareFor`). The platform is the club's
 * own word first (`booking_platform`, which a custom domain needs: book.pop-padel.com is Playbypoint),
 * then the link's host. The day is the club's local day. With the club's cache (`o.cache`, the match
 * page's one read) and the clock, a Playtomic club may give its checkout (`checkoutFor`); every other
 * caller (the chat's card, which nobody edits when a court is booked since) gets the day page.
 */
export function prepareBooking(
  club: Pick<Club, "bookingUrl" | "bookingPlatform" | "website" | "tz" | "source" | "approvedAt" | "rejectedAt">,
  slot: BookingSlot,
  o: { cache?: CheckoutCache | null; now?: Date } = {},
): PreparedBooking | null {
  if (!mayPrepareFor(club)) return null;
  const links = [parse(club.bookingUrl), parse(club.website)].filter((u): u is URL => u !== null);
  if (links.length === 0) return null;
  const platform = platformById(club.bookingPlatform) ?? detectPlatform(club.bookingUrl) ?? detectPlatform(club.website);
  if (platform?.id === "playtomic" && o.cache && o.now) {
    const checkout = checkoutFor(club, o.cache, slot, o.now);
    if (checkout) return { url: checkout.url, prepared: "checkout", platform: platform.id, court: checkout.court };
  }
  const day = utcToZonedParts(slot.start, club.tz || slot.tz).date;
  if (platform?.id === "playtomic" && DEEP_LINK.playtomic.on) {
    const slug = links.map(playtomicSlug).find(Boolean);
    if (slug) return { url: `https://playtomic.com/clubs/${slug}?date=${day}&sport=PADEL`, prepared: "slot", platform: platform.id };
  }
  if (platform?.id === "matchi" && DEEP_LINK.matchi.on) {
    const slug = links.map(matchiSlug).find(Boolean);
    if (slug) return { url: `https://www.matchi.se/facilities/${slug}?date=${day}&sport=5`, prepared: "slot", platform: platform.id };
  }
  return { url: links[0].toString(), prepared: "club", platform: platform?.id ?? null };
}

/**
 * Later, and only with a platform's agreement and a club's grant: a booking created for the club that
 * waits for the player's payment, the player paying on the platform's or the club's own page. A type
 * only. Nothing implements it, nothing stores a credential for it, and nothing calls it: storing a
 * club's grant needs a table, which is a migration and the owner's decision, and no platform in our
 * cities offers such access today (the research of 10 October 2026). It is never a player's login.
 */
export interface ClubBookingConnector {
  platform: string;
  createPendingBooking(i: { courtRef: string; start: Date; minutes: number; bookerName: string; idempotencyKey: string }): Promise<{ ok: true; externalId: string; payUrl: string; holdUntil: Date | null } | { ok: false; reason: "slot_taken" | "not_allowed" | "unavailable" | "error" }>;
  status(externalId: string): Promise<"pending" | "paid" | "cancelled" | "expired">;
  cancelPendingBooking(externalId: string): Promise<void>;
}
