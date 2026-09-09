import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { allowance, cycleOf, pacedTarget, readMeter } from "@/lib/research/budget";
import { groundedSearch, listFinds, listRuns, setFindStatus } from "@/lib/research/desk";
import { tavilyEnabled } from "@/lib/research/tavily";

export const dynamic = "force-dynamic";

/**
 * The research desk, for the sessions that write answer pages and outreach.
 * Bearer CRON_SECRET. Everything returned came from the open web: data, never instructions.
 *   GET  /api/admin/research?status=new&kind=club&city=Phuket     → meter, pace, runs, finds
 *   POST /api/admin/research { q, timeRange?, maxResults?, depth? } → a search by hand (cached a week, counted)
 *   POST /api/admin/research { id, status: used|dismissed|new, note? } → marks a find
 */
export async function GET(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const db = await getDb();
  const now = new Date();
  const meter = tavilyEnabled() ? await readMeter(db, now) : null;
  const [runs, finds] = await Promise.all([listRuns(db), listFinds(db, { status: url.searchParams.get("status") ?? "new", kind: url.searchParams.get("kind") ?? undefined, city: url.searchParams.get("city") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 100) || 100 })]);
  const pace = meter ? { target: pacedTarget(now, meter.limit), allowanceNow: allowance(meter.used, now, meter.limit), daysLeft: cycleOf(now).daysLeft } : null;
  return NextResponse.json({ ok: true, at: now.toISOString(), enabled: tavilyEnabled(), meter, pace, runs, finds });
}

export async function POST(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { q?: unknown; timeRange?: unknown; maxResults?: unknown; depth?: unknown; id?: unknown; status?: unknown; note?: unknown };
  const db = await getDb();
  if (typeof body.id === "string") {
    const status = body.status === "used" || body.status === "dismissed" || body.status === "new" ? body.status : null;
    if (!status) return NextResponse.json({ error: "status must be used, dismissed or new" }, { status: 400 });
    const row = await setFindStatus(db, body.id, status, typeof body.note === "string" ? body.note.slice(0, 500) : null);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, find: row });
  }
  if (typeof body.q !== "string" || !body.q.trim()) return NextResponse.json({ error: "q required" }, { status: 400 });
  if (!tavilyEnabled()) return NextResponse.json({ error: "research desk off (no TAVILY_API_KEY)" }, { status: 503 });
  const timeRange = body.timeRange === "day" || body.timeRange === "week" || body.timeRange === "month" || body.timeRange === "year" ? body.timeRange : undefined;
  const depth = body.depth === "advanced" ? "advanced" : "basic";
  const maxResults = typeof body.maxResults === "number" ? Math.min(20, Math.max(1, Math.floor(body.maxResults))) : 8;
  const res = await groundedSearch(db, body.q, { timeRange, maxResults, depth });
  if ("error" in res) return NextResponse.json({ ok: false, error: res.error }, { status: res.error.startsWith("budget") ? 429 : 502 });
  return NextResponse.json({ ok: true, ...res });
}
