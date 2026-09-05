import { ApiError, json, options } from "@/lib/api/http";
import { READ_CACHE, withApi } from "@/lib/api/route";
import { boardToPublic } from "@/lib/api/serialize";
import { baseUrl } from "@/lib/config";
import { getVenueBoard, isValidVenueSlug, venueSlug } from "@/lib/domain/venueBoard";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug: raw } = await params;
  return withApi(req, "read", async ({ db }) => {
    const slug = isValidVenueSlug(raw) ? raw : venueSlug(decodeURIComponent(raw));
    const board = slug ? await getVenueBoard(db, slug) : null;
    if (!board) throw new ApiError(404, "not_found", `No venue "${raw}" has been used on Kicksmash yet.`, "A venue's board exists once any match was created there. Slugs are lower-case with dashes; a plain name works too.");
    return json(boardToPublic(board, baseUrl()), { cache: READ_CACHE });
  });
}

export async function OPTIONS() {
  return options();
}
