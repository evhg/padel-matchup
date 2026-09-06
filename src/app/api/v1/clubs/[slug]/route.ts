import { ApiError, json, options } from "@/lib/api/http";
import { READ_CACHE, withApi } from "@/lib/api/route";
import { clubToPublic } from "@/lib/api/serialize";
import { baseUrl } from "@/lib/config";
import { getLiveClub } from "@/lib/domain/clubs";
import { isValidVenueSlug, venueSlug } from "@/lib/domain/venueBoard";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug: raw } = await params;
  return withApi(req, "read", async ({ db }) => {
    const slug = isValidVenueSlug(raw) ? raw : venueSlug(decodeURIComponent(raw));
    const club = slug ? await getLiveClub(db, slug) : null;
    if (!club) throw new ApiError(404, "not_found", `No club page "${raw}" is live on Kicksmash.`, "Clubs claim their page at /clubs/claim; the board at /api/v1/boards/{slug} exists for any venue with a match.");
    return json(clubToPublic(club, baseUrl()), { cache: READ_CACHE });
  });
}

export async function OPTIONS() {
  return options();
}
