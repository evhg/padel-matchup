import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { venues } from "@/db/schema";
import { later } from "@/lib/alerts";
import { isValidTimeZone } from "@/lib/dates";
import { bookingHref, clubNamed, linksIn, PASTE_TEXT_MAX, readBooking, type BookingPreview, type BookingRead, type PickClub } from "@/lib/domain/bookingPaste";
import { listClubsForPaste } from "@/lib/domain/clubs";
import { bumpMetric, dayKey } from "@/lib/domain/metrics";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";
import { detectPlatform, type Platform } from "./platforms";
import { disabledPlatforms, readPlatformStates } from "./scrape";
import { readLinkPreview } from "./unfurl";

/** `previewed`: the platform's preview filled part of the read, so the organiser checks it on the form before a match is made. */
export type PasteResult = { ok: true; read: BookingRead; href: string; previewed: boolean } | { ok: false; reason: "empty" | "limit" | "nothing" };

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
 * May the read of a pasted link go to this platform now? Not while the 15-minute reader of free court
 * times may not (DECIDING rule 35: it never gets around a block): the deployment's `SCRAPE_DISABLED`
 * (no database read), the owner's switch (`scrape_off_<platform>`, `scrape_off_all`), or a rest after
 * a block (`scrape_rest_until_<platform>`). One read of `metrics_daily`, the same one the reader makes
 * (`readPlatformStates`), and only when a link is about to be read. A "stop" after a page that changed
 * shape is about that reader's parser, not about the platform, so it does not hold this read.
 */
async function mayRead(db: Db, platform: Platform, now: Date): Promise<boolean> {
  const disabled = disabledPlatforms();
  if (disabled === "all" || disabled.has(platform.id)) return false;
  const [state] = await readPlatformStates(db, [platform.id], now, disabled);
  return Boolean(state) && !state.off && !(state.restUntil && state.restUntil > now);
}

/**
 * A pasted booking, read: the form's fields and the link that opens the form with them. What it costs
 * (AGENTS.md rule 12): one counter write for the limit (`takeRate`, thirty a day for each caller);
 * one read of the clubs (`listClubsForPaste`, every listed club, five short columns each; no cache in
 * front of it today); when the paste still lacks the club, the day or the time and carries a
 * platform's link, one read of that platform's switches (`mayRead`), then one outbound read of that
 * link (`readLinkPreview`: one request and at most three redirects, four seconds) and one counter
 * after the answer; when no club is found and the caller is signed in, one read of their latest
 * venue. Nothing is stored but the counters. A paste that shows no platform, no club, no day and no
 * time is no booking (`nothing`): the form does not open on it, and the last venue is not read.
 *
 * `rateKey` is the caller's key: a hash of the address on the web (`clientKeyFrom`), the account on a bot.
 */
export async function pasteBooking(
  db: Db,
  input: {
    text: string;
    links?: readonly string[];
    tz: string;
    rateKey: string;
    playerId?: string | null;
    selfName?: string | null;
    now?: Date;
    /** The clubs, when the caller has read them already (the bot reads them to know a paste from a plain line): no second read. */
    clubs?: readonly PickClub[];
  },
  /** `preview: false` never opens the link: the bot's "Create match" tap, which reads the person's words alone. */
  o: { fetchImpl?: typeof fetch; preview?: boolean } = {},
): Promise<PasteResult> {
  const now = input.now ?? new Date();
  const text = (input.text ?? "").slice(0, PASTE_TEXT_MAX);
  const links = linksIn(text, input.links ?? []);
  if (!text.trim() && links.length === 0) return { ok: false, reason: "empty" };
  if (!(await takeRate(db, "paste", input.rateKey, LIMITS.bookingPastesPerIpPerDay, "day", now))) return { ok: false, reason: "limit" };

  const tz = isValidTimeZone(input.tz) ? input.tz : "UTC";
  const clubs = input.clubs ?? (await listClubsForPaste(db)).map(pickClubOf);
  const base = { text, links, clubs, now, tz, selfName: input.selfName ?? null };
  let preview: BookingPreview | null = null;
  let read = readBooking(base);
  const fromWords = read;

  // One link at most, the first a platform gave, and only for what the person's words left out.
  const link = links.find((l) => detectPlatform(l));
  const platform = link ? detectPlatform(link) : null;
  if (link && platform && read.missing.length > 0 && o.preview !== false) {
    const allowed = await mayRead(db, platform, now);
    const got = allowed ? await readLinkPreview(link, { fetchImpl: o.fetchImpl }) : null;
    await later(() => bumpMetric(db, !allowed ? "paste_preview_off" : got ? "paste_preview_ok" : "paste_preview_fail", 1, dayKey(now)));
    if (got) {
      preview = { title: got.title, description: got.description, ref: got.ref };
      read = readBooking({ ...base, preview });
    }
  }
  if (!read.platform && !read.club && !read.date && !read.time) return { ok: false, reason: "nothing" };
  if (!read.club && input.playerId) {
    const name = await lastVenueOf(db, input.playerId);
    const club = name ? clubNamed(name, clubs, tz) : null;
    if (club) read = readBooking({ ...base, preview, fallbackClub: club });
  }
  // Did the preview change any field? Then the organiser checks the form before a match is made.
  const fields = (r: BookingRead) => JSON.stringify([r.club?.slug ?? null, r.date, r.time, r.minutes, r.court, r.cost]);
  return { ok: true, read, href: bookingHref(read), previewed: preview !== null && fields(fromWords) !== fields(readBooking({ ...base, preview })) };
}
