import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { screenshotOf } from "@/lib/feedback/store";

export const dynamic = "force-dynamic";

/**
 * The screenshot a person sent with a note, for the operator and the note desk. Bearer CRON_SECRET.
 *   GET /api/admin/feedback/screenshot?id=<note id>   → the picture itself
 */
export async function GET(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  const shot = await screenshotOf(await getDb(), id);
  if (!shot) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return new Response(new Uint8Array(shot.bytes), { headers: { "Content-Type": shot.mime, "Cache-Control": "private, no-store" } });
}
