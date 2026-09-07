import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { reportError } from "@/lib/alerts";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";

export const dynamic = "force-dynamic";

/** The error boundary posts here: message, digest and path are kept as one fingerprint row for the daily fixer; nothing personal. */
export async function POST(req: Request) {
  try {
    const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim().slice(0, 64);
    const db = await getDb();
    if (!(await takeRate(db, "clienterr", ip, LIMITS.clientErrorReportsPerIpPerDay))) return NextResponse.json({ ok: false }, { status: 429 });
    const body = (await req.json().catch(() => ({}))) as { digest?: unknown; message?: unknown; path?: unknown };
    const message = String(typeof body.message === "string" ? body.message : "").slice(0, 200).trim() || "client error";
    const digest = String(typeof body.digest === "string" ? body.digest : "").slice(0, 64);
    const path = typeof body.path === "string" && body.path.startsWith("/") ? body.path.slice(0, 200) : null;
    console.warn("[client-error]", digest, message, path ?? "");
    await reportError("client", { message, stack: null }, { path, digest });
  } catch {
    /* ignore */
  }
  return NextResponse.json({ ok: true });
}
