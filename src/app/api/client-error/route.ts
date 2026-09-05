import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { reportError } from "@/lib/alerts";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";

export const dynamic = "force-dynamic";

/** The error boundary posts here so client crashes show up on /admin. No payload is stored. */
export async function POST(req: Request) {
  try {
    const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim().slice(0, 64);
    const db = await getDb();
    if (!(await takeRate(db, "clienterr", ip, LIMITS.clientErrorReportsPerIpPerDay))) return NextResponse.json({ ok: false }, { status: 429 });
    const body = (await req.json().catch(() => ({}))) as { digest?: string; message?: string };
    console.warn("[client-error]", String(body.digest ?? "").slice(0, 64), String(body.message ?? "").slice(0, 200));
    await reportError("client");
  } catch {
    /* ignore */
  }
  return NextResponse.json({ ok: true });
}
