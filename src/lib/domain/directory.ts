import type { Club } from "@/db/schema";
import file from "../../../data/clubs.json";

/**
 * What the club directory says about one club, in the shape `scripts/import-clubs.mjs` writes it into
 * `clubs`. The file is the directory's only truth: production's sixty-six rows were written from it
 * and match it field for field (read through the query door on 25 September 2026).
 *
 * The app needs it for one thing. A claim writes over the listing it was made on, and a refused claim
 * has to hand the listing back as the directory had it, not as the claimant typed it. Before this,
 * a refusal left the row refused, and WAREHAUS.club — the busiest court in the app, claimed once as a
 * test — fell off `/clubs`, the Phuket page, the venue picker and the claim form.
 *
 * `tests/club-directory.test.ts` runs the import script's own statement and compares every row it
 * writes with this function, so the two cannot drift apart.
 */
export type DirectoryListing = Pick<Club, "name" | "country" | "province" | "city" | "tz" | "courts" | "courtsIndoor" | "courtsOutdoor" | "website" | "about">;

type Row = { slug: string; name: string; country: string; province: string; city?: string | null; tz: string; area?: string | null; courts?: number | null; courtsIndoor?: number | null; courtsOutdoor?: number | null; website?: string | null };

const bySlug = new Map((file.clubs as Row[]).map((c) => [c.slug, c]));

export function directoryListing(slug: string): DirectoryListing | null {
  const c = bySlug.get(slug);
  if (!c) return null;
  return {
    name: c.name,
    country: c.country,
    province: c.province,
    city: c.city ?? null,
    tz: c.tz,
    courts: c.courts ?? null,
    courtsIndoor: c.courtsIndoor ?? null,
    courtsOutdoor: c.courtsOutdoor ?? null,
    website: c.website ?? null,
    // The script's own sentence: the name and the area, or nothing when no source named the area.
    about: c.area ? `${c.name}, ${c.area}.` : null,
  };
}
