import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, type Club } from "@/db/schema";
import { cleanUrl, detectPlatform } from "@/lib/booking/platforms";
import { AVAILABILITY_KINDS } from "@/lib/booking/availability";
import { CITIES, cityBySlug, venueInCity } from "./cities";
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

export async function listClubsClaimedBy(db: Db, playerId: string): Promise<Club[]> {
  return db.select().from(clubs).where(eq(clubs.claimedBy, playerId)).orderBy(asc(clubs.name));
}

export async function listPendingClubs(db: Db): Promise<Club[]> {
  return db.select().from(clubs).where(and(isNull(clubs.approvedAt), isNull(clubs.rejectedAt))).orderBy(asc(clubs.claimedAt));
}

const newToken = () => randomBytes(18).toString("base64url");

/** The city a venue sits in, from its time zone and slug, when one of ours matches. */
export function guessCity(slug: string | null, tz: string | null | undefined): string | null {
  if (!slug || !tz) return null;
  return CITIES.find((c) => venueInCity(c, slug, tz))?.slug ?? null;
}

export type ClaimInput = ClubInput & { name: string; playerId: string; tz?: string | null };

/**
 * Claims a club page. A live or pending claim by someone else blocks; a
 * rejected one can be claimed again (the owner sees it again).
 */
export async function claimClub(db: Db, input: ClaimInput): Promise<Club> {
  const name = input.name.trim().slice(0, 80);
  const slug = venueSlug(name);
  if (!slug || name.length < 2) throw new DomainError("invalid", "club_name");
  const existing = await getClub(db, slug);
  if (existing && !existing.rejectedAt && existing.claimedBy !== input.playerId) throw new DomainError("forbidden", "already_claimed");
  const fields = cleanClubInput(input);
  const city = fields.city ?? guessCity(slug, input.tz ?? existing?.tz) ?? existing?.city ?? null;
  const values = { ...fields, city, name, tz: input.tz ?? existing?.tz ?? null, claimedBy: input.playerId, claimedAt: new Date(), rejectedAt: null, approvedAt: existing?.claimedBy === input.playerId ? existing.approvedAt : null, updatedAt: new Date() };
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
  const [row] = await db
    .update(clubs)
    .set({ ...fields, ...(feedChanged ? { availability: null, availabilityAt: null } : {}), updatedAt: new Date() })
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
