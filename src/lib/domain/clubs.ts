import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import { locales } from "@/i18n/config";
import { pingIndexNow } from "@/lib/indexnow";
import { localePath } from "@/lib/seo";
import type { Db } from "@/db";
import { clubs, venues, type Club } from "@/db/schema";
import { cleanUrl, detectPlatform } from "@/lib/booking/platforms";
import { AVAILABILITY_KINDS } from "@/lib/booking/availability";
import { CITIES, cityBySlug, venueInCity } from "./cities";
import { isValidTimeZone } from "@/lib/dates";
import { DomainError } from "./errors";
import { isValidVenueSlug, venueSlug } from "./venueBoard";

/**
 * Clubs: a venue page a club has claimed. The claim is self-serve; the owner
 * approves each one with a tap (a phishing booking link on a club page is
 * the thing this guards against). The first clubs in a city are founding
 * clubs: everything stays free for them for good.
 */
export const CLUB_LIMITS = { aboutMax: 400, foundingPerCity: 10, claimsPerPlayerPerDay: 3 } as const;

export type ClubInput = {
  website?: unknown;
  bookingUrl?: unknown;
  mapUrl?: unknown;
  courts?: unknown;
  about?: unknown;
  city?: unknown;
  opensAt?: unknown;
  closesAt?: unknown;
  availabilityUrl?: unknown;
  availabilityKind?: unknown;
};

const HHMM = /^([01]?\d|2[0-4]):[0-5]\d$/;
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Normalises the free-form fields a club may set. Unknown or invalid values become null, never errors. */
export function cleanClubInput(input: ClubInput): Partial<Pick<Club, "website" | "bookingUrl" | "bookingPlatform" | "mapUrl" | "courts" | "about" | "city" | "opensAt" | "closesAt" | "availabilityUrl" | "availabilityKind">> {
  const out: ReturnType<typeof cleanClubInput> = {};
  if ("website" in input) out.website = cleanUrl(input.website);
  if ("bookingUrl" in input) {
    out.bookingUrl = cleanUrl(input.bookingUrl);
    out.bookingPlatform = detectPlatform(out.bookingUrl)?.id ?? null;
  }
  if ("mapUrl" in input) out.mapUrl = cleanUrl(input.mapUrl);
  if ("courts" in input) {
    const n = Number(input.courts);
    out.courts = Number.isInteger(n) && n >= 1 && n <= 64 ? n : null;
  }
  if ("about" in input) out.about = text(input.about, CLUB_LIMITS.aboutMax);
  if ("city" in input) out.city = typeof input.city === "string" && cityBySlug(input.city) ? input.city : null;
  if ("opensAt" in input) out.opensAt = typeof input.opensAt === "string" && HHMM.test(input.opensAt.trim()) ? input.opensAt.trim().padStart(5, "0") : null;
  if ("closesAt" in input) out.closesAt = typeof input.closesAt === "string" && HHMM.test(input.closesAt.trim()) ? input.closesAt.trim().padStart(5, "0") : null;
  if ("availabilityUrl" in input) out.availabilityUrl = cleanUrl(input.availabilityUrl);
  if ("availabilityKind" in input) out.availabilityKind = typeof input.availabilityKind === "string" && (AVAILABILITY_KINDS as readonly string[]).includes(input.availabilityKind) ? input.availabilityKind : null;
  return out;
}

export const isClubLive = (c: Pick<Club, "approvedAt" | "rejectedAt"> | null | undefined): boolean => Boolean(c?.approvedAt && !c.rejectedAt);
export const clubStatus = (c: Pick<Club, "approvedAt" | "rejectedAt">): "live" | "pending" | "rejected" => (c.rejectedAt ? "rejected" : c.approvedAt ? "live" : "pending");

export async function getClub(db: Db, slug: string): Promise<Club | null> {
  if (!isValidVenueSlug(slug)) return null;
  const [c] = await db.select().from(clubs).where(eq(clubs.slug, slug)).limit(1);
  return c ?? null;
}

