import { ApiError, json, options } from "@/lib/api/http";
import { READ_CACHE, withApi } from "@/lib/api/route";
import { seriesPageToPublic } from "@/lib/api/serialize";
import { baseUrl } from "@/lib/config";
import { getSeries, seriesPage } from "@/lib/domain/series";

export const dynamic = "force-dynamic";

/** One series: its rhythm, the next edition to sign up for, the past editions with their podiums. */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return withApi(req, "read", async ({ db }) => {
    const s = /^[a-z0-9][a-z0-9-]{0,59}$/.test(slug) ? await getSeries(db, slug) : null;
    if (!s) throw new ApiError(404, "not_found", `No series "${slug}".`, "Series slugs are lower-case with dashes; list them at /api/v1/series.");
    return json(seriesPageToPublic(await seriesPage(db, s), baseUrl()), { cache: READ_CACHE });
  });
}

export async function OPTIONS() {
  return options();
}
