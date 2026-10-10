import type { AvailabilityAdapter } from "./types";

export type { AvailabilityAdapter, ScrapedSlot, ScrapeFailure, ScrapeResult, ScrapeTarget } from "./types";

/**
 * The platform readers, one file each (`./<platform>.ts`), one line each here. A reader reads only what
 * an anonymous visitor's browser loads on the platform's public club page (DECIDING rule 32), and the
 * frame in `../scrape.ts` holds every reader to the same limits: a GET, no cookie, no sign-in, one
 * request a second per platform, at most eight a club, and a stop at the first 401, 403 or 429.
 *
 * Empty until the first reader lands: the job then reads nothing and costs nothing. The tests pass
 * their own adapter (`tests/scrape.test.ts`), so no test double ships in production.
 */
export const ADAPTERS: readonly AvailabilityAdapter[] = [];

/**
 * The reader for a club's booking link: the one for the platform the club row names, else the first
 * whose `matches` takes the link. Null for a link no reader knows. Pure.
 */
export function adapterFor(url: string | null | undefined, platform: string | null | undefined, adapters: readonly AvailabilityAdapter[] = ADAPTERS): AvailabilityAdapter | null {
  if (!url) return null;
  const safe = (a: AvailabilityAdapter) => {
    try {
      return a.matches(url);
    } catch {
      return false;
    }
  };
  if (platform) return adapters.find((a) => a.platform === platform && safe(a)) ?? null;
  return adapters.find(safe) ?? null;
}
