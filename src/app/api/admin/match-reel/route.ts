import { after, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { DomainError } from "@/lib/domain/errors";
import { readReelReport, removeMatchReel, setMatchReel, setReelProgress } from "@/lib/domain/matchReel";
import { passportKeys } from "@/lib/config";
import { notifyReelReady } from "@/lib/notify";
import { events } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * The reel of a filmed match is on the store: show it on the match page. Bearer CRON_SECRET.
 *
 *   POST   /api/admin/match-reel   { "code": "AB12", "host": "https://<the reel host>", "token": "<the reel's token>" }
 *   POST   /api/admin/match-reel   { "code": "AB12", "progress": { "pct": 40, "minutesLeft": 12, "step": "follow" } }
 *          step is one of clips, players, follow, replays, opening, music, finish (REEL_STEPS).
 *          The reel's maker reports its progress: the page shows a bar and the minutes left, and a reel
 *          that was shown goes off the page until the next POST with host and token (`setReelProgress`).
 *   DELETE /api/admin/match-reel   { "code": "AB12" }
 *
 * Two keys open it: the operator's (Bearer CRON_SECRET), and the report key of a fast reel's job (`signReelReport`),
 * for the codes it was signed for alone, and for POST alone. While the job waits for who is who, progress also
 * carries "waiting": "names", "host" and "upload", and the page asks the players.
 *
 * The files are `{host}/r/{token}/tall.mp4` and `wide.mp4` (`scripts/highlights/modal/serve.py`). The
 * players of the match see the reel for 30 days. A second POST replaces the first. The first reel a
 * match ever shows goes to every player of the match, once (`notifyReelReady`, after the answer); a new
 * cut of it is not announced. The answer never repeats the token.
 */
/**
 * The report key of a fast reel's job opens this route for the codes it names, and nothing else. A key that is a
 * report key is judged by that alone, so it is never sent on to the operator check (which asks Vercel).
 */
async function reportSays(req: Request, code: string): Promise<"yes" | "no" | "not_a_report"> {
  const keys = passportKeys();
  const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const codes = keys && key.includes(".") ? await readReelReport(key, keys.pub, new Date()) : null;
  if (!codes) return "not_a_report";
  return code && codes.includes(code) ? "yes" : "no";
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const code = typeof body?.code === "string" ? body.code : "";
  const report = await reportSays(req, code);
  if (report === "no" || (report === "not_a_report" && !(await operatorAuthorized(req)))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    if (body?.progress && typeof body.progress === "object") {
      const p = body.progress as Record<string, unknown>;
      await setReelProgress(await getDb(), { code, pct: p.pct, minutesLeft: p.minutesLeft, step: p.step, waiting: p.waiting, host: p.host, upload: p.upload });
      revalidatePath(`/${code}`);
      return NextResponse.json({ ok: true, working: true });
    }
    const db = await getDb();
    const res = await setMatchReel(db, { code, host: body?.host, token: body?.token });
    revalidatePath(`/${code}`);
    if (res.first)
      after(async () => {
        const [ev] = await db.select().from(events).where(eq(events.id, res.eventId)).limit(1);
        if (ev) await notifyReelReady(db, ev).catch((e) => console.error("reel ready notice", e));
      });
    return NextResponse.json({ ok: true, replaced: res.replaced, told: res.first });
  } catch (e) {
    if (e instanceof DomainError && e.code === "not_found") return NextResponse.json({ error: "not_found", hint: "No match has this code, or it was cancelled." }, { status: 404 });
    if (e instanceof DomainError) return NextResponse.json({ error: e.code, detail: e.message, hint: "code (a match that has started), host (https, no path), token (22 to 64 of A-Z a-z 0-9 _ -)" }, { status: 400 });
    throw e;
  }
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
