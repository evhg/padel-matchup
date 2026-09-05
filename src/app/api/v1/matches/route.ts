import { json, options, readJson } from "@/lib/api/http";
import { createMatch } from "@/lib/api/operations";
import { withApi } from "@/lib/api/route";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return withApi(req, "write", async ({ db, ops }) => json(await createMatch(db, await readJson(req), ops), { status: 201 }));
}

export async function OPTIONS() {
  return options();
}
