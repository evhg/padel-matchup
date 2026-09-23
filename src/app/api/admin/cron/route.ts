import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { baseUrl } from "@/lib/config";
import { cronAvailable, listCronJobs, scheduleCronJobs, storeCronSecret } from "@/lib/ops/cronJobs";
import { refusalOf } from "@/lib/db/readonly";

export const dynamic = "force-dynamic";

/**
 * The scheduled jobs, from the operator's side (src/lib/ops/cronJobs.ts has the why).
 *
 *   GET  /api/admin/cron   the jobs that call the app and how each one's last run went
 *   POST /api/admin/cron   store the app's own CRON_SECRET in Vault and schedule the three jobs
 *   Authorization: Bearer $CRON_SECRET
 *
 * POST is for two moments: a database that never had the jobs, and the day CRON_SECRET changes on
 * Vercel. The secret travels from the app's environment to Vault inside the database connection;
 * nobody types it, and no answer carries it.
 */
export async function GET(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = await getDb();
  if (!(await cronAvailable(db))) return NextResponse.json({ ok: false, error: "pg_cron, pg_net or Vault is not installed on this database" }, { status: 409 });
  return NextResponse.json({ ok: true, jobs: await listCronJobs(db) });
}

export async function POST(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: "CRON_SECRET is not set on this deployment, so there is nothing for the jobs to send" }, { status: 409 });
  const db = await getDb();
  if (!(await cronAvailable(db))) return NextResponse.json({ ok: false, error: "pg_cron, pg_net or Vault is not installed on this database" }, { status: 409 });
  try {
    const secretStored = await storeCronSecret(db, secret);
    await scheduleCronJobs(db, baseUrl());
    return NextResponse.json({ ok: true, secret: secretStored, jobs: await listCronJobs(db) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: refusalOf(e) }, { status: 500 });
  }
}
