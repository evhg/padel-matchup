import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { venues } from "@/db/schema";
import { later } from "@/lib/alerts";
import { isValidTimeZone } from "@/lib/dates";
import { bookingHref, clubNamed, linksIn, PASTE_TEXT_MAX, readBooking, type BookingPreview, type BookingRead, type PickClub } from "@/lib/domain/bookingPaste";
import { listClubsForPicking } from "@/lib/domain/clubs";
import { bumpMetric, dayKey } from "@/lib/domain/metrics";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";
import { detectPlatform } from "./platforms";
import { readLinkPreview } from "./unfurl";

export type PasteResult = { ok: true; read: BookingRead; href: string } | { ok: false; reason: "empty" | "limit" };

/** A club row as the reader takes it. */
export const pickClubOf = (c: { slug: string; name: string; tz: string | null; bookingUrl?: string | null; website?: string | null }): PickClub => ({
  slug: c.slug,
  name: c.name,
  tz: c.tz,
  bookingUrl: c.bookingUrl ?? null,
  website: c.website ?? null,
});

/**
 * The venue of the organiser's latest match: `venues` keeps one row per organiser and place, stamped
 * each time a match of theirs names it (`rememberVenue`). One read down `venues_creator_name_idx`,
 * which starts with the organiser, over that organiser's own places only.
 */
async function lastVenueOf(db: Db, playerId: string): Promise<string | null> {
  const [row] = await db.select({ name: venues.name }).from(venues).where(eq(venues.creatorPlayerId, playerId)).orderBy(desc(venues.lastUsedAt)).limit(1);
  return row?.name ?? null;
}

/**
 * A pasted booking, read: the form's fields and the link that opens the form with them. What it costs
 * (AGENTS.md rule 12): one counter write for the limit (`takeRate`, thirty a day for each caller);
 * one read of the clubs (`listClubsForPicking`, every listed club without its cache; no cache in
 * front of it today); when the paste still lacks the club, the day or the time and carries a
 * platform's link, one outbound read of that link (`readLinkPreview`: one request and at most three
 * redirects, four seconds) and one counter after the answer; when no club is found and the caller is
 * signed in, one read of their latest venue. Nothing is stored but the two counters.
 *
 * `rateKey` is the caller's key: a hash of the address on the web (`clientKeyFrom`), the account on a bot.
 */
export async function pasteBooking(
  db: Db,
  input: { text: string; links?: readonly string[]; tz: string; rateKey: string; playerId?: string | null; selfName?: string | null; now?: Date },
  o: { fetchImpl?: typeof fetch } = {},
): Promise<PasteResult> {
  const now = input.now ?? new Date();
  const text = (input.text ?? "").slice(0, PASTE_TEXT_MAX);
  const links = linksIn(text, input.links ?? []);
  if (!text.trim() && links.length === 0) return { ok: false, reason: "empty" };
  if (!(await takeRate(db, "paste", input.rateKey, LIMITS.bookingPastesPerIpPerDay, "day", now))) return { ok: false, reason: "limit" };

  const tz = isValidTimeZone(input.tz) ? input.tz : "UTC";
  const clubs = (await listClubsForPicking(db)).map(pickClubOf);
  const base = { text, links, clubs, now, tz, selfName: input.selfName ?? null };
  let preview: BookingPreview | null = null;
  let read = readBooking(base);

  // One link at most, the first a platform gave, and only for what the person's words left out.
  const link = links.find((l) => detectPlatform(l));
  if (link && read.missing.length > 0) {
    const got = await readLinkPreview(link, { fetchImpl: o.fetchImpl });
    await later(() => bumpMetric(db, got ? "paste_preview_ok" : "paste_preview_fail", 1, dayKey(now)));
    if (got) {
      preview = { title: got.title, description: got.description, ref: got.ref };
      read = readBooking({ ...base, preview });
    }
  }
  if (!read.club && input.playerId) {
    const name = await lastVenueOf(db, input.playerId);
    const club = name ? clubNamed(name, clubs, tz) : null;
    if (club) read = readBooking({ ...base, preview, fallbackClub: club });
  }
  return { ok: true, read, href: bookingHref(read) };
}
