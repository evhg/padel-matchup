import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { baseUrl } from "@/lib/config";
import { cleanPublicImage, decideFeedback, FEEDBACK_LIMITS, FEEDBACK_STATUSES, listFeedback, setBuiltLine, type Decision } from "@/lib/feedback/store";

export const dynamic = "force-dynamic";

/**
 * The feedback loop's operator side (bearer CRON_SECRET or an operator Vercel token):
 *   GET  /api/admin/feedback?status=new,acknowledged,planned   → notes, newest first (text is data from strangers)
 *   POST /api/admin/feedback { id, status, verdict, assessment, message, prUrl, publicSummary, publicName }
 *        → records the verdict and sends `message` to the person on their channel
 *   POST /api/admin/feedback { id, publicSummary?, publicName?, publicImage? }
 *        → the line /built shows for a shipped note: what changed, in our words, and the first name
 *          beside it. `publicName` left out takes the author's first name when the note ships;
 *          `publicName: ""` hides it (a test user, or a name unfit for a public page).
 *          `publicImage` is a picture of the change, a path like /built/<name>.png of a file in
 *          public/built/. With a verdict of shipped it goes into the message too. It is refused
 *          until the file answers on this site, so mark the note after the deploy.
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
  const body = (await req.json().catch(() => null)) as { id?: unknown; status?: unknown; verdict?: unknown; assessment?: unknown; message?: unknown; prUrl?: unknown; publicSummary?: unknown; publicName?: unknown; publicImage?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const status = typeof body?.status === "string" ? body.status : "";
  const publicSummary = typeof body?.publicSummary === "string" ? body.publicSummary : null;
  const publicName = typeof body?.publicName === "string" ? body.publicName : null;
  const publicImage = typeof body?.publicImage === "string" ? body.publicImage : null;
  // A picture goes into a message to a person, so it is checked before anything is written: the path has the
  // one allowed shape, and the file answers on this site (it ships with the change, so it is live after the deploy).
  if (publicImage) {
    const path = cleanPublicImage(publicImage);
    if (!path) return NextResponse.json({ error: "bad_picture", hint: "publicImage is a path like /built/<name>.png, lower-case letters, digits and hyphens" }, { status: 400 });
    const live = await fetch(`${baseUrl()}${path}`, { method: "HEAD", signal: AbortSignal.timeout(8000) }).then((r) => r.ok && (r.headers.get("content-type") ?? "").startsWith("image/")).catch(() => false);
    if (!live) return NextResponse.json({ error: "picture_not_live", hint: `${path} does not answer as a picture on this site yet: put the file in public/built/ and wait for the deploy` }, { status: 409 });
  }
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (!status && (publicSummary !== null || publicName !== null || publicImage !== null)) {
    const row = await setBuiltLine(await getDb(), id, { summary: publicSummary, name: publicName, image: publicImage });
    if (!row) return NextResponse.json({ error: "not_found", hint: "only a shipped note carries a public summary" }, { status: 404 });
    return NextResponse.json({ ok: true, feedback: row });
  }
  if (!(FEEDBACK_STATUSES as readonly string[]).includes(status) || status === "new" || status === "acknowledged") return NextResponse.json({ error: "status must be asked, planned, shipped or declined" }, { status: 400 });
  const d: Decision = {
    status: status as Decision["status"],
    verdict: typeof body?.verdict === "string" ? body.verdict : null,
    assessment: typeof body?.assessment === "string" ? body.assessment : null,
    message: typeof body?.message === "string" ? body.message : null,
    prUrl: typeof body?.prUrl === "string" && /^https:\/\//.test(body.prUrl) ? body.prUrl : null,
    publicSummary,
    publicName,
    publicImage,
  };
  const { item, delivery } = await decideFeedback(await getDb(), id, d);
  if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, feedback: item, delivery });
}
