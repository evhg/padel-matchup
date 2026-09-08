import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { serviceBoard } from "@/lib/ops/services";

export const dynamic = "force-dynamic";

/** GET /api/admin/services → the service board as JSON, for the daily session and the owner's page. Bearer CRON_SECRET. */
export async function GET(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const board = await serviceBoard(await getDb());
  return NextResponse.json({ ok: true, ...board });
}
