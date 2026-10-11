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

/**
 * The links a platform makes for strangers to join a booking, as the owner chose them on 11 October
 * 2026 ("Only made-to-share links"): a Padel Society invitation (`thepadelsociety.app.link/<code>`, one
 * segment of 6 to 20 letters and figures), a Playtomic match (`/matches/<uuid>` on playtomic.io or
 * playtomic.com, and on their `app.` hosts, where Playtomic's own share links live) and a MATCHi share
 * of a booking (`share.matchi.com/bookings/<id>`: the page that says "You've been invited to join a
 * game", as the share site's own route list and its app links name it, 11 October 2026).
 * Everything else is never shown: a PodPlay invitation can make the booker pay, an email's link can
 * carry a token, and any other path or host is not known to be made for strangers.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARE_LINKS: readonly { platform: string; hosts: readonly string[]; path: (parts: readonly string[]) => boolean }[] = [
  { platform: "padelsociety", hosts: ["thepadelsociety.app.link"], path: (p) => p.length === 1 && /^[A-Za-z0-9]{6,20}$/.test(p[0]) },
  { platform: "playtomic", hosts: ["playtomic.io", "playtomic.com", "app.playtomic.io", "app.playtomic.com"], path: (p) => p.length === 2 && p[0] === "matches" && UUID.test(p[1]) },
  { platform: "matchi", hosts: ["share.matchi.com"], path: (p) => p.length === 2 && p[0] === "bookings" && /^[A-Za-z0-9-]{6,64}$/.test(p[1]) },
];

/**
 * A made-to-share link and its platform, or null. https only, with no user name, no port but 443,
 * the host exactly as listed and the path in its one shape; the query string and the fragment are
 * removed, so a tracking tag or a token never travels on. Pure, and safe in a browser.
 */
export function madeToShare(raw: unknown): { url: string; platform: Platform } | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port !== "" && u.port !== "443")) return null;
  const host = u.hostname.toLowerCase();
  const kind = SHARE_LINKS.find((k) => k.hosts.includes(host));
  if (!kind) return null;
  const parts = u.pathname.replace(/\/$/, "").split("/").slice(1);
  if (!kind.path(parts)) return null;
  const platform = platformById(kind.platform);
  return platform ? { url: `https://${host}/${parts.join("/")}`, platform } : null;
}

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
