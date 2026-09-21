import { json, options } from "@/lib/api/http";
import { READ_CACHE, withApi } from "@/lib/api/route";
import { clubToPublic } from "@/lib/api/serialize";
import { baseUrl } from "@/lib/config";
import { CITIES } from "@/lib/domain/cities";
import { listLiveClubs, listShownClubs } from "@/lib/domain/clubs";
import { courtNamesBySlug } from "@/lib/domain/courts";

export const dynamic = "force-dynamic";

/**
 * Club pages, optionally for one city. Public data only.
 *
 * By default this is what it has always been: clubs that claimed their page and run it. The website
 * shows more — clubs Kicksmash listed from public sources — and an assistant asking "where can I
 * play in Phuket?" was told nobody had claimed a page while /clubs listed forty. `include=listed`
 * adds them, and every row says `claimed` so a caller can tell the club's own word from ours. The
 * default stays narrow on purpose: a caller who built on "a club that runs here" keeps that answer.
 */
export async function GET(req: Request) {
  return withApi(req, "read", async ({ db }) => {
    const params = new URL(req.url).searchParams;
    const city = params.get("city")?.toLowerCase() ?? null;
    const known = city && CITIES.some((c) => c.slug === city) ? city : null;
    const listed = params.get("include")?.toLowerCase() === "listed";
    const clubs = listed ? await listShownClubs(db, known) : await listLiveClubs(db, known);
    const base = baseUrl();
    const names = await courtNamesBySlug(db, clubs.map((c) => c.slug));
    return json(
      {
        city: known,
        include: listed ? "listed" : "claimed",
        clubs: clubs.map((c) => clubToPublic(c, base, names.get(c.slug))),
        cities: CITIES.map((c) => ({ slug: c.slug, name: c.name, url: `${base}/${c.slug}` })),
      },
      { cache: READ_CACHE },
    );
  });
}

export async function OPTIONS() {
  return options();
}
