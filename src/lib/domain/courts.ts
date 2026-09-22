import { and, asc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import type { Db } from "@/db";
import { clubCourts, clubs, events, lessons, type Club, type ClubCourt, type CourtKind } from "@/db/schema";
import { EVENT_DURATION_MS } from "@/lib/config";
import { DomainError } from "./errors";

/**
 * A club's courts as rows: names, numbers, indoor or outdoor. The club's three counts (`courts`,
 * `courts_indoor`, `courts_outdoor`) are derived from the rows whenever the rows change, so the
 * badge, the API and the match form's picker read one column each and never join this table
 * (rule 12). A club without rows keeps the counts it typed on the claim.
 */

export const COURT_LIMITS = { max: 64, nameMax: 40 } as const;
export type CourtInput = { name: unknown; kind?: unknown; number?: unknown };
export type CleanCourt = { name: string; number: number | null; kind: CourtKind | null };

const isKind = (v: unknown): v is CourtKind => v === "indoor" || v === "outdoor";

/** The number in a name ("Court 3", "Pista 12", "3") when there is exactly one; null otherwise. */
export function courtNumber(name: string): number | null {
  const m = name.match(/(\d{1,3})/g);
  if (!m || m.length !== 1) return null;
  const n = Number(m[0]);
  return n >= 1 && n <= 999 ? n : null;
}

/** The rows a club may save: trimmed names, at most 64, no two the same; a number read from the name unless given. */
export function cleanCourts(input: CourtInput[]): CleanCourt[] {
  const out: CleanCourt[] = [];
  const seen = new Set<string>();
  for (const c of input.slice(0, COURT_LIMITS.max)) {
    const name = typeof c.name === "string" ? c.name.trim().replace(/\s+/g, " ").slice(0, COURT_LIMITS.nameMax) : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) throw new DomainError("invalid", "court_name_twice");
    seen.add(key);
    const given = Number(c.number);
    const number = c.number !== undefined && c.number !== null && c.number !== "" && Number.isInteger(given) && given >= 1 ? given : courtNumber(name);
    out.push({ name, number, kind: isKind(c.kind) ? c.kind : null });
  }
  return out;
}

/** "Court 1" … "Court n", the quick start for a club that numbers its courts. */
export const numberedCourts = (n: number, word: string): CleanCourt[] => Array.from({ length: Math.max(0, Math.min(COURT_LIMITS.max, n)) }, (_, i) => ({ name: `${word} ${i + 1}`, number: i + 1, kind: null }));

export async function listCourts(db: Db, clubSlug: string): Promise<ClubCourt[]> {
  return db.select().from(clubCourts).where(eq(clubCourts.clubSlug, clubSlug)).orderBy(asc(clubCourts.position), asc(clubCourts.name));
}

/** The court names of several clubs in one read, for the match form's picker. */
export async function courtNamesBySlug(db: Db, slugs: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (slugs.length === 0) return map;
  const rows = await db.select({ slug: clubCourts.clubSlug, name: clubCourts.name, position: clubCourts.position }).from(clubCourts).where(inArray(clubCourts.clubSlug, slugs)).orderBy(asc(clubCourts.clubSlug), asc(clubCourts.position), asc(clubCourts.name));
  for (const r of rows) map.set(r.slug, [...(map.get(r.slug) ?? []), r.name]);
  return map;
}

/** The three counts the rows imply. Unknown kinds count in the total only. */
export function countsOf(rows: Pick<CleanCourt, "kind">[]): Pick<Club, "courts" | "courtsIndoor" | "courtsOutdoor"> {
  if (rows.length === 0) return { courts: null, courtsIndoor: null, courtsOutdoor: null };
  const indoor = rows.filter((r) => r.kind === "indoor").length;
  const outdoor = rows.filter((r) => r.kind === "outdoor").length;
  const said = indoor + outdoor > 0;
  return { courts: rows.length, courtsIndoor: said ? indoor : null, courtsOutdoor: said ? outdoor : null };
}

/**
 * The club's courts, replaced as a set, through the manage token. Sequential writes (rule 8): the
 * old rows go, the new ones come, the counts follow. An empty list clears the rows and leaves the
 * typed counts alone, so a club that lists nothing loses nothing.
 */
