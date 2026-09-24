import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { DISPOSABLE_AFTER_DAYS, findDisposablePlayers } from "@/lib/domain/disposable";

export const dynamic = "force-dynamic";

/**
 * The player rows the daily cleanup would remove today. It reads only; the hourly job does the
 * removing, once a day (`removeDisposableDaily`), and nothing else can.
 *
 *   GET /api/admin/disposable
 *   Authorization: Bearer $CRON_SECRET
 */
export async function GET(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await findDisposablePlayers(await getDb());
  return NextResponse.json({ afterDays: DISPOSABLE_AFTER_DAYS, count: rows.length, players: rows.map((r) => ({ id: r.id, name: r.displayName, createdAt: r.createdAt.toISOString() })) });
}
