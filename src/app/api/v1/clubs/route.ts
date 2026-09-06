import { json, options } from "@/lib/api/http";
import { READ_CACHE, withApi } from "@/lib/api/route";
import { clubToPublic } from "@/lib/api/serialize";
import { baseUrl } from "@/lib/config";
import { CITIES } from "@/lib/domain/cities";
import { listLiveClubs } from "@/lib/domain/clubs";

export const dynamic = "force-dynamic";

/** Live club pages, optionally for one city. Public data only. */
export async function GET(req: Request) {
  return withApi(req, "read", async ({ db }) => {
    const city = new URL(req.url).searchParams.get("city")?.toLowerCase() ?? null;
    const clubs = await listLiveClubs(db, city && CITIES.some((c) => c.slug === city) ? city : null);
    const base = baseUrl();
    return json({ city, clubs: clubs.map((c) => clubToPublic(c, base)), cities: CITIES.map((c) => ({ slug: c.slug, name: c.name, url: `${base}/${c.slug}` })) }, { cache: READ_CACHE });
  });
}

export async function OPTIONS() {
  return options();
}
