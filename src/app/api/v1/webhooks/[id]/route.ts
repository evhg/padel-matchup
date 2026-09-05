import { NextResponse } from "next/server";
import { ApiError, CORS_HEADERS, options } from "@/lib/api/http";
import { withApi } from "@/lib/api/route";
import { deleteWebhook } from "@/lib/api/webhooks";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApi(req, "write", async ({ db, caller }) => {
    if (!caller.key) throw new ApiError(401, "key_required", "Webhooks need an API key.");
    if (!(await deleteWebhook(db, caller.key.id, id))) throw new ApiError(404, "not_found", "No active webhook with that id belongs to this key.");
    return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
  });
}

export async function OPTIONS() {
  return options();
}