/** The live club behind a slug, or null: what public pages and the API show. */
export async function getLiveClub(db: Db, slug: string): Promise<Club | null> {
  const c = await getClub(db, slug);
  return isClubLive(c) ? c : null;
}

export async function getClubByToken(db: Db, token: string): Promise<Club | null> {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(token)) return null;
  const [c] = await db.select().from(clubs).where(eq(clubs.manageToken, token)).limit(1);
  return c ?? null;
}

export async function listLiveClubs(db: Db, city?: string | null, limit = 200): Promise<Club[]> {
  const where = city ? and(isNotNull(clubs.approvedAt), isNull(clubs.rejectedAt), eq(clubs.city, city)) : and(isNotNull(clubs.approvedAt), isNull(clubs.rejectedAt));
  return db.select().from(clubs).where(where).orderBy(desc(clubs.founding), asc(clubs.name)).limit(limit);
}

/**
 * Every club a person can pick by name: the ones their owners run here, and the ones Kicksmash
 * listed from public sources. Ordered the way a list is read when nothing better is known —
 * country, then province, then the name — so the caller can group it without sorting again.
 *
 * A rejected claim is nobody's club and appears as neither.
 */
export async function listClubsForPicking(db: Db, limit = 500): Promise<Club[]> {
  return db
    .select()
    .from(clubs)
    .where(and(isNull(clubs.rejectedAt), or(isNotNull(clubs.approvedAt), eq(clubs.source, "directory"))))
    .orderBy(asc(clubs.country), asc(clubs.province), asc(clubs.name))
    .limit(limit);
}

/**
 * A place somebody can pick, in the order a person reads a list when the app knows a little about
 * them. `slug` is the club's own address when the pick is a listed club, so a match made here lands
 * on that club's page rather than on a second one made from its name.
 */
export type PickableVenue = { name: string; slug: string | null; mapUrl: string | null; country: string | null; province: string | null; courts: number | null; where: "yours" | "here" | "elsewhere" };

/** The slug a place answers to: a listed club's own, or what the typed name makes. */
const placeKey = (name: string) => venueSlug(name);

/**
 * Every place this person could mean, most likely first:
 *
 * 1. the courts they have used before, most recent first;
 * 2. the clubs in their own time zone — near enough to "the country they are in" to be worth putting
 *    above the rest, and it costs no new question and no new column;
 * 3. everywhere else, by country, then province, then name.
 *
 * A place appears once. "Warehaus" on their own list and "WAREHAUS.club" in the directory are one
 * club, because both answer to the slug `warehaus`.
 */
export async function venuesForPicking(db: Db, playerId: string | null, tz?: string | null): Promise<PickableVenue[]> {
  // Sequential, not parallel: the pooler stalls on pipelined bursts (rule 8). Both are bounded.
  const mine = playerId ? await db.select().from(venues).where(eq(venues.creatorPlayerId, playerId)).orderBy(desc(venues.lastUsedAt)).limit(50) : [];
  const listed = await listClubsForPicking(db);
  // A club answers to its own slug, and to whatever its name would make, so a person who typed the
  // club's full name once is still recognised as having been there.
  const byKey = new Map<string, Club>();
  for (const c of listed) {
    byKey.set(c.slug, c);
    const fromName = placeKey(c.name);
    if (fromName && !byKey.has(fromName)) byKey.set(fromName, c);
  }
  const seen = new Set<string>();
  const out: PickableVenue[] = [];
  for (const v of mine) {
    const club = byKey.get(placeKey(v.name) ?? "") ?? null;
    const key = club?.slug ?? placeKey(v.name) ?? v.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Their own name for it, not the directory's: it is what their matches already say.
    out.push({ name: v.name, slug: club?.slug ?? null, mapUrl: v.mapUrl ?? club?.mapUrl ?? null, country: club?.country ?? null, province: club?.province ?? null, courts: club?.courts ?? null, where: "yours" });
  }
  const here: PickableVenue[] = [];
  const elsewhere: PickableVenue[] = [];
  for (const c of listed) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    // A club that claimed its page never said which province it is in; the city it picked will do,
    // so the list has a heading to put it under rather than the one above it.
    const province = c.province ?? (c.city ? (cityBySlug(c.city)?.name ?? null) : null);
    (tz && c.tz === tz ? here : elsewhere).push({ name: c.name, slug: c.slug, mapUrl: c.mapUrl, country: c.country, province, courts: c.courts, where: tz && c.tz === tz ? "here" : "elsewhere" });
  }
  return [...out, ...here, ...elsewhere];
}

