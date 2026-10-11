/**
 * Booking platforms we recognise from a link. Kicksmash is the organising
 * layer between the chat and the booking system, never a booking system:
 * recognising the platform lets a match or a club page say "Book on
 * Playtomic" instead of "booking link", and lets a contributor add an
 * availability adapter for a platform in one file (see availability.ts).
 *
 * A host is only a hint: a club on its own domain (book.pop-padel.com is Playbypoint, krosspadel.com
 * is Book & Go) carries `booking_platform`, which wins over the host wherever both exist
 * (`prepareBooking`, `BookingButton`). The research of 10 October 2026 added Book & Go, PodPlay and
 * The Padel Society, and dropped playven.com (gone) and padelmates.com (parked). On 11 October 2026 a
 * pasted booking (`src/lib/domain/bookingPaste.ts`) added Setpoint, The Padel Society's share links
 * (thepadelsociety.app.link, a Branch link) and matchi.com. A platform here with no reader in
 * `adapters/` is never read by the 15-minute job: its lanes come from `ADAPTERS`, not from this list.
 * A host goes in only when the platform is shown to hold it: the read of a pasted link
 * (`src/lib/booking/unfurl.ts`) connects to any of these hosts and their subdomains, so whoever holds a
 * host's zone chooses where that read goes. thepadelsociety.app is left out for that reason: only the
 * app's Android package id (com.thepadelsociety.app) names it, and its name servers did not answer.
 */
export type Platform = { id: string; name: string; hosts: readonly string[] };

export const PLATFORMS: readonly Platform[] = [
  { id: "playtomic", name: "Playtomic", hosts: ["playtomic.io", "playtomic.com"] },
  { id: "matchi", name: "MATCHi", hosts: ["matchi.se", "matchi.com"] },
  { id: "playbypoint", name: "Playbypoint", hosts: ["playbypoint.com"] },
  { id: "padelmates", name: "Padel Mates", hosts: ["padelmates.se"] },
  { id: "courtsite", name: "Courtsite", hosts: ["courtsite.my", "courtsite.com"] },
  { id: "skedda", name: "Skedda", hosts: ["skedda.com"] },
  { id: "bookandgo", name: "Book & Go", hosts: ["bookandgo.app"] },
  { id: "podplay", name: "PodPlay", hosts: ["podplay.app", "podify.club"] },
  { id: "padelsociety", name: "The Padel Society", hosts: ["thepadelsociety.co", "thepadelsociety.app.link"] },
  { id: "setpoint", name: "Setpoint", hosts: ["getsetpoint.io"] },
];

/** The platform behind a booking link, by host (subdomains included), or null for a club's own site. */
export function detectPlatform(url: string | null | undefined): Platform | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return PLATFORMS.find((p) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ?? null;
}

export const platformById = (id: string | null | undefined): Platform | null => (id ? (PLATFORMS.find((p) => p.id === id) ?? null) : null);

/** http(s) links only, trimmed, bounded; anything else becomes null. ("Book this court" takes https only: `prepareBooking`.) */
export function cleanUrl(u: unknown, max = 500): string | null {
  if (typeof u !== "string") return null;
  const s = u.trim();
  if (!s) return null;
  try {
    const url = new URL(s.includes("://") ? s : `https://${s}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString().slice(0, max);
  } catch {
    return null;
  }
}
