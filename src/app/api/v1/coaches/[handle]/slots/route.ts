import { json, options } from "@/lib/api/http";
import { coachSlots } from "@/lib/api/coachOps";
import { READ_CACHE, withApi } from "@/lib/api/route";

export const dynamic = "force-dynamic";

/** Free starts in the coach's hours for the next days (default 14, max 30). */
export async function GET(req: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return withApi(req, "read", async ({ db }) => {
    const days = Number(new URL(req.url).searchParams.get("days") ?? "") || undefined;
    return json(await coachSlots(db, { handle, days }), { cache: READ_CACHE });
  });
}

export async function OPTIONS() {
  return options();
}