export async function listClubsClaimedBy(db: Db, playerId: string): Promise<Club[]> {
  return db.select().from(clubs).where(eq(clubs.claimedBy, playerId)).orderBy(asc(clubs.name));
}

/**
 * Clubs whose owners claimed them since a date — the weekly digest's "clubs claimed" number.
 * Kicksmash listing a club is not a club joining, so the directory's own rows never count.
 */
export async function countClubsClaimedSince(db: Db, since: Date): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(clubs).where(and(eq(clubs.source, "claim"), gte(clubs.createdAt, since)));
  return Number(n);
}

/** Claims waiting on the owner's yes. A directory row is nobody's claim and never queues here. */
export async function listPendingClubs(db: Db): Promise<Club[]> {
  return db.select().from(clubs).where(and(eq(clubs.source, "claim"), isNull(clubs.approvedAt), isNull(clubs.rejectedAt))).orderBy(asc(clubs.claimedAt));
}

const newToken = () => randomBytes(18).toString("base64url");

/** The city a venue sits in, from its time zone and slug, when one of ours matches. */
export function guessCity(slug: string | null, tz: string | null | undefined): string | null {
  if (!slug || !tz) return null;
  return CITIES.find((c) => venueInCity(c, slug, tz))?.slug ?? null;
}

export type ClaimInput = ClubInput & { name: string; playerId: string; tz?: string | null };

/** The unclaimed listing for a name, whatever slug it was listed under. */
async function listedClubByName(db: Db, name: string): Promise<Club | null> {
  const [c] = await db
    .select()
    .from(clubs)
    .where(and(eq(clubs.source, "directory"), isNull(clubs.claimedBy), sql`lower(${clubs.name}) = ${name.toLowerCase()}`))
    .limit(1);
  return c ?? null;
}

/**
 * Claims a club page. A live or pending claim by someone else blocks; a
 * rejected one can be claimed again (the owner sees it again).
 */
export async function claimClub(db: Db, input: ClaimInput): Promise<Club> {
  const name = input.name.trim().slice(0, 80);
  const typed = venueSlug(name);
  if (!typed || name.length < 2) throw new DomainError("invalid", "club_name");
  // A club the directory listed keeps the slug its matches already carry ("warehaus"), which is not
  // what venueSlug() makes of the name it is called by ("warehaus-club"). Find the listing by name
  // first, or claiming it would open a second page for the same club with the history on the other one.
  const listed = await listedClubByName(db, name);
  const slug = listed?.slug ?? typed;
  const existing = listed ?? (await getClub(db, slug));
  // A directory row belongs to nobody until its owner turns up: `claimedBy` is null, and this is the
  // claim it was waiting for. Only a row somebody else is already holding blocks — without the null
  // check, listing a club in the directory would tell its real owner it was "already claimed".
  if (existing && !existing.rejectedAt && existing.claimedBy !== null && existing.claimedBy !== input.playerId) throw new DomainError("forbidden", "already_claimed");
  const fields = cleanClubInput(input);
  const city = fields.city ?? guessCity(slug, input.tz ?? existing?.tz) ?? existing?.city ?? null;
  // No zone from the browser: the city's zone will do, and the week can make matches from the first hour.
  const tz = input.tz ?? existing?.tz ?? (city ? (cityBySlug(city)?.tz ?? null) : null);
  // A claimed row is a claim, whatever it was before. The directory's own fields (country, province,
  // the court counts) are left alone: they are still true, and the owner edits them through the
  // manage link like everything else.
  const values = { ...fields, city, name, tz, source: "claim", claimedBy: input.playerId, claimedAt: new Date(), rejectedAt: null, approvedAt: existing?.claimedBy === input.playerId ? existing.approvedAt : null, updatedAt: new Date() };
  if (existing) {
    const [row] = await db.update(clubs).set(values).where(eq(clubs.slug, slug)).returning();
    return row;
  }
  const [row] = await db
    .insert(clubs)
    .values({ slug, manageToken: newToken(), ...values })
    .returning();
  return row;
}

