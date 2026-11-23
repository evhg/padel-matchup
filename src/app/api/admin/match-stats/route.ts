import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { DomainError } from "@/lib/domain/errors";
import { recordMatchStats } from "@/lib/domain/matchStats";

export const dynamic = "force-dynamic";

/**
 * The numbers of a filmed match, sent by the reel engine (`scripts/highlights/`). Bearer CRON_SECRET.
 *
 *   POST /api/admin/match-stats
 *   { "code": "AbCd", "stats": [
 *       { "player": "Ana", "kind": "fastestShot", "value": 84, "margin": 0.1 },
 *       { "player": "Ana", "partner": "Bo", "kind": "gamesInRow", "value": 8 } ] }
 *
 * `player` and `partner` are a player's id or the first name of somebody seated in that match. The kinds
 * and what a value may be are in `src/lib/domain/matchStatKinds.ts`. The answer says how many rows
 * were saved and which entries were refused, each with its reason: a number that is known to worse
 * than 10% (`bad_margin`), a heart rate of a player who switched off "Keep my heart rate" (`heart_off`), a name that no
 * seat or more than one seat has (`unknown_player`). A number that is sent again replaces the old one.
 */
export async function POST(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { code?: unknown; stats?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code) return NextResponse.json({ error: "code required" }, { status: 400 });
  try {
    const res = await recordMatchStats(await getDb(), { code, stats: body?.stats });
    if (res.saved > 0) revalidatePath(`/${code}`);
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    if (e instanceof DomainError && e.code === "not_found") return NextResponse.json({ error: "not_found", hint: "No match has this code. Codes are 4 characters and case-sensitive." }, { status: 404 });
    if (e instanceof DomainError && e.message === "not_played") return NextResponse.json({ error: "not_played", hint: "The match has not started yet, or it was called off." }, { status: 400 });
    if (e instanceof DomainError) return NextResponse.json({ error: e.code, hint: "stats: a list of 1 to 60 entries { player, partner?, kind, value, margin? }" }, { status: 400 });
    throw e;
  }
}
