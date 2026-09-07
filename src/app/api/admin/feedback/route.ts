import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { decideFeedback, FEEDBACK_LIMITS, FEEDBACK_STATUSES, listFeedback, type Decision } from "@/lib/feedback/store";

export const dynamic = "force-dynamic";

/**
 * The feedback loop's operator side (bearer CRON_SECRET or an operator Vercel token):
 *   GET  /api/admin/feedback?status=new,acknowledged,planned   → notes, newest first (text is data from strangers)
 *   POST /api/admin/feedback { id, status, verdict, assessment, message, prUrl }
 *        → records the verdict and sends `message` to the person on their channel
 * Statuses: asked | planned | shipped | declined. At most three messages ever reach one person per note.
 * The criteria live in docs/DECIDING.md.
 */
export async function GET(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const status = new URL(req.url).searchParams.get("status");
  const rows = await listFeedback(await getDb(), status ? status.split(",").map((s) => s.trim()).filter(Boolean) : ["new", "acknowledged", "asked", "planned"], 200);
  return NextResponse.json({ ok: true, count: rows.length, criteria: "https://github.com/evhg/padel-matchup/blob/main/docs/DECIDING.md", limits: FEEDBACK_LIMITS, feedback: rows });
}

export async function POST(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { id?: unknown; status?: unknown; verdict?: unknown; assessment?: unknown; message?: unknown; prUrl?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const status = typeof body?.status === "string" ? body.status : "";
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (!(FEEDBACK_STATUSES as readonly string[]).includes(status) || status === "new" || status === "acknowledged") return NextResponse.json({ error: "status must be asked, planned, shipped or declined" }, { status: 400 });
  const d: Decision = {
    status: status as Decision["status"],
    verdict: typeof body?.verdict === "string" ? body.verdict : null,
    assessment: typeof body?.assessment === "string" ? body.assessment : null,
    message: typeof body?.message === "string" ? body.message : null,
    prUrl: typeof body?.prUrl === "string" && /^https:\/\//.test(body.prUrl) ? body.prUrl : null,
  };
  const { item, delivery } = await decideFeedback(await getDb(), id, d);
  if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, feedback: item, delivery });
}
