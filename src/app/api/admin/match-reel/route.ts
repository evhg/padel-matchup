import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { DomainError } from "@/lib/domain/errors";
import { removeMatchReel, setMatchReel } from "@/lib/domain/matchReel";

export const dynamic = "force-dynamic";

/**
 * The reel of a filmed match is on the store: show it on the match page. Bearer CRON_SECRET.
 *
 *   POST   /api/admin/match-reel   { "code": "AB12", "host": "https://<the reel host>", "token": "<the reel's token>" }
 *   DELETE /api/admin/match-reel   { "code": "AB12" }
 *
 * The files are `{host}/r/{token}/tall.mp4` and `wide.mp4` (`scripts/highlights/modal/serve.py`). The
 * players of the match see the reel for 30 days. A second POST replaces the first. Nothing is announced
 * to anybody. The answer never repeats the token.
 */
export async function POST(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const code = typeof body?.code === "string" ? body.code : "";
  try {
    const res = await setMatchReel(await getDb(), { code, host: body?.host, token: body?.token });
    revalidatePath(`/${code}`);
    return NextResponse.json({ ok: true, replaced: res.replaced });
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
