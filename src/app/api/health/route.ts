import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { baseUrl, emailEnabled, emailFrom } from "@/lib/config";
import { databaseSource, onVercel, sessionSecretSource } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Plain-language setup check. Safe to share: never returns secrets.
 * Open https://kicksma.sh/api/health after deploying.
 */
export async function GET() {
  const source = databaseSource();
  let database: "connected" | "error" | "missing" | "embedded" = source === "missing" ? "missing" : source === "embedded" ? "embedded" : "error";
  let databaseError: string | null = null;
  if (source !== "missing") {
    try {
      const db = await getDb();
      await db.execute(sql`select 1`);
      database = source === "embedded" ? "embedded" : "connected";
    } catch (e) {
      database = "error";
      databaseError = e instanceof Error ? e.message : String(e);
    }
  }
  const placeholderLeft = /\[YOUR-PASSWORD\]/.test(process.env.DATABASE_URL ?? "") && !process.env.DATABASE_PASSWORD;

  const hints: string[] = [];
  if (database === "missing") hints.push("Add DATABASE_URL in Vercel → Project → Settings → Environment Variables, then Deployments → Redeploy.");
  if (placeholderLeft) hints.push("DATABASE_URL still contains [YOUR-PASSWORD]. Either replace it, or add a DATABASE_PASSWORD variable and redeploy.");
  if (database === "error") hints.push("The database URL is set but the connection failed. Check the password and that the host ends with pooler.supabase.com:6543.");
  if (database === "embedded" && onVercel()) hints.push("Embedded database cannot run on Vercel. Set DATABASE_URL.");
  if (!emailEnabled()) hints.push("Email is off (no RESEND_API_KEY). Everything else works; add it later for calendar invites and notifications.");
  if (!process.env.CRON_SECRET) hints.push("CRON_SECRET is not set; the cron endpoint is unauthenticated but harmless. Set it when convenient.");

  const ok = database === "connected" || (database === "embedded" && !onVercel());
  return NextResponse.json(
    {
      ok,
      database,
      databaseSource: source,
      databaseError,
      sessionSecret: sessionSecretSource(),
      cronSecret: process.env.CRON_SECRET ? "set" : "missing",
      email: emailEnabled() ? "enabled" : "disabled",
      emailFrom: emailEnabled() ? emailFrom() : null,
      baseUrl: baseUrl(),
      hints,
    },
    { status: ok ? 200 : 503 },
  );
}
