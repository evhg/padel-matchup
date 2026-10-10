import type { Club } from "@/db/schema";
import { utcToZonedParts } from "@/lib/dates";
import { detectPlatform, platformById } from "./platforms";

/**
 * The booking hand-off: where "Book this court" sends a player, prepared as far as a platform's public
 * pages allow. The owner, 10 October 2026: Kicksmash prepares everything up to payment, and a player
 * books and pays in the club's own app (DECIDING rule 36). Kicksmash never signs in as a player, never
 * books and never pays.
 *
 * - "checkout": the platform's own payment step with the club, court, day, time and length chosen.
 *   No platform documents one, so nothing returns it today. It is kept for a club-granted connector
 *   (`ClubBookingConnector`, below), never for a platform's internal routes.
 * - "slot": the club's public page open on the match's day for padel. The player taps the court and
 *   the time, which every caller shows beside the button ("Sat 12 Oct, 18:00, 90 min, Court 2"), so
 *   a parameter the platform stops reading costs one tap and nothing else.
 * - "club": the club's booking page as it is (else its website).
 *
 * Pure: no network. Kicksmash's server never opens these links; the player's browser does. A chat
 * message that ever carries one turns its link preview off, because a preview is a fetch.
 */
export type Prepared = "checkout" | "slot" | "club";
export type BookingSlot = { start: Date; minutes: number; tz: string; court?: string | null };
export type PreparedBooking = { url: string; prepared: Prepared; platform: string | null };

/**
 * The day links, one switch each. Neither platform documents them; both were seen working on the
 * date given, opening the club's own public page on that day for padel. Off returns the club's page.
 *   Playtomic: https://playtomic.com/clubs/{slug}?date=YYYY-MM-DD&sport=PADEL (the club page reads
 *   "date" and "sport"; the old playtomic.io/{slug}/{tenant} links redirect to /clubs/{slug}).
 *   MATCHi: https://www.matchi.se/facilities/{slug}?date=YYYY-MM-DD&sport=5 (5 is padel in its picker).
 * Checked against the platforms' own documentation on 10 October 2026: Skedda's embed article lists
 * only embedded, viewmapid and viewtype; Playtomic's manager help only the playtomic.io/wl/{tenant}
 * embed; nothing was found for the others. So no "checkout" link exists for any of them.
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
 * then the link's host. The day is the club's local day.
 */
export function prepareBooking(club: Pick<Club, "bookingUrl" | "bookingPlatform" | "website" | "tz" | "source" | "approvedAt" | "rejectedAt">, slot: BookingSlot): PreparedBooking | null {
  if (!mayPrepareFor(club)) return null;
  const links = [parse(club.bookingUrl), parse(club.website)].filter((u): u is URL => u !== null);
  if (links.length === 0) return null;
  const platform = platformById(club.bookingPlatform) ?? detectPlatform(club.bookingUrl) ?? detectPlatform(club.website);
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
