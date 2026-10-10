export type ScrapedSlot = { start: string; end: string; court: string | null; free: boolean; priceText: string | null; bookUrl: string | null };
/**
 * `tz` is the club row's zone as it is, null or not valid included: the frame never puts "UTC" in for a
 * zone nobody gave. A reader that finds the club's zone on the platform's page may use it; one that
 * cannot know the zone returns the error "no time zone" and never guesses.
 */
export type ScrapeTarget = { clubSlug: string; platform: string; bookingUrl: string; tz: string | null; days: number };
export type ScrapeFailure = "blocked" | "not_found" | "changed" | "timeout" | "error" | "not_public";
/** `tz` on a clean read: the zone the reader read the club's days in. The frame keeps the cache in it. */
export type ScrapeResult = { ok: true; slots: ScrapedSlot[]; requests: number; tz?: string } | { ok: false; status: number | null; reason: ScrapeFailure; requests: number; detail: string | null };
export interface AvailabilityAdapter {
  /** Matches PLATFORMS[].id in src/lib/booking/platforms.ts. */
  platform: string;
  /** Pure: does this booking link belong to this adapter? */
  matches(url: string): boolean;
  /** At most 8 requests per call; every time in UTC ISO 8601; courts free AND booked when the page shows both (free: false for booked). */
  scrape(target: ScrapeTarget, fetchImpl: typeof fetch, now: Date): Promise<ScrapeResult>;
}
