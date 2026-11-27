import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { DomainError } from "@/lib/domain/errors";
import { removeMatchReel } from "@/lib/domain/matchReel";
import { postMatchReel } from "@/lib/api/matchReelPost";

export const dynamic = "force-dynamic";

/**
 * The reel of a filmed match is on the store: show it on the match page. Bearer CRON_SECRET.
 *
 *   POST   /api/admin/match-reel   { "code": "AB12", "host": "https://<the reel host>", "token": "<the reel's token>" }
 *          Optional: "noScore" (NO_SCORE_WHY) and "missing": ["few_points", ...] (MISSING_CODES), what the reel
 *          could not do; the match page shows a row for each code under the reel.
 *   POST   /api/admin/match-reel   { "code": "AB12", "progress": { "pct": 40, "minutesLeft": 12, "step": "follow" } }
 *          step is one of clips, players, follow, replays, opening, music, finish (REEL_STEPS).
 *          The reel's maker reports its progress: the page shows a bar and the minutes left, and a reel
 *          that was shown goes off the page until the next POST with host and token (`setReelProgress`).
 *          While a fast reel's job waits for who is who, progress also carries "waiting": "names", "host" and
 *          "upload", and the page asks the players.
 *   DELETE /api/admin/match-reel   { "code": "AB12" }
 *
 * The fast reel's job posts the same to `/api/reel/report` with its report key instead (`postMatchReel` is the
 * one handler of both). The files are `{host}/r/{token}/tall.mp4` and `wide.mp4` (`scripts/highlights/modal/serve.py`).
 * The players of the match see the reel for 30 days. A second POST replaces the first. The first reel a match ever
 * shows goes to every player of the match, once (`notifyReelReady`, after the answer); a new cut of it is not
 * announced. The answer never repeats the token.
 */
export async function POST(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  return postMatchReel(body);
}

export async function DELETE(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const code = typeof body?.code === "string" ? body.code : "";
  try {
    const removed = await removeMatchReel(await getDb(), code);
    revalidatePath(`/${code}`);
    return NextResponse.json({ ok: true, removed });
  } catch (e) {
    if (e instanceof DomainError) return NextResponse.json({ error: e.code }, { status: e.code === "not_found" ? 404 : 400 });
    throw e;
  }
}
