import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { takeRate } from "@/lib/domain/ratelimit";
import { exportPlayerData } from "@/lib/domain/profile";
import { getSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";

/** One file with everything we hold about the signed-in player. Tokens and manage links stay out: this file gets shared. */
export async function GET() {
  const db = await getDb();
  const me = await getSessionPlayer(db);
  if (!me) return Response.json({ error: { code: "no_identity", message: "Open My matches first; the export is for the signed-in player." } }, { status: 401 });
  if (!(await takeRate(db, "export", me.id, 10, "day"))) return Response.json({ error: { code: "too_many", message: "Ten exports a day is plenty. Try again tomorrow." } }, { status: 429 });
  const data = await exportPlayerData(db, me, baseUrl());
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="kicksmash-${me.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "player"}.json"`, "cache-control": "no-store" },
  });
}
