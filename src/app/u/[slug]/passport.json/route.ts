import { getDb } from "@/db";
import { ApiError, json, options } from "@/lib/api/http";
import { READ_CACHE, withApi } from "@/lib/api/route";
import { baseUrl } from "@/lib/config";
import { getPublicPlayer, issuePassport, profileStats } from "@/lib/domain/profile";

export const dynamic = "force-dynamic";

/** The signed level document of a public profile. Verify with the key at /.well-known/kicksmash-passport.json. */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return withApi(req, "read", async () => {
    const db = await getDb();
    const p = await getPublicPlayer(db, slug);
    if (!p) throw new ApiError(404, "not_found", "No public profile with this address.", "Players switch their page on under My matches → Passport; until then nothing is public.");
    const stats = await profileStats(db, p);
    return json(await issuePassport(p, stats, baseUrl()), { cache: READ_CACHE });
  });
}

export async function OPTIONS() {
  return options();
}
