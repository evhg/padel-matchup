import { NextResponse } from "next/server";
import { reportError } from "@/lib/alerts";
import { getDb } from "@/db";
import { setMetric } from "@/lib/domain/metrics";
import { syncAllCoachCalendars } from "@/lib/coach/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Every ten minutes (Supabase pg_cron → pg_net): the coaches' calendars, both ways.
 * Guarded by CRON_SECRET when set. Each coach is one unit of work; a failing one is
 * recorded on the coach and does not stop the others.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (secret && auth !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const now = new Date();
  const db = await getDb();
  let results: Awaited<ReturnType<typeof syncAllCoachCalendars>> = [];
  try {
    results = await syncAllCoachCalendars(db, now);
  } catch (e) {
    void reportError("cron", e, { path: "/api/cron/sync" });
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
  await setMetric(db, "cron_sync_at", Math.floor(now.getTime() / 1000)).catch(() => undefined);
  return NextResponse.json({ ok: true, at: now.toISOString(), coaches: results.length, busy: results.reduce((a, r) => a + r.busy, 0), pushed: results.reduce((a, r) => a + r.pushed, 0), cancelledHere: results.reduce((a, r) => a + r.cancelledHere, 0), errors: results.filter((r) => r.error).map((r) => `${r.coachId}: ${r.error}`) });
}
