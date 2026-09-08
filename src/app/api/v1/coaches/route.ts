import { json, options } from "@/lib/api/http";
import { publicCoach } from "@/lib/api/coachOps";
import { READ_CACHE, withApi } from "@/lib/api/route";
import { baseUrl } from "@/lib/config";
import { CITIES, cityBySlug } from "@/lib/domain/cities";
import { listPublicCoaches } from "@/lib/domain/coaching";

export const dynamic = "force-dynamic";

/** Listed coaches, optionally in one city. Public data only: what each coach put on their page. */
export async function GET(req: Request) {
  return withApi(req, "read", async ({ db }) => {
    const citySlug = new URL(req.url).searchParams.get("city")?.toLowerCase() ?? null;
    const city = citySlug ? cityBySlug(citySlug) : null;
    if (citySlug && !city) return json({ city: citySlug, coaches: [], cities: CITIES.map((c) => ({ slug: c.slug, name: c.name, url: `${baseUrl()}/coaches/${c.slug}` })), note: `Unknown city. Known: ${CITIES.map((c) => c.slug).join(", ")}.` }, { cache: READ_CACHE });
    const rows = await listPublicCoaches(db, city?.tz ?? null);
    const coaches = await Promise.all(rows.map((c) => publicCoach(db, c, false)));
    return json({ city: city?.slug ?? null, coaches, cities: CITIES.map((c) => ({ slug: c.slug, name: c.name, url: `${baseUrl()}/coaches/${c.slug}` })), note: coaches.length ? undefined : "No coach has listed their page here yet. Coaches set up their book at /coach in under a minute." }, { cache: READ_CACHE });
  });
}

export async function OPTIONS() {
  return options();
}
