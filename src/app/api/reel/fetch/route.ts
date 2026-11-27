import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { passportKeys } from "@/lib/config";
import { later } from "@/lib/alerts";
import { readUploadTicket, reelFetchFailed, setReelFetch } from "@/lib/domain/matchReel";
import { startMinutes } from "@/lib/domain/fastReelStart";
import { tellOwnerReelFailed } from "@/lib/reelNotice";

export const dynamic = "force-dynamic";

/**
 * The reel host reports its fetch of a player's Drive link (`fetch_link` in `scripts/highlights/modal/serve.py`):
 *
 *   POST /api/reel/fetch   { "ticket": "<the link's upload ticket>", "pct": 40, "minutesLeft": 6 }
 *   POST /api/reel/fetch   { "ticket": "...", "failed": true }
 *
 * The ticket is the proof, as for `/api/reel/upload`: it is checked before the database is asked anything. `minutesLeft`
 * is the fetch's own; the bar shows it with the job's minutes after it, so the time on the page is the time to the reel.
 * When the film is here, the reel host calls `/api/reel/upload` with the same ticket, and the job starts as for an upload.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { ticket?: unknown; pct?: unknown; minutesLeft?: unknown; failed?: unknown } | null;
  const keys = passportKeys();
  const token = keys ? await readUploadTicket(body?.ticket, keys.pub, new Date()) : null;
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = await getDb();
  if (body?.failed === true) {
    const got = await reelFetchFailed(db, token);
    if (got) {
      await later(() => tellOwnerReelFailed(got.code, "the link did not give the film"));
      revalidatePath(`/${got.code}`);
    }
    return NextResponse.json({ ok: true, changed: Boolean(got) });
  }
  const left = Number(body?.minutesLeft);
  if (!Number.isFinite(left) || left < 0) return NextResponse.json({ error: "invalid" }, { status: 400 });
  try {
    const got = await setReelFetch(db, token, { pct: body?.pct, minutesLeft: left + startMinutes({ whole: true }) });
    return NextResponse.json({ ok: true, changed: Boolean(got) });
  } catch {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
}
