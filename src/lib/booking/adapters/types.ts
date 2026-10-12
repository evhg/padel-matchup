/**
 * One free (or booked) court at one time, as a reader found it. `courtId` is the platform's own id for
 * the court when it has one: the frame counts courts apart by it, else by `court`, the name, so two
 * courts with one name stay two. `bookUrl` and `priceText` are what the page showed; the frame keeps
 * neither (`freeSlotsFromScrape`), so no link a reader finds reaches a player.
 */
export type ScrapedSlot = { start: string; end: string; court: string | null; courtId?: string | null; free: boolean; priceText: string | null; bookUrl: string | null };
/**
 * `tz` is the club row's zone as it is, null or not valid included: the frame never puts "UTC" in for a
 * zone nobody gave. A reader that finds the club's zone on the platform's page may use it; one that
 * cannot know the zone returns the error "no time zone" and never guesses. `ref` is the platform's own
 * id for the club that this reader returned on its last clean read (Playtomic's tenant id), handed
 * back for a read of today alone, so such a read can skip the club page; a reader checks its shape and
 * ignores it when it does not fit.
 */
export type ScrapeTarget = {
  clubSlug: string;
  platform: string;
  bookingUrl: string;
  tz: string | null;
  days: number;
  ref?: string | null;
  /**
   * For a platform whose checkout "Book this court" fills (`CHECKOUT` in prepare.ts): the script on the
   * club page known to build that link (`builder`, its path as `fnv1a`; `chunk`, the figures its file
   * name starts with), and whether this read may fetch a few of the page's scripts to find it again
   * (`hunt`). A reader that reads the club page reports what it found (`ScrapeResult.builder`).
   */
  checkout?: { builder: number; chunk: number | null; hunt: boolean };
};
/**
 * The checkout builder on the club page this read fetched: the known script is still there (`same`), a
 * script fetched now builds the link (`found`, its key and its figures), or neither (`lost`: `checked`
 * of the page's `of` scripts read, none builds it). Absent when the read did not fetch the club page.
 */
export type BuilderReport = { state: "same" } | { state: "found"; key: number; chunk: number | null } | { state: "lost"; checked: number; of: number };
export type ScrapeFailure = "blocked" | "not_found" | "changed" | "timeout" | "error" | "not_public";
/**
 * `tz` on a clean read: the zone the reader read the club's days in. The frame keeps the cache in it.
 * `ref` on a clean read: the platform's own id for the club, which the frame keeps on the cache and
 * hands back as `ScrapeTarget.ref` (letters, figures, "-", "_", ":" and ".", 80 at most; anything else
 * is dropped).
 */
export type ScrapeResult = { ok: true; slots: ScrapedSlot[]; requests: number; tz?: string; ref?: string; builder?: BuilderReport } | { ok: false; status: number | null; reason: ScrapeFailure; requests: number; detail: string | null };
export interface AvailabilityAdapter {
  /** Matches PLATFORMS[].id in src/lib/booking/platforms.ts. */
  platform: string;
  /** Pure: does this booking link belong to this adapter? */
  matches(url: string): boolean;
  /** At most 8 requests per call; every time in UTC ISO 8601; courts free AND booked when the page shows both (free: false for booked). */
  scrape(target: ScrapeTarget, fetchImpl: typeof fetch, now: Date): Promise<ScrapeResult>;
}
