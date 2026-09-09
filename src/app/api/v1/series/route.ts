import { json, options } from "@/lib/api/http";
import { READ_CACHE, withApi } from "@/lib/api/route";
import { seriesToPublic } from "@/lib/api/serialize";
import { baseUrl } from "@/lib/config";
import { CITIES, cityBySlug } from "@/lib/domain/cities";
import { listSeries } from "@/lib/domain/series";

export const dynamic = "force-dynamic";

/** Active series (Opens that repeat), optionally in one city, each with its next edition. Public data only. */
export async function GET(req: Request) {
  return withApi(req, "read", async ({ db }) => {
    const citySlug = new URL(req.url).searchParams.get("city")?.toLowerCase() ?? null;
    const city = citySlug ? cityBySlug(citySlug) : null;
    const cities = CITIES.map((c) => ({ slug: c.slug, name: c.name, url: `${baseUrl()}/${c.slug}` }));
    if (citySlug && !city) return json({ city: citySlug, series: [], cities, note: `Unknown city. Known: ${CITIES.map((c) => c.slug).join(", ")}.` }, { cache: READ_CACHE });
    const rows = await listSeries(db, city);
    const series = rows.map((r) => seriesToPublic(r.series, r.next, baseUrl()));
    return json({ city: city?.slug ?? null, series, cities, note: series.length ? undefined : "No series yet. The organizer of a finished tournament makes one from its page: same weekday, same time, every week, fortnight or month." }, { cache: READ_CACHE });
  });
}

export async function OPTIONS() {
  return options();
}