/** Edits through the manage link. Name and slug never change (they are the venue's). */
export async function updateClub(db: Db, token: string, input: ClubInput): Promise<Club | null> {
  const club = await getClubByToken(db, token);
  if (!club) return null;
  const fields = cleanClubInput(input);
  // A new feed address starts a fresh cache.
  const feedChanged = ("availabilityUrl" in fields && fields.availabilityUrl !== club.availabilityUrl) || ("availabilityKind" in fields && fields.availabilityKind !== club.availabilityKind);
  // A club without a zone that names (or has) a city takes the city's zone.
  const cityNow = "city" in fields ? fields.city : club.city;
  const tzFill = !club.tz && cityNow ? (cityBySlug(cityNow)?.tz ?? null) : null;
  const [row] = await db
    .update(clubs)
    .set({ ...fields, ...(feedChanged ? { availability: null, availabilityAt: null } : {}), ...(tzFill ? { tz: tzFill } : {}), updatedAt: new Date() })
    .where(eq(clubs.slug, club.slug))
    .returning();
  return row;
}

/** The owner's tap. Approval makes the page live and hands out the founding badge while the city has room. */
export async function decideClub(db: Db, slug: string, approve: boolean, now = new Date()): Promise<Club | null> {
  const club = await getClub(db, slug);
  if (!club) return null;
  if (!approve) {
    const [row] = await db.update(clubs).set({ rejectedAt: now, approvedAt: null, founding: false, updatedAt: now }).where(eq(clubs.slug, slug)).returning();
    return row;
  }
  let founding = club.founding;
  if (!club.approvedAt && club.city) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(clubs).where(and(eq(clubs.city, club.city), eq(clubs.founding, true), isNotNull(clubs.approvedAt), isNull(clubs.rejectedAt)));
    founding = Number(n) < CLUB_LIMITS.foundingPerCity;
  }
  const [row] = await db.update(clubs).set({ approvedAt: club.approvedAt ?? now, rejectedAt: null, founding, updatedAt: now }).where(eq(clubs.slug, slug)).returning();
  // A live club page is news for the search engines that speak IndexNow.
  await pingIndexNow([`/v/${slug}`, ...locales.map((l) => localePath("/clubs", l))], { db });
  return row;
}

export async function setClubNotifyMessage(db: Db, slug: string, messageId: number | null): Promise<void> {
  await db.update(clubs).set({ notifyMessageId: messageId }).where(eq(clubs.slug, slug));
}

/** Slots of "free courts today" as a short count, for chips and lists. */
export function freeCourtHours(c: Pick<Club, "availability"> | null | undefined, now = new Date()): number | null {
  const a = c?.availability;
  if (!a || a.error) return null;
  return a.slots.filter((s) => new Date(s.end) > now).reduce((sum, s) => sum + s.free, 0);
}

/** The club's time zone, set from the manage page when the claim came without one (the week cannot make matches without it). */
export async function setClubTimezone(db: Db, slug: string, tz: string): Promise<Club | null> {
  if (!isValidTimeZone(tz)) throw new DomainError("invalid", "tz");
  const [row] = await db.update(clubs).set({ tz, updatedAt: new Date() }).where(eq(clubs.slug, slug)).returning();
  return row ?? null;
}