export async function replaceCourts(db: Db, token: string, input: CourtInput[]): Promise<{ club: Club; courts: ClubCourt[] } | null> {
  const [club] = await db.select().from(clubs).where(eq(clubs.manageToken, token)).limit(1);
  if (!club) return null;
  const clean = cleanCourts(input);
  await db.delete(clubCourts).where(eq(clubCourts.clubSlug, club.slug));
  if (clean.length) await db.insert(clubCourts).values(clean.map((c, i) => ({ clubSlug: club.slug, name: c.name, number: c.number, kind: c.kind, position: i })));
  const counts = clean.length ? countsOf(clean) : {};
  const [fresh] = await db
    .update(clubs)
    .set({ ...counts, updatedAt: new Date() })
    .where(and(eq(clubs.slug, club.slug)))
    .returning();
  return { club: fresh, courts: await listCourts(db, club.slug) };
}

// ---------------------------------------------------------------------------
// A club's day, court by court.
//
// The rows above say what a club has. This says what is on them. A match names a court already and,
// from this change, so does a lesson — so the club's capacity is the two together, in the club's own
// words, with nothing new for anybody to fill in.
//
// The laying-out is pure because the interesting part is the matching: a player may type "3" where
// the club writes "Court 3". Nothing is invented — a booking that named no court goes in a row of
// its own rather than onto a court it might not be using.
// ---------------------------------------------------------------------------

export type BusyKind = "match" | "lesson";
/** `title` is the match's own; a lesson has none, because a club never reads a student's name. */
export type Busy = { court: string | null; startsAt: Date; minutes: number; kind: BusyKind; title: string | null };
export type CourtRow = { name: string | null; blocks: Busy[] };

const nameKey = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, " ");

/** The same court: the same number when both carry one, else the same words. */
export function sameCourt(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  const [na, nb] = [courtNumber(a), courtNumber(b)];
  if (na !== null && nb !== null) return na === nb;
  return nameKey(a) === nameKey(b);
}

/** One row per club court, in the club's order, then one row for whatever named no court of theirs. */
export function courtDay(courtNames: readonly string[], busy: readonly Busy[]): CourtRow[] {
  const byTime = (a: Busy, b: Busy) => a.startsAt.getTime() - b.startsAt.getTime() || a.kind.localeCompare(b.kind);
  const rows: CourtRow[] = courtNames.map((name) => ({ name, blocks: [] }));
  const loose: Busy[] = [];
  for (const b of busy) {
    // The first matching row wins, so a club that typed one court twice never splits its day.
    const row = rows.find((r) => sameCourt(r.name, b.court));
    if (row) row.blocks.push(b);
    else loose.push(b);
  }
  for (const row of rows) row.blocks.sort(byTime);
  if (loose.length > 0) rows.push({ name: null, blocks: loose.sort(byTime) });
  return rows;
}

/** How many of the club's own courts have something on them: the one number a club reads first. */
export const courtsInUse = (rows: readonly CourtRow[]): number => rows.filter((r) => r.name !== null && r.blocks.length > 0).length;

/** The lesson statuses that really put somebody on a court. A cancellation frees it. */
const ON_COURT = ["booked", "done"] as const;

/**
 * Everything on a club's courts between two moments: its matches and the lessons taught there.
 *
 * Two bounded reads, each on the index that already exists for it — `events_venue_slug_idx` and
 * `lessons_venue_idx`, both `(venue_slug, starts_at)`. Sequential rather than in parallel, because
 * the pooler stalls on pipelined bursts (rule 8). Nothing joins per court and nothing scans a table.
 *
 * A lesson comes back with no title on purpose. The club watches its courts; it never reads a
 * student's name.
 */
export async function clubBusy(db: Db, clubSlug: string, from: Date, to: Date): Promise<Busy[]> {
  const played = await db
    .select({ court: events.court, startsAt: events.startsAt, title: events.title })
    .from(events)
    .where(and(eq(events.venueSlug, clubSlug), gte(events.startsAt, from), lt(events.startsAt, to), ne(events.status, "cancelled")));
  const taught = await db
    .select({ startsAt: lessons.startsAt, minutes: lessons.minutes })
    .from(lessons)
    .where(and(eq(lessons.venueSlug, clubSlug), gte(lessons.startsAt, from), lt(lessons.startsAt, to), inArray(lessons.status, [...ON_COURT])));
  return [
    ...played.map((e): Busy => ({ court: e.court, startsAt: e.startsAt, minutes: EVENT_DURATION_MS / 60000, kind: "match", title: e.title })),
    // A lesson carries a venue but not yet a court, so it lands in the row for what named none. That
    // is the truth today: the club can see a court is being taught on, not which one.
    ...taught.map((l): Busy => ({ court: null, startsAt: l.startsAt, minutes: l.minutes, kind: "lesson", title: null })),
  ];
}
