import { wakeNoteDesk } from "@/lib/feedback/desk";
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { passportKeys } from "@/lib/config";
import { later } from "@/lib/alerts";
import { readUploadTicket, reelUploadReceived, setReelProgress } from "@/lib/domain/matchReel";
import { tellOwnerVideoHere } from "@/lib/reelNotice";
import { fastReelStart } from "@/lib/domain/fastReelStart";

export const dynamic = "force-dynamic";

/**
 * The reel host says "the film of this upload is joined" (`assemble` in `scripts/highlights/modal/serve.py`).
 *
 *   POST /api/reel/upload   { "ticket": "<the ticket the browser sent the parts with>" }
 *
 * The ticket is the proof: Kicksmash signed it for one upload, so nobody can call this for a match
 * without a ticket of that match, and the signature is checked before the database is asked anything.
 * The row goes from asked to received, and the owner hears it once. A second call changes nothing.
 *
 * For the clips of a fast reel the answer carries `fastReel`, the job's start request (`fastReelStart`), and the
 * reel host starts the job at once: no person makes it. A whole film, or clips that make no start (no two pairs),
 * wake the note desk instead, where a session makes the reel.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { ticket?: unknown } | null;
  const keys = passportKeys();
  const token = keys ? await readUploadTicket(body?.ticket, keys.pub, new Date()) : null;
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = await getDb();
  const got = await reelUploadReceived(db, token);
  const start = got?.way === "clips" && keys ? await fastReelStart(db, got.code, keys, new Date()) : null;
  // The bar shows at once: the job's own first report comes when the clips are cleaned, minutes later. 25 minutes
  // is the job's own first estimate (`Report(req, 25)` in fastreel.py; the dry run of 24 November 2026 took 19).
  if (start) await setReelProgress(db, { code: got!.code, pct: 0, minutesLeft: 25, step: "clips" }).catch(() => undefined);
  if (got) {
    await later(() => tellOwnerVideoHere(got.code, got.way));
    // A session makes the reel at once (the owner, 24 November 2026: clips waited three hours for a person). The
    // fast reel's job wakes nobody: if it stops, the row stays "received" and the hourly wake finds it.
    if (!start) await later(() => wakeNoteDesk(db, `a match ${got.way === "clips" ? "video's clips are" : "video is"} here (${got.code}); make its reel`));
    revalidatePath(`/${got.code}`);
  }
  return NextResponse.json({ ok: true, changed: Boolean(got), ...(start ? { fastReel: start } : {}) });
}
