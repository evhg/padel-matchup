import { json, options } from "@/lib/api/http";
import { loadCoach, publicCoach } from "@/lib/api/coachOps";
import { READ_CACHE, withApi } from "@/lib/api/route";

export const dynamic = "force-dynamic";

/** One coach with their next free starts. */
export async function GET(req: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return withApi(req, "read", async ({ db }) => {
    const coach = await loadCoach(db, handle);
    return json(await publicCoach(db, coach, true), { cache: READ_CACHE });
  });
}

export async function OPTIONS() {
  return options();
}
