export type ScrapedSlot = { start: string; end: string; court: string | null; free: boolean; priceText: string | null; bookUrl: string | null };
export type ScrapeTarget = { clubSlug: string; platform: string; bookingUrl: string; tz: string; days: number };
export type ScrapeFailure = "blocked" | "not_found" | "changed" | "timeout" | "error" | "not_public";
export type ScrapeResult = { ok: true; slots: ScrapedSlot[]; requests: number } | { ok: false; status: number | null; reason: ScrapeFailure; requests: number; detail: string | null };
export interface AvailabilityAdapter {
  /** Matches PLATFORMS[].id in src/lib/booking/platforms.ts. */
  platform: string;
  /** Pure: does this booking link belong to this adapter? */
  matches(url: string): boolean;
  /** At most 8 requests per call; every time in UTC ISO 8601; courts free AND booked when the page shows both (free: false for booked). */
  scrape(target: ScrapeTarget, fetchImpl: typeof fetch, now: Date): Promise<ScrapeResult>;
}
