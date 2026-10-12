import type { Club } from "@/db/schema";

/**
 * The link a read of free court times came from, and its short key: a leaf, so the frame of the reads
 * (`scrape.ts`) and the booking hand-off (`prepare.ts`) agree on both without importing each other.
 */

/** FNV-1a, 32 bits. Pure. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The link a read came from, as the cache keeps it (`linkKey`): eight hex digits, never the link. Pure. */
export const linkKey = (link: string): string => fnv1a(link).toString(16).padStart(8, "0");

/**
 * The link a reader reads: the booking link, else the website. The directory lists a club with the
 * platform's page as its website and no booking link (`scripts/import-clubs.mjs`), and those are most
 * of the clubs on a platform (the decision of 10 October 2026 on this reader's review).
 */
export const readLink = (c: Pick<Club, "bookingUrl" | "website">): string | null => c.bookingUrl ?? c.website;
