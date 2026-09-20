import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import { locales } from "@/i18n/config";
import { pingIndexNow } from "@/lib/indexnow";
import { localePath } from "@/lib/seo";
import type { Db } from "@/db";
import { clubs, coaches, events, venues, type Club } from "@/db/schema";
import { cleanUrl, detectPlatform } from "@/lib/booking/platforms";
import { AVAILABILITY_KINDS } from "@/lib/booking/availability";
import { CITIES, cityBySlug, cityInText, venueInCity } from "./cities";
import { CLAIM_ROLES, type ClaimRole } from "./claimRoles";
import { countryOfTz, isCountryCode } from "./countries";
import { normalizeEmail } from "./players";
import { isValidTimeZone } from "@/lib/dates";
import { DomainError } from "./errors";
import { courtNamesBySlug } from "./courts";
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
  courtsIndoor?: unknown;
  courtsOutdoor?: unknown;
  about?: unknown;
  city?: unknown;
  /** The place as a person there names it ("Kuala Lumpur"), and the country as ISO 3166-1 alpha-2 ("MY"). */
  place?: unknown;
  country?: unknown;
  opensAt?: unknown;
  closesAt?: unknown;
  availabilityUrl?: unknown;
  availabilityKind?: unknown;
};

const HHMM = /^([01]?\d|2[0-4]):[0-5]\d$/;
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Normalises the free-form fields a club may set. Unknown or invalid values become null, never errors. */
export function cleanClubInput(input: ClubInput): Partial<Pick<Club, "website" | "bookingUrl" | "bookingPlatform" | "mapUrl" | "courts" | "courtsIndoor" | "courtsOutdoor" | "about" | "city" | "country" | "province" | "opensAt" | "closesAt" | "availabilityUrl" | "availabilityKind">> {
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
  // The split of the total: an indoor court in Bangkok in April is a different thing from an outdoor
  // one. Zero is an answer ("no indoor courts"); an empty field is not, and stays unknown.
  const split = (v: unknown) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 64 ? n : null;
  };
  if ("courtsIndoor" in input) out.courtsIndoor = split(input.courtsIndoor);
  if ("courtsOutdoor" in input) out.courtsOutdoor = split(input.courtsOutdoor);
  if ("about" in input) out.about = text(input.about, CLUB_LIMITS.aboutMax);
  if ("city" in input) out.city = typeof input.city === "string" && cityBySlug(input.city) ? input.city : null;
  // A club anywhere: the place is free text, and when it names a city with a page, the page follows.
  if ("place" in input) {
    out.province = text(input.place, 60);
    out.city = out.province ? (cityInText(out.province)?.slug ?? null) : null;
  }
  if ("country" in input) out.country = isCountryCode(input.country) ? input.country : null;
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
export type PickableVenue = { name: string; slug: string | null; mapUrl: string | null; country: string | null; province: string | null; courts: number | null; /** The club's courts by name when it listed them; the form offers these instead of 1…n. */ courtNames: string[]; where: "yours" | "here" | "nearby" | "elsewhere" };

/**
 * Where to find a club on a map when nobody has published a link for it: a search for the club by
 * its own name and area. Not a claim about where it is — a way to look it up — so it is derived
 * rather than stored, and a club that claims its page replaces it with its real place link.
 */
