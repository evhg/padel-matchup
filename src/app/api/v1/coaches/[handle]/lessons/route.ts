import { json, options, readJson } from "@/lib/api/http";
import { bookLessonApi } from "@/lib/api/coachOps";
import { withApi } from "@/lib/api/route";

export const dynamic = "force-dynamic";

/** Book a lesson at one of the coach's free starts, as an accepted student (personal token). */
export async function POST(req: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return withApi(req, "write", async ({ db }) => {
    const body = (await readJson(req)) as Record<string, unknown>;
    return json(await bookLessonApi(db, { ...body, handle }), { status: 201 });
  });
}

export async function OPTIONS() {
  return options();
}
