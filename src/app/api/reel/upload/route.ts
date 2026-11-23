import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { passportKeys } from "@/lib/config";
import { later } from "@/lib/alerts";
import { readUploadTicket, reelUploadReceived } from "@/lib/domain/matchReel";
import { tellOwnerVideoHere } from "@/lib/reelNotice";

export const dynamic = "force-dynamic";

/**
 * The reel host says "the film of this upload is joined" (`assemble` in `scripts/highlights/modal/serve.py`).
 *
 *   POST /api/reel/upload   { "ticket": "<the ticket the browser sent the parts with>" }
 *
 * The ticket is the proof: Kicksmash signed it for one upload, so nobody can call this for a match
 * without a ticket of that match, and the signature is checked before the database is asked anything.
 * The row goes from asked to received, and the owner hears it once. A second call changes nothing.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { ticket?: unknown } | null;
  const keys = passportKeys();
  const token = keys ? await readUploadTicket(body?.ticket, keys.pub, new Date()) : null;
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const code = await reelUploadReceived(await getDb(), token);
  if (code) {
    await later(() => tellOwnerVideoHere(code, "upload"));
    revalidatePath(`/${code}`);
  }
  return NextResponse.json({ ok: true, changed: Boolean(code) });
}