export function mapSearchUrl(c: { name: string; about?: string | null; province?: string | null }): string {
  const q = (c.about ?? "").replace(/\.$/, "").trim() || [c.name, c.province].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/** The slug a place answers to: a listed club's own, or what the typed name makes. */
const placeKey = (name: string) => venueSlug(name);

/** Where the person is, as the edge reports it. A time zone alone cannot tell Phuket from Bangkok. */
export type Whereabouts = { tz?: string | null; city?: string | null };

const same = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/**
 * Every place this person could mean, most likely first:
 *
 * 1. the courts they have used before, and the clubs they teach at, most recent first;
 * 2. the clubs in their own province — Phuket has eight clubs and Bangkok sixteen, and Bangkok sorts
 *    first alphabetically, so a Phuket player who sees six rows sees six Bangkok clubs and none of
 *    their own. The city the edge reports is what tells the two apart;
 * 3. the clubs in their own time zone, which is roughly the country they are in;
 * 4. everywhere else, by country, then province, then name.
 *
 * A place appears once. "Warehaus" on their own list and "WAREHAUS.club" in the directory are one
 * club, because both answer to the slug `warehaus`.
 */
export async function venuesForPicking(db: Db, playerId: string | null, at: Whereabouts | string | null = null): Promise<PickableVenue[]> {
  // A time zone on its own is still accepted, so a caller that only has one keeps working.
  const { tz = null, city = null } = typeof at === "string" ? { tz: at, city: null } : (at ?? {});
  // Sequential, not parallel: the pooler stalls on pipelined bursts (rule 8). All are bounded.
  const mine = playerId ? await db.select().from(venues).where(eq(venues.creatorPlayerId, playerId)).orderBy(desc(venues.lastUsedAt)).limit(50) : [];
  // Where a coach teaches is a place they have used, even if they have never made a match there.
  const teaches = playerId ? await db.select({ slugs: coaches.clubSlugs, names: coaches.clubNames }).from(coaches).where(and(eq(coaches.playerId, playerId), isNull(coaches.archivedAt))).limit(1) : [];
  const listed = await listClubsForPicking(db);
  // A club answers to its own slug, and to whatever its name would make, so a person who typed the
  // club's full name once is still recognised as having been there.
  const byKey = new Map<string, Club>();
  for (const c of listed) {
    byKey.set(c.slug, c);
    const fromName = placeKey(c.name);
    if (fromName && !byKey.has(fromName)) byKey.set(fromName, c);
  }
  // A club that claimed its page never said which province it is in; the city it picked will do, so
  // the list has a heading to put it under rather than the one above it.
  const provinceOf = (c: Club) => c.province ?? (c.city ? (cityBySlug(c.city)?.name ?? null) : null);
  const seen = new Set<string>();
  const out: PickableVenue[] = [];
  const own: { name: string; mapUrl: string | null }[] = [
    ...mine.map((v) => ({ name: v.name, mapUrl: v.mapUrl })),
    ...(teaches[0]?.names ?? []).map((n) => ({ name: n, mapUrl: null })),
  ];
  for (const slug of teaches[0]?.slugs ?? []) {
    const c = byKey.get(slug);
    if (c) own.push({ name: c.name, mapUrl: c.mapUrl });
  }
  for (const v of own) {
    const club = byKey.get(placeKey(v.name) ?? "") ?? null;
    const key = club?.slug ?? placeKey(v.name) ?? v.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Their own name for it, not the directory's: it is what their matches already say.
    out.push({ name: v.name, slug: club?.slug ?? null, mapUrl: v.mapUrl ?? club?.mapUrl ?? (club ? mapSearchUrl(club) : null), country: club?.country ?? null, province: club ? provinceOf(club) : null, courts: club?.courts ?? null, courtNames: [], where: "yours" });
  }
  const here: PickableVenue[] = [];
  const nearby: PickableVenue[] = [];
  const elsewhere: PickableVenue[] = [];
  for (const c of listed) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    const province = provinceOf(c);
    // The city the edge reports names a province here ("Phuket", "Bangkok", "Singapore") or a city
    // slug we already keep. Either is a far finer signal than the time zone, which cannot tell one
    // Thai province from another.
    const bucket = same(city, province) || same(city, c.city) ? here : tz && c.tz === tz ? nearby : elsewhere;
    bucket.push({ name: c.name, slug: c.slug, mapUrl: c.mapUrl ?? mapSearchUrl(c), country: c.country, province, courts: c.courts, courtNames: [], where: bucket === here ? "here" : bucket === nearby ? "nearby" : "elsewhere" });
  }
  const all = [...out, ...here, ...nearby, ...elsewhere];
  // The courts by name, one read for every listed club that has rows (few do), so the form can offer "Centre" rather than 1…n.
  const names = await courtNamesBySlug(db, all.flatMap((v) => (v.slug ? [v.slug] : [])));
  for (const v of all) if (v.slug && names.has(v.slug)) v.courtNames = names.get(v.slug)!;
  return all;
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

/**
 * Courts people played at that Kicksmash does not list, commonest first.
 *
 * A club that opened last month is not on the web yet — the aggregators find out months late — but
 * the first people to play there type its name into a match on the day it opens. That is the signal
 * the directory cannot get any other way, and it costs one query a week to read.
 */
export async function unlistedVenues(db: Db, since: Date, limit = 5): Promise<{ slug: string; name: string; matches: number }[]> {
  const rows = await db
    .select({ slug: events.venueSlug, name: sql<string>`max(${events.venueName})`, matches: sql<number>`count(*)` })
    .from(events)
    .where(and(isNotNull(events.venueSlug), gte(events.startsAt, since), sql`not exists (select 1 from ${clubs} where ${clubs.slug} = ${events.venueSlug})`))
    .groupBy(events.venueSlug)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
  return rows.map((r) => ({ slug: r.slug ?? "", name: r.name ?? r.slug ?? "", matches: Number(r.matches) }));
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

export type ClaimInput = ClubInput & { name: string; playerId: string; tz?: string | null; /** The claim's check: who they are at the club, and a work email or the club's phone. */ claimRole?: unknown; claimContact?: unknown };

export { CLAIM_ROLES, type ClaimRole } from "./claimRoles";
const cleanRole = (v: unknown): ClaimRole | null => (typeof v === "string" && (CLAIM_ROLES as readonly string[]).includes(v) ? (v as ClaimRole) : null);

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
  const country = fields.country ?? countryOfTz(input.tz ?? existing?.tz) ?? existing?.country ?? null;
  const province = fields.province ?? existing?.province ?? (city ? (cityBySlug(city)?.name ?? null) : null);
  // The same person claiming again keeps what the check already has; anybody else starts the check from nothing.
  const same = existing?.claimedBy === input.playerId;
  const claimRole = cleanRole(input.claimRole) ?? (same ? existing.claimRole : null);
  const claimContact = text(input.claimContact, 120) ?? (same ? existing.claimContact : null);
  const claimVerifiedAt = same && existing.claimContact === claimContact ? existing.claimVerifiedAt : null;
  // No zone from the browser: the city's zone will do, and the week can make matches from the first hour.
  const tz = input.tz ?? existing?.tz ?? (city ? (cityBySlug(city)?.tz ?? null) : null);
  // A claimed row is a claim, whatever it was before. The directory's own fields (country, province,
  // the court counts) are left alone: they are still true, and the owner edits them through the
  // manage link like everything else.
  const values = { ...fields, city, country, province, name, tz, source: "claim", claimedBy: input.playerId, claimedAt: new Date(), claimRole, claimContact, claimVerifiedAt, rejectedAt: null, approvedAt: same ? existing.approvedAt : null, updatedAt: new Date() };
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

/** Mail domains anybody can have: an address there proves nothing about the club. */
const PUBLIC_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.es", "ymail.com", "hotmail.com", "hotmail.co.uk", "hotmail.es", "outlook.com", "outlook.es", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "mail.ru", "yandex.ru", "yandex.com", "bk.ru", "list.ru", "inbox.ru", "rambler.ru", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "web.de", "qq.com", "163.com", "126.com", "naver.com", "daum.net"]);
const hostOf = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/**
 * The work email the claim can prove by itself: the contact is an email at the club's own domain —
 * its website, or its booking page when that is the club's own and not a platform's. A code to that
 * address confirms the person is inside the club; a public mailbox or a phone number confirms
 * nothing, and those the owner checks by hand.
 */
export function claimEmailForCode(c: Pick<Club, "claimContact" | "website" | "bookingUrl" | "bookingPlatform">): string | null {
  const email = normalizeEmail(c.claimContact);
  const domain = email?.split("@")[1];
  if (!email || !domain || PUBLIC_MAIL.has(domain)) return null;
  const hosts = [hostOf(c.website), c.bookingPlatform ? null : hostOf(c.bookingUrl)].filter((h): h is string => Boolean(h));
  return hosts.some((h) => h === domain || h.endsWith(`.${domain}`) || domain.endsWith(`.${h}`)) ? email : null;
}

/** The code came back right: the claim is confirmed by the club's own mail. Once; a second code changes nothing. */
export async function markClaimVerified(db: Db, slug: string, now = new Date()): Promise<Club | null> {
  const [row] = await db.update(clubs).set({ claimVerifiedAt: now, updatedAt: now }).where(and(eq(clubs.slug, slug), isNull(clubs.claimVerifiedAt))).returning();
  return row ?? null;
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
