import { json, options, readJson } from "@/lib/api/http";
import { requestCoach } from "@/lib/api/coachOps";
import { withApi } from "@/lib/api/route";

export const dynamic = "force-dynamic";

/** Ask to become the coach's student, by name or personal token. The coach answers with one tap. */
export async function POST(req: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return withApi(req, "write", async ({ db }) => {
    const body = (await readJson(req)) as Record<string, unknown>;
    return json(await requestCoach(db, { ...body, handle }), { status: 201 });
  });
}

export async function OPTIONS() {
  return options();
}
