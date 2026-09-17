import { getDb } from "@/db";
import { getSlip } from "@/lib/domain/coaching";
import { getSessionPlayer } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The bank slip a student attached to a lesson. Served to the student who sent it, the coach, and
 * whoever runs the coach's book — and a 404 to everybody else, including a signed-out visitor, so the
 * address gives nothing away.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ handle: string; lessonId: string }> }) {
  const { lessonId } = await params;
  const db = await getDb();
  const me = await getSessionPlayer(db);
  const slip = me ? await getSlip(db, lessonId, me.id) : null;
  if (!slip) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(slip.bytes), { headers: { "content-type": slip.mime, "cache-control": "private, no-store", "x-robots-tag": "noindex" } });
}
