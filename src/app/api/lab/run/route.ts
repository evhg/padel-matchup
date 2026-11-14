import { NextResponse } from "next/server";
import { after } from "next/server";
import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { labRuns } from "@/db/schema";
import { clientKey } from "@/lib/api/http";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";
import { LAB_PICTURE_KEEP_DAYS, LAB_PICTURES_MAX, LAB_RUNS_KEEP_DAYS, LAB_STAGES, isJpegBase64 } from "@/lib/domain/lab";

export const dynamic = "force-dynamic";

/** A report of numbers is about 60 KB for a 90-minute match with every hit; a picture (stage `pic`), one 1080p JPEG, about 600 KB. */
const MAX_BYTES = 1_000_000;

/**
 * POST /api/lab/run { id, page, stage, data }: the Rally Finder lab page reports a run by itself, at
 * the end of each stage (src/db/schema/ops.ts, `labRuns`), and sends a few still frames as stage `pic`
 * (src/lib/domain/lab.ts says why and for how long). No sign-in, like the page; an address may send
 * LIMITS.labRunsPerIpPerDay, and a report is at most MAX_BYTES. The same `id` replaces its row.
 */
export async function POST(req: Request) {
  const raw = await req.text().catch(() => "");
  if (!raw || raw.length > MAX_BYTES) return NextResponse.json({ ok: false, error: "size" }, { status: 413 });
  let body: { id?: unknown; page?: unknown; stage?: unknown; data?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "json" }, { status: 400 });
  }
  const id = typeof body.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.id) ? body.id : null;
  const page = typeof body.page === "string" && body.page.startsWith("rally-finder ") ? body.page.slice(0, 60) : null;
  const stage = typeof body.stage === "string" && LAB_STAGES.has(body.stage) ? body.stage : null;
  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? (body.data as Record<string, unknown>) : null;
  if (!id || !page || !stage || !data) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  // A picture is a JPEG and nothing else: never a video, never another file.
  if (stage === "pic" && !isJpegBase64(data.jpeg)) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  const db = await getDb();
  if (!(await takeRate(db, "labrun", clientKey(req), LIMITS.labRunsPerIpPerDay))) return NextResponse.json({ ok: false, error: "rate" }, { status: 429 });
  await db
    .insert(labRuns)
    .values({ id, page, stage, data })
    .onConflictDoUpdate({ target: labRuns.id, set: { page, stage, data, updatedAt: sql`now()` } });
  // Old runs go, after the answer: one indexed delete, nearly always of nothing. Pictures go sooner,
  // and only the newest LAB_PICTURES_MAX stay, so they hold at most about 60 MB whatever happens.
  after(async () => {
    await db.delete(labRuns).where(lt(labRuns.createdAt, sql`now() - (${LAB_RUNS_KEEP_DAYS} * interval '1 day')`)).catch(() => undefined);
    if (stage !== "pic") return;
    await db.delete(labRuns).where(and(eq(labRuns.stage, "pic"), lt(labRuns.createdAt, sql`now() - (${LAB_PICTURE_KEEP_DAYS} * interval '1 day')`))).catch(() => undefined);
    await db
      .execute(sql`delete from lab_runs where id in (select id from lab_runs where stage = 'pic' order by created_at desc offset ${LAB_PICTURES_MAX})`)
      .catch(() => undefined);
  });
  return NextResponse.json({ ok: true });
}
