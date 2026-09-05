import { json, options, readJson } from "@/lib/api/http";
import { joinMatch } from "@/lib/api/operations";
import { withApi } from "@/lib/api/route";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return withApi(req, "write", async ({ db, ops }) => {
    const body = (await readJson(req)) as Record<string, unknown>;
    return json(await joinMatch(db, { ...body, code }, ops));
  });
}

export async function OPTIONS() {
  return options();
}
