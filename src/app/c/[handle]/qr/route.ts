import { getDb } from "@/db";
import { getCoachByHandle, getCoachQr } from "@/lib/domain/coaching";

export const dynamic = "force-dynamic";

/** The coach's own payment QR picture, as they uploaded it. Shown to their students only through the pages that need it. */
export async function GET(_req: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const db = await getDb();
  const coach = await getCoachByHandle(db, handle.toLowerCase());
  const qr = coach ? await getCoachQr(db, coach.id) : null;
  if (!qr) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(qr.bytes), { headers: { "content-type": qr.mime, "cache-control": "private, max-age=300", "x-robots-tag": "noindex" } });
}
