import { getDb } from "@/db";
import { getCoachByHandle, getCoachPhoto } from "@/lib/domain/coaching";

export const dynamic = "force-dynamic";

/** The coach's own photo. Public: it is on their public page and on every directory card. */
export async function GET(_req: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const db = await getDb();
  const coach = await getCoachByHandle(db, handle.toLowerCase());
  const photo = coach ? await getCoachPhoto(db, coach.id) : null;
  if (!photo) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(photo.bytes), { headers: { "content-type": photo.mime, "cache-control": "public, max-age=600" } });
}
