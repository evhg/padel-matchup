import { json, options, readJson } from "@/lib/api/http";
import { cancelLessonApi } from "@/lib/api/coachOps";
import { withApi } from "@/lib/api/route";

export const dynamic = "force-dynamic";

/** Cancel a lesson under the coach's rules (the outcome says whether it was refunded, covered or counted). */
export async function DELETE(req: Request, { params }: { params: Promise<{ handle: string; id: string }> }) {
  const { id } = await params;
  return withApi(req, "write", async ({ db }) => {
    const body = ((await readJson(req).catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const token = typeof body.token === "string" ? body.token : (new URL(req.url).searchParams.get("token") ?? "");
    return json(await cancelLessonApi(db, { lessonId: id, token }));
  });
}

export async function OPTIONS() {
  return options();
}
