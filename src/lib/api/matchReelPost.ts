import { after, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { DomainError } from "@/lib/domain/errors";
import { setMatchReel, setReelFailed, setReelProgress } from "@/lib/domain/matchReel";
import { wakeNoteDesk } from "@/lib/feedback/desk";
import { later } from "@/lib/alerts";
import { notifyReelReady } from "@/lib/notify";

/**
 * A reel's maker reports: its progress, or the finished reel. The one handler of the operator's door
 * (`/api/admin/match-reel`) and of the fast reel job's door (`/api/reel/report`); each door checks its own key first.
 */
export async function postMatchReel(body: Record<string, unknown> | null): Promise<NextResponse> {
  const code = typeof body?.code === "string" ? body.code : "";
  try {
    const db = await getDb();
    // The maker could not make the reel: the page says so, and a session looks at why (the note desk).
    if (typeof body?.failed === "string") {
      const changed = await setReelFailed(db, code);
      revalidatePath(`/${code}`);
      const why = body.failed.replace(/[\u0000-\u001f]+/g, " ").slice(0, 300);
      if (changed) await later(() => wakeNoteDesk(db, `the reel of ${code} failed on the reel host (${why}); find why, fix it, and start it again`));
      return NextResponse.json({ ok: true, failed: changed });
    }
    if (body?.progress && typeof body.progress === "object") {
      const p = body.progress as Record<string, unknown>;
      await setReelProgress(db, { code, pct: p.pct, minutesLeft: p.minutesLeft, step: p.step, waiting: p.waiting, host: p.host, upload: p.upload });
      revalidatePath(`/${code}`);
      return NextResponse.json({ ok: true, working: true });
    }
    // `noScore`: why a reel from the whole film has no score. `missing`: what the reel could not do, as codes; the match
    // page shows a row for each under the reel ("What this reel could not do").
    const res = await setMatchReel(db, { code, host: body?.host, token: body?.token, noScore: body?.noScore, missing: body?.missing });
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
