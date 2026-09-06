/**
 * Booking platforms we recognise from a link. Kicksmash is the organising
 * layer between the chat and the booking system, never a booking system:
 * recognising the platform lets a match or a club page say "Book on
 * Playtomic" instead of "booking link", and lets a contributor add an
 * availability adapter for a platform in one file (see availability.ts).
 */
export type Platform = { id: string; name: string; hosts: readonly string[] };

export const PLATFORMS: readonly Platform[] = [
  { id: "playtomic", name: "Playtomic", hosts: ["playtomic.io", "playtomic.com"] },
  { id: "matchi", name: "MATCHi", hosts: ["matchi.se"] },
  { id: "playbypoint", name: "Playbypoint", hosts: ["playbypoint.com"] },
  { id: "padelmates", name: "Padel Mates", hosts: ["padelmates.se", "padelmates.com"] },
  { id: "courtsite", name: "Courtsite", hosts: ["courtsite.my", "courtsite.com"] },
  { id: "skedda", name: "Skedda", hosts: ["skedda.com"] },
  { id: "playven", name: "Playven", hosts: ["playven.com"] },
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

/** https links only, trimmed, bounded; anything else becomes null. */
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
