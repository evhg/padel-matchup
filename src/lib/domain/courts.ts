import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { clubCourts, clubs, type Club, type ClubCourt, type CourtKind } from "@/db/schema";
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
