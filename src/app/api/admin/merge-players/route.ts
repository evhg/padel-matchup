import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { players } from "@/db/schema";
import { operatorAuthorized } from "@/lib/api/secret";
import { mergePlayers } from "@/lib/domain/merge";
import { safeToMerge } from "@/lib/domain/dupes";

export const dynamic = "force-dynamic";

/**
 * Folding duplicate people into one, from the operator's side.
 *
 *   POST /api/admin/merge-players { "into": "<uuid>", "from": ["<uuid>", …], "dryRun": true }
 *   Authorization: Bearer $CRON_SECRET
 *
 * Identity is a cookie here, so a name typed in a second browser, a private window, another phone or
 * an in-app browser makes a second person. Fifty-six rows hold about forty-eight people. The app can
 * already fold them — `verifyRestoreCode` does it whenever somebody proves an address — but only for
 * people who walk through that door themselves.
 *
 * This is the same `mergePlayers` the rest of the app uses, so nothing about how a merge works lives
 * in two places. What this adds is the rule in front of it: `safeToMerge` refuses a pair that two
 * different people could be. A wrong merge cannot be undone, and the two halves of somebody's padel
 * history are worth less than one stranger's history handed to somebody else.
 *
 * `dryRun` answers what would happen and changes nothing. Use it first, every time.
 */
export async function POST(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { into?: unknown; from?: unknown; dryRun?: unknown } | null;
  const into = typeof body?.into === "string" ? body.into : "";
  const from = Array.isArray(body?.from) ? body.from.filter((x): x is string => typeof x === "string") : [];
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!uuid.test(into) || from.length === 0 || !from.every((id) => uuid.test(id))) {
    return NextResponse.json({ error: "into and from must be player ids" }, { status: 400 });
  }
  const db = await getDb();
  const ids = [...new Set([into, ...from])];
  const rows = await db.select().from(players).where(inArray(players.id, ids));
  const target = rows.find((r) => r.id === into);
  if (!target) return NextResponse.json({ error: "into not found" }, { status: 404 });
  const sources = rows.filter((r) => r.id !== into);
  if (sources.length !== from.filter((id) => id !== into).length) return NextResponse.json({ error: "one of from not found" }, { status: 404 });

  const verdicts = sources.map((s) => ({ id: s.id, ...safeToMerge(target, s) }));
  const refused = verdicts.filter((v) => !v.ok);
  if (refused.length) return NextResponse.json({ error: "refused", verdicts }, { status: 409 });
  if (body?.dryRun) return NextResponse.json({ ok: true, dryRun: true, into, from: sources.map((s) => s.id), verdicts });

  await mergePlayers(db, into, sources.map((s) => s.id));
  const left = await db.select({ id: players.id }).from(players).where(eq(players.id, into));
  return NextResponse.json({ ok: true, into, merged: sources.length, survives: left.length === 1 });
}
