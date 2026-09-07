import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { createDraft, DeskError, listOutreach, type DraftInput } from "@/lib/outreach/desk";

export const dynamic = "force-dynamic";

/**
 * The operator's side of the press desk (bearer CRON_SECRET):
 *   GET  /api/admin/outreach?status=draft,sent      → rows, newest first
 *   POST /api/admin/outreach { drafts: [{ to, name, org, subject, body, moment, notBefore }] } → queued for the owner's tap
 * Nothing here sends anything; only the owner's tap does.
 */
export async function GET(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const status = new URL(req.url).searchParams.get("status");
  const rows = await listOutreach(await getDb(), status ? status.split(",").map((s) => s.trim()).filter(Boolean) : undefined, 200);
  return NextResponse.json({ ok: true, count: rows.length, rows });
}

export async function POST(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { drafts?: unknown } | null;
  const drafts = Array.isArray(body?.drafts) ? (body!.drafts as Record<string, unknown>[]) : [];
  if (drafts.length === 0 || drafts.length > 50) return NextResponse.json({ error: "drafts: 1..50 required" }, { status: 400 });
  const db = await getDb();
  const out: { id?: string; to: string; error?: string }[] = [];
  for (const d of drafts) {
    const input: DraftInput = {
      to: String(d.to ?? ""),
      name: typeof d.name === "string" ? d.name : null,
      org: typeof d.org === "string" ? d.org : null,
      subject: String(d.subject ?? ""),
      body: String(d.body ?? ""),
      moment: typeof d.moment === "string" ? d.moment : null,
      notBefore: typeof d.notBefore === "string" && !Number.isNaN(Date.parse(d.notBefore)) ? new Date(d.notBefore) : null,
    };
    try {
      const row = await createDraft(db, input);
      out.push({ id: row.id, to: row.counterpartEmail });
    } catch (e) {
      out.push({ to: input.to, error: e instanceof DeskError ? e.message : "failed" });
    }
  }
  return NextResponse.json({ ok: out.every((o) => o.id), drafts: out }, { status: out.every((o) => o.id) ? 201 : 207 });
}
